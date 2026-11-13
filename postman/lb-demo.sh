#!/usr/bin/env bash
# Load balancing demo: scales product-service in the running "sklep" compose stack (profile full-shop),
# sends 9 requests through the shop entrance and shows which instance answered each one.
# The original number of product-service replicas is restored on exit, also after Ctrl+C; restoring itself
# cannot be interrupted.
#
#   bash postman/lb-demo.sh [replicas]      # default 3, allowed 2-5
#
# Exit codes: 0 - every replica answered with 200, 1 - otherwise (or the stack could not be restored),
# 2 - wrong argument, docker/curl missing, the shop entrance does not answer or product-service is not running.
# 130/143 - interrupted (INT/TERM), replicas restored.
# Needs only bash, curl and docker (no jq).

set -u

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
COMPOSE_FILE="$SCRIPT_DIR/../deploy/compose.yaml"
SHOP_URL=http://127.0.0.1:8090/api/v1
CONSUL_URL=http://127.0.0.1:8500
PRODUCT_ID=a0000000-0000-4000-8000-000000000010
REQUESTS=9

usage() {
  echo "usage: bash postman/lb-demo.sh [replicas]   (replicas: 2-5, default 3)" >&2
  exit 2
}

[ $# -le 1 ] || usage
replicas=${1:-3}
case "$replicas" in
  [2-5]) ;;
  *) usage ;;
esac

for tool in docker curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is not installed" >&2
    exit 2
  fi
done

# An array, not a function: bash 3.2 (macOS) skips the TERM/INT trap when the signal arrives during a
# function call with redirections (dc ... >/dev/null), and the script would end without restoring the stack.
DC=(docker compose -p sklep -f "$COMPOSE_FILE" --profile full-shop)

# Prints the value of a response header (case-insensitive name) from a header dump on stdin.
header_value() {
  local name line
  name=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  while IFS= read -r line; do
    line=${line%$'\r'}
    case "$(printf '%s' "${line%%:*}" | tr '[:upper:]' '[:lower:]')" in
      "$name")
        line=${line#*:}
        echo "${line# }"
        return
        ;;
    esac
  done
}

# Number of product-service instances with all checks passing ("ServiceID":"" is serfHealth, not counted).
passing_count() {
  curl -s --max-time 5 "$CONSUL_URL/v1/health/service/product-service?passing=true" \
    | grep -o '"ServiceID":"product-service-' | wc -l | tr -d ' '
}

# wait_passing <n>: waits up to 30 s until Consul shows exactly <n> passing instances.
wait_passing() {
  local i count
  for i in $(seq 1 30); do
    count=$(passing_count)
    [ "$count" = "$1" ] && return 0
    sleep 1
  done
  echo "consul shows $count passing product-service instance(s) after 30 s, expected $1" >&2
  return 1
}

# Step 1: the shop entrance must answer from the API Gateway (401 without a token, no service is called).
if ! curl -s -o /dev/null -D - --max-time 5 "$SHOP_URL/cart" | header_value X-Gateway-Instance-Id | grep -q .; then
  echo "shop entrance $SHOP_URL is not reachable (no answer from the API Gateway)" >&2
  exit 2
fi

original=$("${DC[@]}" ps product-service --format '{{.Name}}' | grep -c .)
# With 0 replicas the final "--scale product-service=0" would remove the stopped containers.
if [ "$original" -lt 1 ]; then
  echo "product-service is not running, start the stack first" >&2
  exit 2
fi
scaled=0
restored=0
signal_rc=""

# note_signal <code>: remembers the first INT/TERM; the exit code is used once the replicas are restored.
note_signal() {
  [ -z "$signal_rc" ] || return 0
  signal_rc=$1
  echo "interrupted, restoring replicas" >&2
}

