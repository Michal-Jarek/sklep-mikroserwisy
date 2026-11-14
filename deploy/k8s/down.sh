#!/usr/bin/env bash
# Stops the shop in local Kubernetes: always context rancher-desktop, namespace shop.
#   bash deploy/k8s/down.sh [--purge]
# Deletes by kind everything the shop runs in namespace shop: Ingresses, Traefik middlewares, HPAs,
# PodDisruptionBudgets, Deployments, StatefulSets, Jobs, remaining pods, Services, ConfigMaps,
# NetworkPolicies, Roles, RoleBindings and ServiceAccounts (except default). By kind, not by label: also objects
# whose manifests were removed from the repo and test objects. Waits until no pod is left (at most 2 minutes).
# PersistentVolumeClaims (the data) and Secrets stay; --purge deletes them too (the next up.sh starts with
# empty databases). Never deletes the namespace itself or anything outside it - also not the ClusterRole and
# ClusterRoleBinding shop-prometheus-kubelet of deploy/k8s/cluster/ (removal: deploy/k8s/README.md).
# Exit codes: 0 OK, 1 error, 2 wrong usage, no kubectl, no context rancher-desktop or the cluster does not answer.
set -euo pipefail

CONTEXT=rancher-desktop
NAMESPACE=shop
TIMEOUT=120s

usage() {
  echo "usage: bash deploy/k8s/down.sh [--purge]" >&2
  exit 2
}

purge=0
case $# in
  0) ;;
  1)
    [ "$1" = --purge ] || usage
    purge=1
    ;;
  *) usage ;;
esac

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
if ! k get namespace "$NAMESPACE" >/dev/null 2>&1; then
  echo "namespace $NAMESPACE does not exist: nothing to stop"
  exit 0
fi

# Entry first (no new requests), then the autoscalers (they would scale the workloads back up).
entry="ingresses.networking.k8s.io,horizontalpodautoscalers.autoscaling,poddisruptionbudgets.policy"
if k api-resources --api-group=traefik.io -o name 2>/dev/null | grep -qx 'middlewares.traefik.io'; then
  entry="middlewares.traefik.io,$entry"
fi
k delete "$entry" --all
# Foreground: kubectl returns only after the pods of these objects are gone (preStop included).
k delete deployments.apps,statefulsets.apps,replicasets.apps,jobs.batch --all --cascade=foreground --timeout="$TIMEOUT"
k delete pods --all --timeout="$TIMEOUT"
k delete services,networkpolicies.networking.k8s.io --all
# Accounts and permissions of the pods that read the API (prometheus, kube-state-metrics); cluster-wide ones stay.
k delete roles.rbac.authorization.k8s.io,rolebindings.rbac.authorization.k8s.io --all
# The ServiceAccount default is created by Kubernetes in every namespace (and would be recreated at once).
k delete serviceaccounts --field-selector metadata.name!=default
# kube-root-ca.crt is created by Kubernetes in every namespace (and would be recreated at once).
k delete configmaps --field-selector metadata.name!=kube-root-ca.crt

if [ -n "$(k get pods -o name)" ] && ! k wait --for=delete pods --all --timeout="$TIMEOUT" >/dev/null; then
  echo "pods still present after $TIMEOUT:" >&2
  k get pods >&2
  exit 1
fi

if [ "$purge" -eq 1 ]; then
  k delete persistentvolumeclaims --all --timeout="$TIMEOUT"
  k delete secrets --all
  echo "done: shop stopped, data and Secrets deleted (namespace $NAMESPACE kept)"
else
  echo "done: shop stopped, data (PersistentVolumeClaims) and Secrets kept; --purge deletes them"
fi
