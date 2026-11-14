#!/usr/bin/env bash
# Starts the shop in local Kubernetes (Rancher Desktop): always context rancher-desktop, namespace shop.
#   bash deploy/k8s/up.sh [infra|platform|services|all] [--build]          (default: all)
# Order: namespace -> Secrets (secrets.sh) -> ConfigMaps from files in deploy/ -> network/ -> layer(s).
# all = infra -> platform -> services. A layer is the directory deploy/k8s/<layer>/: one component per *.yaml,
# a Job always alone in its own file. infra: workloads, wait for Ready, then the Jobs; platform and services:
# the Jobs (migrations) first, then the workloads. A Job is deleted and created again on every run (a Job
# cannot be changed) and the script waits for Complete right away (it is removed 10 minutes after it ends).
# Waiting is limited to 5 minutes per layer.
# --build: rebuilds the :dev images first (docker compose, profile full-shop, Docker context rancher-desktop) and
# restarts the Deployments and StatefulSets of the started layer(s) that use them, after the migration Jobs of the
# layer (imagePullPolicy Never: pods do not pick up a new image by themselves).
# Exit codes: 0 OK, 1 error, 2 wrong usage, no kubectl, no context rancher-desktop (kubectl, or Docker with --build)
# or the cluster does not answer.
set -euo pipefail

CONTEXT=rancher-desktop
NAMESPACE=shop
LAYER_TIMEOUT=300
# 7.5 GiB: the shop, Playwright and image builds next to k3s (deploy/k8s/README.md).
MIN_MEMORY=8053063680

dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$dir/../.." && pwd)

usage() {
  echo "usage: bash deploy/k8s/up.sh [infra|platform|services|all] [--build]" >&2
  exit 2
}

target=""
build=0
for arg in "$@"; do
  case $arg in
    infra | platform | services | all)
      [ -z "$target" ] || usage
      target=$arg
      ;;
    --build) build=1 ;;
    *) usage ;;
  esac
done
target=${target:-all}

k() { kubectl --context "$CONTEXT" -n "$NAMESPACE" "$@"; }

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl not found: install Rancher Desktop (Kubernetes enabled)" >&2
  exit 2
fi
if ! kubectl config get-contexts "$CONTEXT" >/dev/null 2>&1; then
  echo "kubectl context $CONTEXT not found: start Rancher Desktop with Kubernetes enabled" >&2
  exit 2
fi
if ! k get --raw /readyz --request-timeout=5s >/dev/null 2>&1; then
  echo "the cluster of context $CONTEXT does not answer: start Rancher Desktop and wait for Kubernetes" >&2
  exit 2
fi
# Docker of Rancher Desktop (k3s takes the :dev images from it), not the current Docker context.
memory=$(docker --context "$CONTEXT" info --format '{{.MemTotal}}' 2>/dev/null || echo 0)
if [ "$memory" -eq 0 ]; then
  echo "warning: docker info failed, the memory of the Rancher Desktop VM was not checked" >&2
elif [ "$memory" -lt "$MIN_MEMORY" ]; then
  echo "warning: the Rancher Desktop VM has $((memory / 1048576)) MiB, at least 7.5 GiB recommended" \
    "(Preferences > Virtual Machine)" >&2
fi

if [ "$build" -eq 1 ]; then
  if ! docker context inspect "$CONTEXT" >/dev/null 2>&1; then
    echo "docker context $CONTEXT not found: start Rancher Desktop (Container Engine dockerd (moby))" >&2
    exit 2
  fi
  echo "== build: :dev images (docker compose, profile full-shop)"
  docker --context "$CONTEXT" compose -p sklep -f "$repo/deploy/compose.yaml" --profile full-shop build
fi

echo "== namespace"
k apply -f "$dir/namespace.yaml"

echo "== secrets"
bash "$dir/secrets.sh"

# ConfigMaps from files in the repo: key = file name (deploy/k8s/README.md). The manifests mount them by name.
echo "== configmaps"
apply_configmap() {
  local name=$1
  shift
  k create configmap "$name" "$@" --dry-run=client -o yaml | k apply -f -
}
apply_configmap consul-kv --from-file="$repo/deploy/consul/config" --from-file="$repo/deploy/consul/seed-kv.sh"
apply_configmap consul-acl-setup --from-file="$dir/infra/consul-acl-setup.sh"
# Read by consul-0 at start: a change applies after kubectl rollout restart statefulset/consul (README).
apply_configmap consul-server-config --from-file="$dir/infra/consul-server.hcl"
# consul-guard reads its script only at start: a changed script restarts the running pods (2 replicas, PDB).
guard_configmap=$(apply_configmap consul-guard --from-file="$dir/infra/consul-guard.py")
echo "$guard_configmap"
if [ "$guard_configmap" = "configmap/consul-guard configured" ] && k get deployment consul-guard >/dev/null 2>&1; then
  k rollout restart deployment/consul-guard
