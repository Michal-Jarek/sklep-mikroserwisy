#!/bin/sh
# Run by the one-off rabbitmq-setup container on every "up" (through the HTTP API, rabbitmqadmin 2.x):
#   1. topology from /setup/definitions.json (exchanges, queues, bindings, policies);
#   2. service accounts with permissions and topic permissions; passwords from the environment.
# The import adds what is missing and updates policies, accounts and permissions; existing queues
# and exchanges are skipped without an error (changing the type or arguments of a queue needs a
# clean start), and nothing is deleted. The admin account is created by the broker
# (RABBITMQ_DEFAULT_USER/PASS) and is not touched here.
# No password is passed as a process argument: rabbitmqadmin reads the admin password from
# RABBITMQADMIN_PASSWORD, the accounts JSON goes through stdin (printf is a shell builtin).
set -eu

# Passwords are put into the accounts JSON without escaping, so only characters that need none
# are allowed. Checked before any import; the message names the variable, never the value.
check_password() {
  case "$2" in
    "" | *[!A-Za-z0-9._~-]*)
      echo "$1: only letters, digits and . _ ~ - are allowed (at least one character)" >&2
      exit 1
      ;;
  esac
}
check_password AUTH_RABBITMQ_PASSWORD "${AUTH_RABBITMQ_PASSWORD-}"
check_password NOTIFICATION_RABBITMQ_PASSWORD "${NOTIFICATION_RABBITMQ_PASSWORD-}"
check_password INVENTORY_RABBITMQ_PASSWORD "${INVENTORY_RABBITMQ_PASSWORD-}"
check_password SHIPPING_RABBITMQ_PASSWORD "${SHIPPING_RABBITMQ_PASSWORD-}"
check_password ORDER_RABBITMQ_PASSWORD "${ORDER_RABBITMQ_PASSWORD-}"

export RABBITMQADMIN_TARGET_HOST=rabbitmq
export RABBITMQADMIN_USERNAME=admin
export RABBITMQADMIN_PASSWORD="$RABBITMQ_ADMIN_PASSWORD"
export RABBITMQADMIN_NON_INTERACTIVE_MODE=true

rabbitmqadmin definitions import --file /setup/definitions.json >/dev/null
echo "imported definitions.json"

# configure "^$" for everyone: only the platform declares exchanges, queues and bindings.
# read: only the own <service>.q; write to shop.events only for senders, limited by topic permissions.
{
  printf '{"users":['
  printf '{"name":"auth-service","password":"%s","tags":[]},' "$AUTH_RABBITMQ_PASSWORD"
  printf '{"name":"notification-service","password":"%s","tags":[]},' "$NOTIFICATION_RABBITMQ_PASSWORD"
  printf '{"name":"inventory-service","password":"%s","tags":[]},' "$INVENTORY_RABBITMQ_PASSWORD"
  printf '{"name":"shipping-service","password":"%s","tags":[]},' "$SHIPPING_RABBITMQ_PASSWORD"
  printf '{"name":"order-service","password":"%s","tags":[]}' "$ORDER_RABBITMQ_PASSWORD"
  printf '],"permissions":['
  printf '{"user":"auth-service","vhost":"/","configure":"^$","write":"^shop\\\\.events$","read":"^$"},'
  printf '{"user":"notification-service","vhost":"/","configure":"^$","write":"^$","read":"^notification\\\\.q$"},'
  printf '{"user":"inventory-service","vhost":"/","configure":"^$","write":"^$","read":"^inventory\\\\.q$"},'
  printf '{"user":"shipping-service","vhost":"/","configure":"^$","write":"^shop\\\\.events$","read":"^shipping\\\\.q$"},'
  printf '{"user":"order-service","vhost":"/","configure":"^$","write":"^shop\\\\.events$","read":"^order\\\\.q$"}'
  printf '],"topic_permissions":['
  printf '{"user":"auth-service","vhost":"/","exchange":"shop.events","write":"^user\\\\.registered$","read":"^$"},'
  printf '{"user":"shipping-service","vhost":"/","exchange":"shop.events","write":"^shipment\\\\.status_changed$","read":"^$"},'
  printf '{"user":"order-service","vhost":"/","exchange":"shop.events","write":"^order\\\\.(created|cancelled)$","read":"^$"}'
  printf ']}'
} | rabbitmqadmin definitions import --stdin >/dev/null
echo "applied 5 service accounts"
