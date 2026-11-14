#!/usr/bin/env bash
# Creates or updates the Secrets of the shop in namespace shop (context rancher-desktop):
# one Secret <workload>-secret per workload, keys = names of its environment variables.
#   bash deploy/k8s/secrets.sh          (up.sh runs it on every start)
# Values come from deploy/.env and deploy/secrets/jwt-private.pem (both from deploy/create-secrets.sh) and from the
# mkcert certificate in deploy/secrets/tls/ (created on the first run, Secret shop-tls).
# The manifests are built in memory and go to kubectl on stdin (base64 from the printf builtin): values are
# never in process arguments, on the screen or in a file. Prints only the Secret names. Idempotent.
# Server-side apply: no annotation last-applied-configuration (a client-side apply copies all values into it).
# Exit codes: 0 OK, 1 error, 2 no kubectl or no context rancher-desktop.
set -euo pipefail
# Never traced (bash -x, SHELLOPTS=xtrace): the trace would print the values read below on stderr.
{ set +x; } 2>/dev/null

CONTEXT=rancher-desktop
NAMESPACE=shop
dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
deploy_dir=$(dirname "$dir")
env_file=$deploy_dir/.env
jwt_key=$deploy_dir/secrets/jwt-private.pem
hint="run: bash deploy/create-secrets.sh"

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl not found: install Rancher Desktop (Kubernetes enabled)" >&2
  exit 2
fi
if ! kubectl config get-contexts "$CONTEXT" >/dev/null 2>&1; then
  echo "kubectl context $CONTEXT not found: start Rancher Desktop with Kubernetes enabled" >&2
  exit 2
fi
if [ ! -f "$env_file" ]; then
  echo "deploy/.env not found, $hint" >&2
  exit 1
fi
if [ ! -f "$jwt_key" ]; then
  echo "deploy/secrets/jwt-private.pem not found, $hint" >&2
  exit 1
fi

