#!/usr/bin/env bash
# Runs newman in a container against the shop (postman/README.md):
#   bash postman/run.sh <environment> [--strict]     purchase scenario (collection shop-purchase) through the entrance
#   bash postman/run.sh <environment> --services     the 10 service collections (section "Kolekcje usług")
#   environment: compose or k8s
# Needs Docker and deploy/.env from deploy/create-secrets.sh, and
# - compose: the running stack (profile full-shop);
# - k8s: the shop namespace on the kubectl context rancher-desktop (deploy/k8s/README.md), kubectl and mkcert. The mkcert
#   CA (a public certificate) is mounted read-only for https://shop.localhost; Mailpit (and Consul for the scenario) are
#   reached through kubectl port-forward on 18025 (and 18500), started here and stopped on exit, also after Ctrl+C or kill.
# --services: compose runs the phase direct (folder "direct", container in the network sklep_backend) and then the
# phase gateway (folder "start" once, then "via Gateway" of every collection, network host); k8s runs the phase
# gateway only. HTML reports go to docs/raport/newman/ (scanned for secrets first, runner/html.ts).
# Secrets (admin password, RabbitMQ password) go from deploy/.env to the container on stdin only: not in arguments,
# not in the container environment, not in a file, never printed; each container gets only the ones it needs.
# Exit code: 0 passed, 1 failed, 2 setup error (a failure of docker run itself is 2 as well); with --services the
# worse code of the two phases; 130/143 when the script itself is interrupted (INT/TERM).
# Only for tests of this script: SHOP_ENV_FILE (instead of deploy/.env), SHOP_SERVICES_DIR (instead of services/,
# with <service>/postman/<service>.postman_collection.json), SHOP_BACKEND_NETWORK (instead of sklep_backend),
# SHOP_TEST_SECRET (--services: a fake secret sent on stdin as TEST_SECRET, scanned like the real ones; never a real one).
set -euo pipefail
# Never traced (bash -x, SHELLOPTS=xtrace): the trace would print the passwords read below on stderr.
{ set +x; } 2>/dev/null

usage() {
  echo "usage: bash postman/run.sh <environment> [--strict | --services]   (environment: compose or k8s)" >&2
  exit 2
}

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  usage
fi
env_name=$1
mode=scenario
strict=0
if [ $# -eq 2 ]; then
  case "$2" in
    --strict) strict=1 ;;
    --services) mode=services ;;
    *) usage ;;
  esac
fi
case "$env_name" in
  compose | k8s) ;;
  *)
    echo "environment $env_name is not available (available: compose, k8s)" >&2
    exit 2
    ;;
esac

dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(dirname "$dir")
image=shop-scenario:dev
collection=shop-purchase
html_dir="$repo/docs/raport/newman"
services_dir=${SHOP_SERVICES_DIR:-$repo/services}
network=${SHOP_BACKEND_NETWORK:-sklep_backend}

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found, install Docker (Rancher Desktop) first" >&2
  exit 2
fi

env_file=${SHOP_ENV_FILE:-$repo/deploy/.env}
if [ ! -f "$env_file" ]; then
  echo "env file $env_file not found, run deploy/create-secrets.sh" >&2
  exit 2
