#!/usr/bin/env bash
# Purchase scenario (collection shop-purchase) in a container against the shop entrance, as the browser uses it.
#   bash postman/run.sh <environment> [--strict]      environment: compose (k8s comes in stage 7b)
# Needs Docker, the running stack (profile full-shop) and deploy/.env from deploy/create-secrets.sh.
# The admin password goes from deploy/.env to the container on stdin only: not in arguments, not in the container
# environment, not in a file, never printed. Exit code = code of runner/run.mjs: 0 passed, 1 failed, 2 setup error
# (a failure of docker run itself is 2 as well).
set -euo pipefail
# Never traced (bash -x, SHELLOPTS=xtrace): the trace would print the admin password read below on stderr.
{ set +x; } 2>/dev/null

usage() {
  echo "usage: bash postman/run.sh <environment> [--strict]   (environment: compose)" >&2
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
if [ "$env_name" != "compose" ]; then
  echo "environment $env_name is not available (k8s: stage 7b)" >&2
  exit 2
fi

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

if ! docker build -q -t "$image" "$dir" >/dev/null; then
  echo "building the image $image from $dir failed" >&2
  exit 2
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

# printf is a bash builtin: the values never appear in the arguments of a process.
status=0
printf 'ADMIN_EMAIL=%s\nADMIN_PASSWORD=%s\n' "$admin_email" "$admin_password" |
  docker run --rm -i --network host --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    -v "$dir/runner:$work/runner:ro" \
    -v "$dir/collections:$work/collections:ro" \
    -v "$dir/environments:$work/environments:ro" \
    -v "$dir/reports:$work/reports" \
    "$image" "${args[@]}" || status=$?
# run.mjs ends with 0, 1 or 2; a higher code comes from docker (125-127: the container did not start).
if [ "$status" -gt 2 ]; then
  echo "docker run failed ($status)" >&2
  exit 2
fi
exit "$status"