# Read as text (no source), like postman/run.sh: the last NAME=value line, as docker compose does. CR and one
# pair of quotes around the value are removed; a comment or text after the value is not supported.
read_env() {
  local value
  value=$(sed -n "s/^$1=//p" "$env_file" | tail -n 1 | tr -d '\r')
  case $value in
    \"*\" | \'*\')
      value=${value:1:${#value}-2}
      ;;
    \"* | \'* | *[[:space:]]\#*)
      echo "unsupported .env syntax for $1 in deploy/.env (text after the value or an unclosed quote), write it as $1=<value>" >&2
      return 1
      ;;
  esac
  printf '%s\n' "$value"
}

# Every variable is checked before anything is applied, so no Secret is left half-updated.
# ADMIN_EMAIL is optional, like ${ADMIN_EMAIL:-admin@sklep.local} in deploy/compose.yaml.
missing=""
for name in POSTGRES_PASSWORD AUTH_DB_PASSWORD USER_DB_PASSWORD PRODUCT_DB_PASSWORD INVENTORY_DB_PASSWORD \
  ORDER_DB_PASSWORD SHIPPING_DB_PASSWORD MONGO_ROOT_PASSWORD REVIEW_DB_PASSWORD NOTIFICATION_DB_PASSWORD \
  RABBITMQ_ADMIN_PASSWORD AUTH_RABBITMQ_PASSWORD NOTIFICATION_RABBITMQ_PASSWORD INVENTORY_RABBITMQ_PASSWORD \
  SHIPPING_RABBITMQ_PASSWORD ORDER_RABBITMQ_PASSWORD REDIS_GATEWAY_PASSWORD REDIS_CART_PASSWORD ADMIN_PASSWORD \
  CONSUL_MANAGEMENT_TOKEN CONSUL_AUTH_TOKEN CONSUL_GATEWAY_TOKEN GRAFANA_ADMIN_PASSWORD; do
  value=$(read_env "$name") || exit 1
  if [ -z "$value" ]; then
    missing="$missing $name"
  fi
done
value=""
if [ -n "$missing" ]; then
  echo "missing in deploy/.env:$missing - $hint" >&2
  exit 1
fi

# Consul ACL tokens: only the UUID format from create-secrets.sh is accepted (the management token goes into a quoted
# HCL string, all three are SecretIDs in Consul). Three different values: consul-acl-setup.sh finds a token by its
# SecretID and sets its policy, so a service token equal to another token would take over that token.
consul_token=$(read_env CONSUL_MANAGEMENT_TOKEN)
consul_auth_token=$(read_env CONSUL_AUTH_TOKEN)
consul_gateway_token=$(read_env CONSUL_GATEWAY_TOKEN)
uuid_regex='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
for name in CONSUL_MANAGEMENT_TOKEN CONSUL_AUTH_TOKEN CONSUL_GATEWAY_TOKEN; do
  if ! [[ $(read_env "$name") =~ $uuid_regex ]]; then
    echo "$name in deploy/.env is not a lowercase UUID; remove the line and $hint" >&2
    exit 1
  fi
done
admin_email=$(read_env ADMIN_EMAIL) || exit 1
admin_email=${admin_email:-admin@sklep.local}
# A rough check only (Auth Service validates the address at startup); the value is never printed.
if ! [[ $admin_email =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  echo "ADMIN_EMAIL in deploy/.env is not an e-mail address; fix it or remove the line (default admin@sklep.local)" >&2
  exit 1
fi
if [ "$consul_auth_token" = "$consul_token" ] || [ "$consul_gateway_token" = "$consul_token" ] ||
  [ "$consul_auth_token" = "$consul_gateway_token" ]; then
  echo "CONSUL_MANAGEMENT_TOKEN, CONSUL_AUTH_TOKEN and CONSUL_GATEWAY_TOKEN in deploy/.env must be different; remove the lines of the last two and $hint" >&2
  exit 1
fi

b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

manifests=""
# add_secret <name> <KEY> <value> [<KEY> <value> ...]
add_secret() {
  local name=$1
  shift
  manifests+="---
apiVersion: v1
kind: Secret
metadata:
  name: $name
  namespace: $NAMESPACE
  labels:
    app.kubernetes.io/part-of: shop
type: Opaque
data:
"
  while [ $# -gt 0 ]; do
    manifests+="  $1: $(b64 "$2")
"
    shift 2
  done
}

add_secret postgres-secret \
  POSTGRES_PASSWORD "$(read_env POSTGRES_PASSWORD)" \
  AUTH_DB_PASSWORD "$(read_env AUTH_DB_PASSWORD)" \
  USER_DB_PASSWORD "$(read_env USER_DB_PASSWORD)" \
  PRODUCT_DB_PASSWORD "$(read_env PRODUCT_DB_PASSWORD)" \
  INVENTORY_DB_PASSWORD "$(read_env INVENTORY_DB_PASSWORD)" \
  ORDER_DB_PASSWORD "$(read_env ORDER_DB_PASSWORD)" \
  SHIPPING_DB_PASSWORD "$(read_env SHIPPING_DB_PASSWORD)"
add_secret mongo-secret \
  MONGO_INITDB_ROOT_PASSWORD "$(read_env MONGO_ROOT_PASSWORD)" \
  REVIEW_DB_PASSWORD "$(read_env REVIEW_DB_PASSWORD)" \
  NOTIFICATION_DB_PASSWORD "$(read_env NOTIFICATION_DB_PASSWORD)"
add_secret rabbitmq-secret \
  RABBITMQ_DEFAULT_PASS "$(read_env RABBITMQ_ADMIN_PASSWORD)"
add_secret rabbitmq-setup-secret \
  RABBITMQ_ADMIN_PASSWORD "$(read_env RABBITMQ_ADMIN_PASSWORD)" \
  AUTH_RABBITMQ_PASSWORD "$(read_env AUTH_RABBITMQ_PASSWORD)" \
  NOTIFICATION_RABBITMQ_PASSWORD "$(read_env NOTIFICATION_RABBITMQ_PASSWORD)" \
  INVENTORY_RABBITMQ_PASSWORD "$(read_env INVENTORY_RABBITMQ_PASSWORD)" \
  SHIPPING_RABBITMQ_PASSWORD "$(read_env SHIPPING_RABBITMQ_PASSWORD)" \
  ORDER_RABBITMQ_PASSWORD "$(read_env ORDER_RABBITMQ_PASSWORD)"
add_secret redis-gateway-secret \
  REDIS_PASSWORD "$(read_env REDIS_GATEWAY_PASSWORD)"
add_secret redis-cart-secret \
  REDIS_PASSWORD "$(read_env REDIS_CART_PASSWORD)"
# acl.hcl is mounted into the Consul config directory; the agent uses the management token as well,
# otherwise its own catalog updates are "blocked by ACLs". CONSUL_HTTP_TOKEN: Job consul-kv-seed (and the file
# /consul/token/CONSUL_HTTP_TOKEN in consul-0). CONSUL_AUTH_TOKEN, CONSUL_GATEWAY_TOKEN: only Job consul-kv-seed, which
# creates these tokens in Consul (consul-acl-setup.sh); the StatefulSet mounts only the two keys above (items).
add_secret consul-secret \
  acl.hcl "# Generated by deploy/k8s/secrets.sh from CONSUL_MANAGEMENT_TOKEN in deploy/.env
acl {
  enabled = true
  default_policy = \"deny\"
  enable_token_persistence = true
  tokens {
    initial_management = \"$consul_token\"
    agent = \"$consul_token\"
  }
}
" \
  CONSUL_HTTP_TOKEN "$consul_token" \
  CONSUL_AUTH_TOKEN "$consul_auth_token" \
  CONSUL_GATEWAY_TOKEN "$consul_gateway_token"
# CONSUL_HTTP_TOKEN of Auth and Gateway: their own Consul tokens, the only ones that may register their names.
add_secret auth-service-secret \
  DB_PASSWORD "$(read_env AUTH_DB_PASSWORD)" \
  ADMIN_EMAIL "$admin_email" \
  ADMIN_PASSWORD "$(read_env ADMIN_PASSWORD)" \
  RABBITMQ_PASSWORD "$(read_env AUTH_RABBITMQ_PASSWORD)" \
  CONSUL_HTTP_TOKEN "$consul_auth_token"
add_secret auth-jwt-secret \
  jwt-private.pem "$(cat "$jwt_key")
"
add_secret api-gateway-secret \
  REDIS_PASSWORD "$(read_env REDIS_GATEWAY_PASSWORD)" \
  CONSUL_HTTP_TOKEN "$consul_gateway_token"
add_secret user-service-secret \
  DB_PASSWORD "$(read_env USER_DB_PASSWORD)"
add_secret product-service-secret \
  DB_PASSWORD "$(read_env PRODUCT_DB_PASSWORD)"
# The three URLs below are built exactly like in deploy/compose.yaml (host names = Service names).
add_secret cart-service-secret \
  REDIS_URL "redis://:$(read_env REDIS_CART_PASSWORD)@redis-cart:6379/0"
add_secret inventory-service-secret \
  DATABASE_URL "postgresql+psycopg2://inventory_service:$(read_env INVENTORY_DB_PASSWORD)@postgres:5432/inventory_db" \
  RABBITMQ_PASSWORD "$(read_env INVENTORY_RABBITMQ_PASSWORD)"
add_secret review-service-secret \
  MONGODB_URL "mongodb://review_service:$(read_env REVIEW_DB_PASSWORD)@mongo:27017/review_db?authSource=review_db"
add_secret notification-service-secret \
  DB_PASSWORD "$(read_env NOTIFICATION_DB_PASSWORD)" \
  RABBITMQ_PASSWORD "$(read_env NOTIFICATION_RABBITMQ_PASSWORD)"
# Account admin of Grafana (layer monitoring); anonymous users only view.
add_secret grafana-secret \
  GF_SECURITY_ADMIN_PASSWORD "$(read_env GRAFANA_ADMIN_PASSWORD)"
consul_token=""
consul_auth_token=""
consul_gateway_token=""

# TLS: Secret shop-tls (type kubernetes.io/tls) for the Ingress, from the mkcert certificate of shop.localhost in
# deploy/secrets/tls/ (ignored by git). Created by mkcert when a file is missing; existing files are reused.
tls_dir=$deploy_dir/secrets/tls
tls_cert=$tls_dir/shop.localhost.pem
tls_key=$tls_dir/shop.localhost-key.pem
if [ ! -f "$tls_cert" ] || [ ! -f "$tls_key" ]; then
  if ! command -v mkcert >/dev/null 2>&1; then
    echo "mkcert not found (certificate of shop.localhost): brew install mkcert && mkcert -install, then run this script again" >&2
    exit 1
  fi
  mkdir -p "$tls_dir"
  chmod 700 "$tls_dir"
  # The output of mkcert (paths, names, expiry) is shown only on an error.
  if ! mkcert_out=$(umask 077 && mkcert -cert-file "$tls_cert" -key-file "$tls_key" shop.localhost 2>&1); then
    printf '%s\n' "$mkcert_out" >&2
    echo "mkcert failed to create the certificate of shop.localhost" >&2
    exit 1
  fi
  chmod 600 "$tls_key"
  case $mkcert_out in
    *"not installed"*) echo "warning: the mkcert CA is not trusted by this system yet, run: mkcert -install" >&2 ;;
  esac
fi
# base64 reads the files on stdin: the key is never in a process argument.
manifests+="---
apiVersion: v1
kind: Secret
metadata:
  name: shop-tls
  namespace: $NAMESPACE
  labels:
    app.kubernetes.io/part-of: shop
type: kubernetes.io/tls
data:
  tls.crt: $(base64 < "$tls_cert" | tr -d '\n')
  tls.key: $(base64 < "$tls_key" | tr -d '\n')
"

# --force-conflicts: takes over the fields of the Secrets applied client-side before (kubectl-client-side-apply).
printf '%s' "$manifests" |
  kubectl --context "$CONTEXT" -n "$NAMESPACE" apply --server-side --field-manager=shop-secrets --force-conflicts -f -
manifests=""

# Secrets applied client-side before keep last-applied-configuration with the old values (server-side apply does
# not touch it): removed once, then never there again. The template prints only names, never the annotation.
# shellcheck disable=SC2016 # $name is a go-template variable, not a shell one
stale=$(kubectl --context "$CONTEXT" -n "$NAMESPACE" get secrets -l app.kubernetes.io/part-of=shop -o go-template \
  --template='{{range .items}}{{$name := .metadata.name}}{{with .metadata.annotations}}{{if index . "kubectl.kubernetes.io/last-applied-configuration"}}{{$name}}{{"\n"}}{{end}}{{end}}{{end}}')
for name in $stale; do
  kubectl --context "$CONTEXT" -n "$NAMESPACE" annotate secret "$name" kubectl.kubernetes.io/last-applied-configuration-
done
