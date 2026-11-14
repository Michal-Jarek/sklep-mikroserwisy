#!/usr/bin/env bash
# Purchase scenario (collection shop-purchase) in a container against the shop entrance, as the browser uses it.
#   bash postman/run.sh <environment> [--strict]      environment: compose or k8s
# Needs Docker and deploy/.env from deploy/create-secrets.sh, and
# - compose: the running stack (profile full-shop);
# - k8s: the shop namespace on the kubectl context rancher-desktop (deploy/k8s/README.md), kubectl and mkcert. The mkcert
#   CA (a public certificate) is mounted read-only for https://shop.localhost; Mailpit and Consul are reached through
#   kubectl port-forward on 18025 and 18500, started here and stopped on exit, also after Ctrl+C or kill.
# The admin password goes from deploy/.env to the container on stdin only: not in arguments, not in the container
# environment, not in a file, never printed. Exit code = code of runner/run.mjs: 0 passed, 1 failed, 2 setup error
# (a failure of docker run itself is 2 as well); 130/143 when the script itself is interrupted (INT/TERM).
set -euo pipefail
# Never traced (bash -x, SHELLOPTS=xtrace): the trace would print the admin password read below on stderr.
{ set +x; } 2>/dev/null

usage() {
  echo "usage: bash postman/run.sh <environment> [--strict]   (environment: compose or k8s)" >&2
  exit 2
}

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  usage
fi
env_name=$1
strict=0
if [ $# -eq 2 ]; then
  [ "$2" = "--strict" ] || usage
  strict=1
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

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found, install Docker (Rancher Desktop) first" >&2
  exit 2
fi

# SHOP_ENV_FILE only for tests of the error paths.
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

# k8s: Mailpit and Consul through port-forward (ports of decision 16 of stage 7, next to compose on 8025/8500).
# Consul = the server (Service consul-server): the Service consul is the proxy consul-guard, which answers 403 to
# the catalog queries of the scenario. An array, not a function: bash 3.2 (macOS) skips the TERM/INT trap when the
# signal arrives during a function call with redirections. Always the rancher-desktop context and the shop namespace.
KUBECTL=(kubectl --context rancher-desktop -n shop)
forwards="mailpit:18025:8025 consul-server:18500:8500"
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

# Cleanup on every exit: the port-forwards end with the script, the scenario container with a signal.
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
# INT/TERM: the signal goes on to the scenario (docker run passes it to the container, run.mjs ends without
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

mkdir -p "$dir/reports"
work=/opt/scenario/work
report="$(date -u +%Y%m%dT%H%M%SZ)-$env_name-$collection.json"
args=(
  "$work/runner/run.mjs"
  --collection "$work/collections/$collection.postman_collection.json"
  --environment "$work/environments/$env_name.postman_environment.json"
  --name "$env_name"
  --report "$work/reports/$report"
)
if [ "$strict" -eq 1 ]; then
  args+=(--strict)
fi
docker_args=(
  --rm -i --network host --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges
  -v "$dir/runner:$work/runner:ro"
  -v "$dir/collections:$work/collections:ro"
  -v "$dir/environments:$work/environments:ro"
  -v "$dir/reports:$work/reports"
)
if [ -n "$ca_file" ]; then
  docker_args+=(-v "$ca_file:/opt/scenario/ca/rootCA.pem:ro" -e NODE_EXTRA_CA_CERTS=/opt/scenario/ca/rootCA.pem)
fi

# printf is a bash builtin: the values never appear in the arguments of a process. In the background with "wait",
# so that INT/TERM run the trap at once (bash runs it only after a foreground command ends).
status=0
printf 'ADMIN_EMAIL=%s\nADMIN_PASSWORD=%s\n' "$admin_email" "$admin_password" |
  docker run "${docker_args[@]}" "$image" "${args[@]}" &
docker_pid=$!
wait "$docker_pid" || status=$?
docker_pid=""
# run.mjs ends with 0, 1 or 2; a higher code comes from docker (125-127: the container did not start).
if [ "$status" -gt 2 ]; then
  echo "docker run failed ($status)" >&2
  exit 2
fi
exit "$status"