fi
apply_configmap postgres-init --from-file="$repo/deploy/postgres/init"
apply_configmap mongo-init --from-file="$repo/deploy/mongo/init"
apply_configmap rabbitmq-setup --from-file="$repo/deploy/rabbitmq/definitions.json" \
  --from-file="$repo/deploy/rabbitmq/setup.sh"

if compgen -G "$dir/network/*.yaml" >/dev/null; then
  echo "== network"
  k apply -f "$dir/network/"
fi

deadline=0

check_deadline() {
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "timeout: layer $1 not ready within $((LAYER_TIMEOUT / 60)) minutes" >&2
    k get pods >&2
    exit 1
  fi
}

# imagePullPolicy Never: an image missing in Docker never appears by itself, so stop at once.
# Only the pods of the shop: a test pod of somebody else does not stop the script.
check_images() {
  local missing image
  missing=$(k get pods -l app.kubernetes.io/part-of=shop -o jsonpath='{range .items[*]}{range .status.initContainerStatuses[*]}{.state.waiting.reason} {.image}{"\n"}{end}{range .status.containerStatuses[*]}{.state.waiting.reason} {.image}{"\n"}{end}{end}' |
    sed -n 's/^ErrImageNeverPull //p' | sort -u)
  [ -z "$missing" ] && return 0
  for image in $missing; do
    case $image in
      *:dev) echo "image $image not found in Docker: run bash deploy/k8s/up.sh $target --build" >&2 ;;
      *) echo "image $image not found in Docker: run docker pull $image" >&2 ;;
    esac
  done
  exit 1
}

# wait_workloads <layer> <file>...: rollout of every Deployment and StatefulSet from the files.
wait_workloads() {
  local layer=$1 f ref refs
  shift
  for f in "$@"; do
    refs=$(k get -f "$f" -o name | grep -E '^(deployment|statefulset)\.apps/' || true)
    for ref in $refs; do
      echo "waiting for $ref"
      until k rollout status "$ref" --timeout=5s >/dev/null 2>&1; do
        check_images
        check_deadline "$layer"
      done
    done
  done
}

# run_job <layer> <file>: delete, create, wait for Complete; Failed -> last log lines and exit 1.
run_job() {
  local layer=$1 f=$2 job conditions
  job=$(k create --dry-run=client -o name -f "$f")
  k delete -f "$f" --ignore-not-found >/dev/null
  k apply -f "$f"
  echo "waiting for $job"
  while :; do
    conditions=$(k get "$job" -o jsonpath='{range .status.conditions[?(@.status=="True")]}{.type} {end}')
    case " $conditions " in
      *" Complete "*)
        echo "$job complete"
        return 0
        ;;
      *" Failed "*)
        echo "$job failed, last log lines:" >&2
        # Also the initContainer wait-for-network: a failed attempt may end there.
        k logs "$job" --all-containers --prefix --tail=20 >&2 || true
        exit 1
        ;;
    esac
    check_images
    check_deadline "$layer"
    sleep 2
  done
}

# restart_dev <file>...: rollout restart of the existing Deployments and StatefulSets from the files that use a
# :dev image (--build). New ones start with the new image anyway.
restart_dev() {
  local f ref
  for f in "$@"; do
    for ref in $(k get -f "$f" --ignore-not-found -o name | grep -E '^(deployment|statefulset)\.apps/' || true); do
      case " $(k get "$ref" -o jsonpath='{.spec.template.spec.containers[*].image}') " in
        *":dev "*) k rollout restart "$ref" ;;
      esac
    done
  done
}

start_layer() {
  local layer=$1 f
  local jobs=() workloads=()
  for f in "$dir/$layer"/*.yaml; do
    if grep -q '^kind: Job' "$f"; then
      jobs+=("$f")
    else
      workloads+=("$f")
    fi
  done
  echo "== $layer"
  deadline=$((SECONDS + LAYER_TIMEOUT))
  if [ "$layer" != infra ] && [ ${#jobs[@]} -gt 0 ]; then
    for f in "${jobs[@]}"; do
      run_job "$layer" "$f"
    done
  fi
  if [ ${#workloads[@]} -gt 0 ]; then
    # After the migrations of the layer: the new code never runs on the old schema.
    if [ "$build" -eq 1 ]; then
      restart_dev "${workloads[@]}"
    fi
    for f in "${workloads[@]}"; do
      k apply -f "$f"
    done
    wait_workloads "$layer" "${workloads[@]}"
  fi
  if [ "$layer" = infra ] && [ ${#jobs[@]} -gt 0 ]; then
    for f in "${jobs[@]}"; do
      run_job "$layer" "$f"
    done
  fi
}

case $target in
  all) layers="infra platform services" ;;
  *) layers=$target ;;
esac
for layer in $layers; do
  if ! compgen -G "$dir/$layer/*.yaml" >/dev/null; then
    echo "skipping $layer: no manifests"
    # An explicitly requested layer without manifests is an error; with "all" the next layer follows.
    [ "$target" = all ] || exit 1
    continue
  fi
  start_layer "$layer"
done
echo "done: $target"
