#!/usr/bin/env bash
# Tests of the runner without the shop (postman/README.md, "Testy runnera"):
#   bash postman/test.sh            unit tests and static tests of the collections (node --test) in the image
#                                   shop-scenario:dev, no network; the collections are mounted read-only
#   bash postman/test.sh --types    type check of the runner (tsc --noEmit) in a clean node container with npm ci
#                                   (needs the npm registry; node_modules stays in the container)
# Only for tests of the static rules: SHOP_SERVICES_DIR = a copy of services/ with <service>/postman/ folders.
# Exit code: the one of node --test / tsc; 2 when Docker or the image build fails.
set -euo pipefail

dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(dirname "$dir")
services_dir=${SHOP_SERVICES_DIR:-$repo/services}
image=shop-scenario:dev
node_image=node:22.23-alpine

if [ $# -gt 1 ] || { [ $# -eq 1 ] && [ "$1" != --types ]; }; then
  echo "usage: bash postman/test.sh [--types]" >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found, install Docker (Rancher Desktop) first" >&2
  exit 2
fi

if [ $# -eq 1 ]; then
  # A copy without node_modules and reports, then the dev dependencies from the lockfile (.npmrc included).
  exec docker run --rm -v "$dir:/src:ro" "$node_image" sh -c \
    'mkdir /w && cd /src && tar --exclude=node_modules --exclude=reports -cf - . | tar -xf - -C /w &&
     cd /w && npm ci --no-audit --no-fund >/dev/null && npx tsc --noEmit -p . && echo "tsc --noEmit: no errors"'
fi

if ! docker build -q -t "$image" "$dir" >/dev/null; then
  echo "building the image $image from $dir failed" >&2
  exit 2
fi
mounts=()
for postman_dir in "$services_dir"/*/postman; do
  if [ -d "$postman_dir" ]; then
    mounts+=(-v "$postman_dir:/opt/scenario/services/$(basename "$(dirname "$postman_dir")")/postman:ro")
  fi
done
work=/opt/scenario/work
exec docker run --rm --network none --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  -v "$dir/runner:$work/runner:ro" -v "$dir/collections:$work/collections:ro" -v "$dir/environments:$work/environments:ro" \
  ${mounts[@]+"${mounts[@]}"} --entrypoint sh "$image" -c "node --test $work/runner/*.test.ts"