# Brings back the remembered number of replicas once; returns 1 when that failed.
# Restoring cannot be interrupted: compose runs in its own process group (set -m), so Ctrl+C (SIGINT to the
# foreground process group) does not reach it - compose would stop on SIGINT even when the signal is ignored,
# because Go re-enables it. INT/TERM meanwhile are only remembered (note_signal) and interrupt just "wait".
restore() {
  local pid rc
  [ "$scaled" = 1 ] && [ "$restored" = 0 ] || return 0
  trap 'note_signal 130' INT
  trap 'note_signal 143' TERM
  restored=1
  echo "restoring $original product-service replica(s)"
  set -m
  "${DC[@]}" up -d --no-deps --no-recreate --scale "product-service=$original" --wait --wait-timeout 120 product-service </dev/null >/dev/null 2>&1 &
  pid=$!
  set +m
  wait "$pid"
  rc=$?
  # Status > 128: "wait" was interrupted by a signal, compose is still running (or its status is kept).
  while [ "$rc" -gt 128 ]; do
    wait "$pid"
    rc=$?
  done
  if [ "$rc" = 0 ] && wait_passing "$original"; then
    return 0
  fi
  echo "could not restore product-service, run: docker compose -p sklep -f deploy/compose.yaml --profile full-shop up -d --no-deps --no-recreate --scale product-service=$original --wait product-service" >&2
  return 1
}

# Exit after a signal: 130/143 once the replicas are restored, 1 when restoring failed.
exit_interrupted() {
  trap - EXIT
  [ "$1" = 0 ] || exit 1
  exit "$signal_rc"
}

on_signal() {
  note_signal "$1"
  restore
  exit_interrupted $?
}

on_exit() {
  local rc=$?
  restore || rc=1
  [ -z "$signal_rc" ] || exit_interrupted "$rc"
  exit "$rc"
}

trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap on_exit EXIT

# Step 2: scale product-service without touching any other service.
echo "scaling product-service from $original to $replicas replica(s)"
scaled=1
if ! "${DC[@]}" up -d --no-deps --no-recreate --scale "product-service=$replicas" --wait --wait-timeout 120 product-service >/dev/null; then
  echo "could not scale product-service to $replicas replicas" >&2
  exit 1
fi

# Step 3: Consul must list every replica, then the API Gateway refreshes its instance cache (10 s).
echo "waiting for $replicas passing instances in Consul"
wait_passing "$replicas"
echo "waiting 11 s for the API Gateway instance cache"
sleep 11

# Step 4: requests through the shop entrance.
printf '%-8s %-6s %-40s %s\n' request status X-Instance-Id X-Gateway-Instance-Id
instances=""
not_ok=0
for i in $(seq 1 "$REQUESTS"); do
  headers=$(curl -s -o /dev/null -D - --max-time 10 "$SHOP_URL/products/$PRODUCT_ID")
  status=$(printf '%s\n' "$headers" | head -1 | cut -d' ' -f2)
  instance=$(printf '%s\n' "$headers" | header_value X-Instance-Id)
  gateway=$(printf '%s\n' "$headers" | header_value X-Gateway-Instance-Id)
  printf '%-8s %-6s %-40s %s\n' "$i" "${status:-000}" "${instance:--}" "${gateway:--}"
  # Only 200 counts: an instance answering 500 must not make the demo pass.
  if [ "$status" = 200 ]; then
    [ -n "$instance" ] && instances="$instances$instance"$'\n'
  else
    not_ok=$((not_ok + 1))
  fi
done

# Step 5: summary and result.
counts=$(printf '%s' "$instances" | sort | uniq -c)
distinct=$(printf '%s' "$instances" | sort -u | grep -c .)
summary="summary: $distinct instances:"
min_per_instance=1
[ "$replicas" = 3 ] && min_per_instance=2
result=PASSED
[ "$distinct" = "$replicas" ] || result=FAILED
[ "$not_ok" = 0 ] || result=FAILED
while read -r count id; do
  [ -n "$id" ] || continue
  summary="$summary $id=$count"
  [ "$count" -ge "$min_per_instance" ] || result=FAILED
done <<< "$counts"
echo "$summary"
[ "$not_ok" = 0 ] || echo "requests without status 200: $not_ok"

restore_rc=0
restore || { restore_rc=1; result=FAILED; }
# A signal during the final restore: exit 130/143 (1 when restoring failed) without the RESULT line.
[ -z "$signal_rc" ] || exit_interrupted "$restore_rc"
echo "RESULT: $result"
[ "$result" = PASSED ]