fi
# Read as text (no source): the last KEY=value line, as docker compose does. CR (a file saved with CRLF) and one pair
# of quotes around the value are removed; a comment or text after the value is not supported. The value is never printed.
read_env() {
  local value
  value=$(sed -n "s/^$1=//p" "$env_file" | tail -n 1 | tr -d '\r')
  case $value in
    \"*\" | \'*\')
      value=${value:1:${#value}-2}
      ;;
    \"* | \'* | *[[:space:]]\#*)
      echo "unsupported .env syntax for $1 in $env_file (text after the value or an unclosed quote), write it as $1=<value>" >&2
      return 2
      ;;
  esac
  printf '%s\n' "$value"
}
admin_password=$(read_env ADMIN_PASSWORD) || exit 2
if [ -z "$admin_password" ]; then
  echo "ADMIN_PASSWORD is missing in $env_file, run deploy/create-secrets.sh" >&2
  exit 2
fi
admin_email=$(read_env ADMIN_EMAIL) || exit 2
admin_email=${admin_email:-admin@sklep.local}

# Phases of the run: scenario, or direct (compose only) and gateway for --services.
phases=scenario
rabbitmq_password=""
if [ "$mode" = services ]; then
  phases=gateway
  if [ "$env_name" = compose ]; then
    phases="direct gateway"
    rabbitmq_password=$(read_env RABBITMQ_ADMIN_PASSWORD) || exit 2
    if [ -z "$rabbitmq_password" ]; then
      echo "RABBITMQ_ADMIN_PASSWORD is missing in $env_file, run deploy/create-secrets.sh" >&2
      exit 2
    fi
    if ! docker network inspect "$network" >/dev/null 2>&1; then
      echo "docker network $network not found, start the stack: docker compose -f deploy/compose.yaml --profile full-shop up -d --wait" >&2
      exit 2
    fi
  fi
  # Only the postman/ folder of each service is mounted (read-only), nothing else of the services.
  service_mounts=()
  for postman_dir in "$services_dir"/*/postman; do
    if [ -d "$postman_dir" ]; then
      service=$(basename "$(dirname "$postman_dir")")
      service_mounts+=(-v "$postman_dir:/opt/scenario/services/$service/postman:ro")
    fi
  done
  if [ ${#service_mounts[@]} -eq 0 ]; then
    echo "no service collections found in $services_dir/<service>/postman" >&2
    exit 2
  fi
fi

# k8s: Mailpit (and Consul for the scenario) through port-forward (ports of decision 16 of stage 7, next to compose
# on 8025/8500). Consul = the server (Service consul-server): the Service consul is the proxy consul-guard, which
# answers 403 to the catalog queries of the scenario. An array, not a function: bash 3.2 (macOS) skips the TERM/INT
# trap when the signal arrives during a function call with redirections. Always the rancher-desktop context and the
# shop namespace.
KUBECTL=(kubectl --context rancher-desktop -n shop)
forwards="mailpit:18025:8025 consul-server:18500:8500"
if [ "$mode" = services ]; then
  forwards="mailpit:18025:8025"
fi
ca_file=""
if [ "$env_name" = k8s ]; then
  if ! command -v kubectl >/dev/null 2>&1; then
    echo "kubectl not found, install Rancher Desktop with Kubernetes first (deploy/k8s/README.md)" >&2
    exit 2
  fi
  if ! kubectl config get-contexts rancher-desktop >/dev/null 2>&1; then
    echo "kubectl context rancher-desktop not found, enable Kubernetes in Rancher Desktop (deploy/k8s/README.md)" >&2
    exit 2
  fi
  if ! command -v mkcert >/dev/null 2>&1; then
    echo "mkcert not found, install it and run mkcert -install (deploy/k8s/README.md)" >&2
    exit 2
  fi
  ca_file="$(mkcert -CAROOT 2>/dev/null || true)/rootCA.pem"
  if [ ! -f "$ca_file" ]; then
    echo "mkcert CA certificate $ca_file not found, run mkcert -install (deploy/k8s/README.md)" >&2
    exit 2
  fi
  for forward in $forwards; do
    port=${forward#*:}
    port=${port%%:*}
    # A connection that succeeds = something already listens there (e.g. a port-forward from an earlier run).
    if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      echo "port $port on 127.0.0.1 is already in use (another kubectl port-forward? see: pgrep -fl port-forward), free it and run again" >&2
      exit 2
    fi
  done
fi

if ! docker build -q -t "$image" "$dir" >/dev/null; then
  echo "building the image $image from $dir failed" >&2
  exit 2
fi

# Cleanup on every exit: the port-forwards end with the script, the runner container with a signal.
forward_pids=""
docker_pid=""
tmp=""
# shellcheck disable=SC2317  # called from the EXIT trap
cleanup() {
  local pid
  for pid in $forward_pids; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in $forward_pids; do
    wait "$pid" 2>/dev/null || true
  done
  forward_pids=""
  if [ -n "$tmp" ]; then
    rm -rf "$tmp"
  fi
}
# INT/TERM: the signal goes on to the runner (docker run passes it to the container, the runner ends without
# a report), then the script ends with 130/143 and the EXIT trap stops the port-forwards.
# shellcheck disable=SC2317  # called from the INT/TERM traps
on_signal() {
  trap '' INT TERM
  if [ -n "$docker_pid" ]; then
    kill -TERM "$docker_pid" 2>/dev/null || true
    wait "$docker_pid" 2>/dev/null || true
  fi
  exit "$1"
}
trap cleanup EXIT
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

if [ "$env_name" = k8s ]; then
  tmp=$(mktemp -d)
  for forward in $forwards; do
    service=${forward%%:*}
    ports=${forward#*:}
    "${KUBECTL[@]}" port-forward "svc/$service" "$ports" >"$tmp/$service.log" 2>&1 &
    forward_pids="$forward_pids $!"
    echo "$!" >"$tmp/$service.pid"
  done
  # Ready = kubectl printed "Forwarding from 127.0.0.1:<port>" (no test connection: it would go to the pod).
  # kubectl that already ended (e.g. no such service) never gets ready: stop at once, not after 15 s.
  for forward in $forwards; do
    service=${forward%%:*}
    port=${forward#*:}
    port=${port%%:*}
    pid=$(cat "$tmp/$service.pid")
    waited=0
    until grep -q "Forwarding from 127.0.0.1:$port " "$tmp/$service.log"; do
      if [ "$waited" -ge 75 ] || ! kill -0 "$pid" 2>/dev/null; then
        echo "port-forward of svc/$service to 127.0.0.1:$port failed: $(tail -n 1 "$tmp/$service.log")" >&2
        exit 2
      fi
      sleep 0.2
      waited=$((waited + 1))
    done
  done
fi

mkdir -p "$dir/reports" "$html_dir"
work=/opt/scenario/work
base_args=(
  --rm -i --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges
  -v "$dir/runner:$work/runner:ro"
  -v "$dir/environments:$work/environments:ro"
  -v "$html_dir:$work/html"
)

# The fake secret of the tests (SHOP_TEST_SECRET) as one more stdin line; nothing without it.
test_secret_line() {
  if [ -n "${SHOP_TEST_SECRET:-}" ]; then
    printf 'TEST_SECRET=%s\n' "$SHOP_TEST_SECRET"
  fi
}

# One container per phase, each with its own stdin. printf is a bash builtin: the values never appear in the
# arguments of a process. In the background with "wait", so that INT/TERM run the trap at once (bash runs it only
# after a foreground command ends).
final=0
codes=""
for phase in $phases; do
  docker_args=("${base_args[@]}")
  case "$phase" in
    scenario)
      report="$(date -u +%Y%m%dT%H%M%SZ)-$env_name-$collection.json"
      docker_args+=(--network host -v "$dir/collections:$work/collections:ro" -v "$dir/reports:$work/reports")
      args=(
        "$work/runner/run.ts"
        --collection "$work/collections/$collection.postman_collection.json"
        --environment "$work/environments/$env_name.postman_environment.json"
        --name "$env_name"
        --report "$work/reports/$report"
        --html "$work/html/$env_name-scenario.html"
      )
      if [ "$strict" -eq 1 ]; then
        args+=(--strict)
      fi
      ;;
    direct)
      docker_args+=(--network "$network" "${service_mounts[@]}")
      args=(
        "$work/runner/services.ts" --phase direct --env "$env_name"
        --environment "$work/environments/compose-direct.postman_environment.json"
        --services-dir /opt/scenario/services --html-dir "$work/html"
      )
      ;;
    gateway)
      docker_args+=(--network host "${service_mounts[@]}")
      args=(
        "$work/runner/services.ts" --phase gateway --env "$env_name"
        --environment "$work/environments/$env_name.postman_environment.json"
        --services-dir /opt/scenario/services --html-dir "$work/html"
      )
      ;;
  esac
  if [ -n "$ca_file" ]; then
    docker_args+=(-v "$ca_file:/opt/scenario/ca/rootCA.pem:ro" -e NODE_EXTRA_CA_CERTS=/opt/scenario/ca/rootCA.pem)
  fi

  status=0
  if [ "$phase" = direct ]; then
    { printf 'RABBITMQ_ADMIN_PASSWORD=%s\n' "$rabbitmq_password"; test_secret_line; } |
      docker run "${docker_args[@]}" "$image" "${args[@]}" &
  elif [ "$phase" = gateway ]; then
    { printf 'ADMIN_EMAIL=%s\nADMIN_PASSWORD=%s\n' "$admin_email" "$admin_password"; test_secret_line; } |
      docker run "${docker_args[@]}" "$image" "${args[@]}" &
  else
    printf 'ADMIN_EMAIL=%s\nADMIN_PASSWORD=%s\n' "$admin_email" "$admin_password" |
      docker run "${docker_args[@]}" "$image" "${args[@]}" &
  fi
  docker_pid=$!
  wait "$docker_pid" || status=$?
  docker_pid=""
  # The runner ends with 0, 1 or 2; a higher code comes from docker (125-127: the container did not start).
  if [ "$status" -gt 2 ]; then
    echo "docker run failed ($status)" >&2
    exit 2
  fi
  codes="$codes $phase $status,"
  if [ "$status" -eq 2 ] || { [ "$status" -eq 1 ] && [ "$final" -eq 0 ]; }; then
    final=$status
  fi
done

if [ "$mode" = services ]; then
  case "$final" in
    0) result=PASSED ;;
    1) result=FAILED ;;
    *) result="SETUP ERROR" ;;
  esac
  codes=${codes%,}
  echo "RESULT: $result — $env_name --services, exit codes:$codes"
fi
exit "$final"
