#!/usr/bin/env bash
# Resilience demo on the running "sklep" compose stack (profile full-shop), collection shop-resilience:
#   STEP 1/3  review-service stopped  -> the product page is served without a rating      [R1]
#   STEP 2/3  product-service stopped -> adding to the cart answers 503 SERVICE_UNAVAILABLE [R2]
#   STEP 3/3  product-service started -> the product page answers 200 again within 30 s     [R3]
# Only services that were running before the demo are stopped, and they are started again on exit with their
# previous number of containers, also after Ctrl+C; restoring itself cannot be interrupted.
#
#   bash postman/resilience-demo.sh
#
# Exit codes: 0 - all 3 steps passed, 1 - otherwise (or a service could not be restored),
# 2 - docker/curl missing, the image build failed or the shop entrance does not answer.
# 130/143 - interrupted (INT/TERM), services restored.

set -u

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
COMPOSE_FILE="$SCRIPT_DIR/../deploy/compose.yaml"
SHOP_URL=http://127.0.0.1:8090/api/v1
IMAGE=shop-scenario:dev
WORK=/opt/scenario/work
RUNNER="shop-resilience-$$"

if [ $# -ne 0 ]; then
  echo "usage: bash postman/resilience-demo.sh" >&2
  exit 2
fi

for tool in docker curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is not installed" >&2
    exit 2
  fi
done

# An array, not a function: bash 3.2 (macOS) skips the TERM/INT trap when the signal arrives during a
# function call with redirections (dc ... >/dev/null), and the script would end without restoring the stack.
DC=(docker compose -p sklep -f "$COMPOSE_FILE" --profile full-shop)

# Step 0: the shop entrance must answer from the API Gateway (401 without a token, no service is called).
if ! curl -s -o /dev/null -D - --max-time 5 "$SHOP_URL/cart" | grep -qi '^x-gateway-instance-id:'; then
  echo "shop entrance $SHOP_URL is not reachable (no answer from the API Gateway)" >&2
  exit 2
fi

if ! docker build -q -t "$IMAGE" "$SCRIPT_DIR" >/dev/null; then
  echo "could not build the image $IMAGE from postman/Dockerfile" >&2
  exit 2
fi

mkdir -p "$SCRIPT_DIR/reports"

# Services stopped by this script as "<name>=<containers>"; each one is started again (without its dependencies)
# with the same number of containers on exit.
touched=""
signal_rc=""

# note_signal <code>: remembers the first INT/TERM; the exit code is used once the services are restored.
note_signal() {
  [ -z "$signal_rc" ] || return 0
  signal_rc=$1
  echo "interrupted, restoring services" >&2
}

# start_service <name> <containers>: starts the stopped containers without dependencies and waits until they are
# healthy. "compose start" would also re-run the one-off dependencies (consul-kv-seed, product-migrate).
# compose runs in its own process group (set -m), so Ctrl+C (SIGINT to the foreground process group) does not
# reach it - compose would stop on SIGINT even when the signal is ignored, because Go re-enables it.
start_service() {
  local pid rc
  echo "starting $1 and waiting until it is healthy"
  set -m
  "${DC[@]}" up -d --no-deps --no-recreate --scale "$1=$2" --wait --wait-timeout 120 "$1" </dev/null >/dev/null 2>&1 &
  pid=$!
  set +m
  wait "$pid"
  rc=$?
  # Status > 128: "wait" was interrupted by a signal, compose is still running (or its status is kept).
  while [ "$rc" -gt 128 ]; do
    wait "$pid"
    rc=$?
  done
  [ "$rc" = 0 ] && return 0
  echo "could not start $1, run: docker compose -p sklep -f deploy/compose.yaml --profile full-shop up -d --no-deps --no-recreate --scale $1=$2 --wait $1" >&2
  return 1
}

# stop_service <name> <containers>: stops a service that runs <containers> containers (counted before the step);
# a service that was not running before the demo stays stopped and is not started on exit.
stop_service() {
  if [ "$2" -lt 1 ]; then
    echo "$1 is not running, it stays stopped"
    return 0
  fi
  touched="$touched $1=$2"
  echo "stopping $1"
  "${DC[@]}" stop "$1" >/dev/null 2>&1
}

# running <name>: number of running containers of the service.
running() {
  "${DC[@]}" ps -q "$1" | grep -c .
}

# Starts every service this script stopped; returns 1 when any of them is not healthy. Restoring cannot be
# interrupted: INT/TERM meanwhile are only remembered, and afterwards the script exits with 130/143.
restore() {
  local entry rc=0
  trap 'note_signal 130' INT
  trap 'note_signal 143' TERM
  for entry in $touched; do
    start_service "${entry%%=*}" "${entry#*=}" || rc=1
  done
  touched=""
  if [ -n "$signal_rc" ]; then
    trap - EXIT
    [ "$rc" = 0 ] || exit 1
    exit "$signal_rc"
  fi
  trap 'on_signal 130' INT
  trap 'on_signal 143' TERM
  return "$rc"
}

on_signal() {
  trap 'note_signal 130' INT
  trap 'note_signal 143' TERM
  note_signal "$1"
  docker rm -f "$RUNNER" >/dev/null 2>&1
  restore
}

on_exit() {
  local rc=$?
  restore || rc=1
  exit "$rc"
}

trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap on_exit EXIT

# run_folder <folder>: runs one folder of shop-resilience in the scenario image (empty stdin: no admin data).
run_folder() {
  local report
  report="$(date -u +%Y%m%dT%H%M%SZ)-compose-shop-resilience.json"
  # Two folders can finish within one second: the report name must not repeat.
  while [ -e "$SCRIPT_DIR/reports/$report" ]; do
    sleep 1
    report="$(date -u +%Y%m%dT%H%M%SZ)-compose-shop-resilience.json"
  done
  docker run --rm --name "$RUNNER" --network host --read-only --tmpfs /tmp --cap-drop ALL \
    --security-opt no-new-privileges \
    -v "$SCRIPT_DIR/runner:$WORK/runner:ro" \
    -v "$SCRIPT_DIR/collections:$WORK/collections:ro" \
    -v "$SCRIPT_DIR/environments:$WORK/environments:ro" \
    -v "$SCRIPT_DIR/reports:$WORK/reports" \
    "$IMAGE" "$WORK/runner/run.mjs" \
    --collection "$WORK/collections/shop-resilience.postman_collection.json" \
    --environment "$WORK/environments/compose.postman_environment.json" \
    --name compose --report "$WORK/reports/$report" --folder "$1"
}

passed=0

echo "STEP 1/3: review-service stopped - the product page is served without a rating"
stop_service review-service "$(running review-service)"
run_folder "review down"
ok=$?
restore || ok=1
[ "$ok" = 0 ] && passed=$((passed + 1))

echo "STEP 2/3: product-service stopped - adding to the cart answers 503"
product_replicas=$(running product-service)
stop_service product-service "$product_replicas"
run_folder "product down" && passed=$((passed + 1))
# Without --wait: [R3] measures the whole way back (start and the instance cache of the API Gateway); restore waits
# for healthy after the folder.
if [ "$product_replicas" -ge 1 ]; then
  echo "starting product-service"
  "${DC[@]}" up -d --no-deps --no-recreate --scale "product-service=$product_replicas" product-service >/dev/null 2>&1
fi

echo "STEP 3/3: product-service started - the product page answers again"
run_folder "recovered"
ok=$?
restore || ok=1
[ "$ok" = 0 ] && passed=$((passed + 1))

result=PASSED
[ "$passed" = 3 ] || result=FAILED
echo "RESULT: $result — steps $passed/3"
[ "$result" = PASSED ]
