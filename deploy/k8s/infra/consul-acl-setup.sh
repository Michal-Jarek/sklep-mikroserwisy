#!/bin/sh
# Run by Job consul-kv-seed (consul-kv-seed.yaml) after seed-kv.sh, on every deploy/k8s/up.sh:
#   1. policy anonymous-shop on the anonymous token: requests without a token (the team services) may read config/
#      and the catalog, and register and deregister services with their checks only under the names in TEAM_SERVICES
#      (an allowlist: the reserved names auth-service and api-gateway and every other name are read only);
#   2. policies auth-service and api-gateway and the tokens of these two services: only they may register and
#      deregister their names, so nobody without the token can put an own address behind /api/v1/auth/** (Gateway);
#   3. deletes the other tokens linked only to the policy auth-service (api-gateway): after a change of
#      CONSUL_AUTH_TOKEN (CONSUL_GATEWAY_TOKEN) in deploy/.env the old token must stop registering the name.
# Writing KV and anything about ACL needs the management token.
# Needs CONSUL_HTTP_ADDR, CONSUL_HTTP_TOKEN (management token), CONSUL_AUTH_TOKEN and CONSUL_GATEWAY_TOKEN (SecretIDs of
# the service tokens, UUIDs from deploy/.env) in the environment. Tokens never go to the output or to process arguments;
# the output holds names and AccessorIDs only.
# Idempotent: a second run updates the same policies and the same tokens and has no old token to delete.
set -eu

ANONYMOUS_TOKEN_ID=00000000-0000-0000-0000-000000000002
# What a service reads: catalog and health of all services (discovery), nodes, config/ in KV, the agent.
READ_RULES='service_prefix "" { policy = "read" }
node_prefix "" { policy = "read" }
key_prefix "config/" { policy = "read" }
agent_prefix "" { policy = "read" }'
# Names the team services register without a token. A new team service = add its name here.
# An allowlist, not service_prefix "" write: Consul finds services by name without case, ACL rules match with case,
# so a write prefix would let anybody register e.g. AUTH-SERVICE, returned for auth-service (stage 7 Z20).
TEAM_SERVICES="user-service cart-service inventory-service review-service product-service notification-service
order-service shipping-service"
# No agent_prefix: without a token nobody reads the agent (logs in /v1/agent/monitor, metrics). Registering,
# checking and deregistering an own entry need only the service rule.
ANONYMOUS_RULES='service_prefix "" { policy = "read" }
node_prefix "" { policy = "read" }
key_prefix "config/" { policy = "read" }'
for name in $TEAM_SERVICES; do
  ANONYMOUS_RULES="$ANONYMOUS_RULES
service \"$name\" { policy = \"write\" }"
done

# upsert_policy <name> <description> <rules>
# Looked up in the list, not with "acl policy read": reading a missing policy logs "[ERROR] ... ACL not found" in Consul.
upsert_policy() {
  policies=$(consul acl policy list -format=json)
  if printf '%s' "$policies" | jq -e --arg name "$1" 'any(.[]; .Name == $name)' >/dev/null; then
    consul acl policy update -name "$1" -description "$2" -rules "$3" >/dev/null
    echo "updated policy $1"
  else
    consul acl policy create -name "$1" -description "$2" -rules "$3" >/dev/null
    echo "created policy $1"
  fi
}

# delete_old_tokens <policy> <AccessorID of the current token>
# Deletes every other token whose only link is this policy: no other policy, role, service, node or templated
# identity. The management (= agent) and anonymous tokens have other policies, so they never match. The list
# contains SecretIDs: it stays in a variable and only AccessorIDs come out of jq.
delete_old_tokens() {
  if ! tokens=$(consul acl token list -format=json); then
    echo "failed to list the tokens (looking for old tokens of $1)" >&2
    exit 1
  fi
  old=$(printf '%s' "$tokens" | jq -r --arg policy "$1" --arg current "$2" --arg anonymous "$ANONYMOUS_TOKEN_ID" '
    .[]
    | select(.AccessorID != $current and .AccessorID != $anonymous)
    | select([.Policies[]?.Name] == [$policy])
    | select((.Roles // []) + (.ServiceIdentities // []) + (.NodeIdentities // []) + (.TemplatedPolicies // []) == [])
    | .AccessorID')
  tokens=""
  for id in $old; do
    if ! consul acl token delete -accessor-id "$id" >/dev/null; then
      echo "failed to delete old token of $1 $id" >&2
      exit 1
    fi
    echo "deleted old token of $1 $id"
  done
}

# upsert_token <policy> <SecretID> (a function argument, not a process argument)
# The SecretID is fixed in deploy/.env, so the token is looked up by it in the token list (jq compares it from env;
# the list holds SecretIDs, so it stays in a variable). Not with GET /v1/acl/token/self: a token that does not exist
# yet logs "[ERROR] ... ACL not found" in Consul. Creating it again with the same SecretID fails (500), so an existing
# token is updated through its AccessorID.
# Then the old tokens of the policy are deleted (delete_old_tokens). jq -e (new token): without an AccessorID the
# script stops here, otherwise the current token would not be excluded from the deletion.
upsert_token() {
  description="Token of $1 (SecretID from deploy/.env)"
  if ! tokens=$(consul acl token list -format=json); then
    echo "failed to list the tokens (looking for the token of $1)" >&2
    exit 1
  fi
  accessor=$(printf '%s' "$tokens" | SECRET_ID=$2 jq -r '.[] | select(.SecretID == env.SECRET_ID) | .AccessorID')
  tokens=""
  if [ -n "$accessor" ]; then
    # The output of the CLI contains the SecretID.
    consul acl token update -accessor-id "$accessor" -policy-name "$1" -description "$description" >/dev/null
    echo "updated token of $1"
  else
    # HTTP API: the CLI takes the SecretID only as an argument. The body comes from jq (env) on stdin and curl
    # takes the management token from the environment (--variable), so neither value is in an argument.
    # The response contains the SecretID: it stays in a variable, only the AccessorID is taken.
    if ! created=$(SECRET_ID=$2 jq -n --arg policy "$1" --arg description "$description" \
      '{SecretID: env.SECRET_ID, Description: $description, Policies: [{Name: $policy}]}' |
      curl -sS -f -X PUT --data-binary @- \
        --variable %CONSUL_HTTP_TOKEN --expand-header 'X-Consul-Token: {{CONSUL_HTTP_TOKEN}}' \
        "$CONSUL_HTTP_ADDR/v1/acl/token"); then
      echo "failed to create the token of $1" >&2
      exit 1
    fi
    accessor=$(printf '%s' "$created" | jq -er .AccessorID)
    created=""
    echo "created token of $1"
  fi
  delete_old_tokens "$1" "$accessor"
}

upsert_policy anonymous-shop "Requests without a token (shop services)" "$ANONYMOUS_RULES"
upsert_policy auth-service "Token of Auth Service: registers the name auth-service" \
  "service \"auth-service\" { policy = \"write\" }
$READ_RULES"
upsert_policy api-gateway "Token of API Gateway: registers the name api-gateway" \
  "service \"api-gateway\" { policy = \"write\" }
$READ_RULES"

# Without -merge-policies the list of policies is replaced, so a second run adds no duplicate.
consul acl token update -accessor-id "$ANONYMOUS_TOKEN_ID" -policy-name anonymous-shop >/dev/null
echo "attached policy anonymous-shop to the anonymous token"

upsert_token auth-service "$CONSUL_AUTH_TOKEN"
upsert_token api-gateway "$CONSUL_GATEWAY_TOKEN"
