#!/usr/bin/env bash
# Creates local secrets for Docker Compose:
#   deploy/.env                  passwords (openssl rand -hex 24), also for the first Auth admin
#   deploy/secrets/jwt-*.pem     RS256 key pair for Auth (PKCS#8 and SPKI)
# Never overwrites anything: only adds missing variables and missing keys.
# A variable with an empty value (e.g. after cp .env.example .env) counts as missing.
# Values are never printed.
# Run from any directory: bash deploy/create-secrets.sh
set -euo pipefail

# Check openssl first. Up to this point only bash builtins are used,
# so the message works even with no other programs in PATH.
if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl not found. On Windows, run this script in Git Bash." >&2
  exit 1
fi

# Script directory (without dirname): "deploy/x.sh" -> "deploy", "x.sh" -> "."
case "$0" in
  */*) SCRIPT_DIR=${0%/*} ;;
  *) SCRIPT_DIR=. ;;
esac
SCRIPT_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR" && pwd)

# Same list as in deploy/.env.example
VARIABLES="POSTGRES_PASSWORD
AUTH_DB_PASSWORD
USER_DB_PASSWORD
PRODUCT_DB_PASSWORD
INVENTORY_DB_PASSWORD
ORDER_DB_PASSWORD
SHIPPING_DB_PASSWORD
REDIS_GATEWAY_PASSWORD
ADMIN_PASSWORD
RABBITMQ_ADMIN_PASSWORD
AUTH_RABBITMQ_PASSWORD
NOTIFICATION_RABBITMQ_PASSWORD
INVENTORY_RABBITMQ_PASSWORD
SHIPPING_RABBITMQ_PASSWORD
ORDER_RABBITMQ_PASSWORD"

umask 077

# ---- deploy/.env ----
ENV_FILE="$SCRIPT_DIR/.env"
# Temporary file in the same directory (atomic mv); removed on every exit
TMP_FILE="$ENV_FILE.tmp.$$"
trap 'rm -f "$TMP_FILE"' EXIT

# A known name with an empty value (NAME=, NAME="", NAME='', only spaces) = missing.
# Such lines are removed (in the copy) and the value is appended at the end.
names_regex=""
for name in $VARIABLES; do
  names_regex="${names_regex:+${names_regex}|}${name}"
done
empty_regex="^(${names_regex})=[[:space:]]*(\"\"|'')?[[:space:]]*\$"

source_file="$ENV_FILE"
if [ -f "$ENV_FILE" ] && grep -qE "$empty_regex" "$ENV_FILE"; then
  # grep -v returns 1 when nothing is left (only empty variables) - not an error
  grep -vE "$empty_regex" "$ENV_FILE" >"$TMP_FILE" || [ $? -eq 1 ]
  source_file="$TMP_FILE"
fi

new_lines=""
missing=""
count=0
for name in $VARIABLES; do
  if [ -f "$source_file" ] && grep -q "^${name}=" "$source_file"; then
    continue
  fi
  value=$(openssl rand -hex 24)
  new_lines="${new_lines}${name}=${value}
"
  missing="${missing} ${name}"
  count=$((count + 1))
done
value=""

if [ ! -f "$ENV_FILE" ]; then
  printf '%s' "$new_lines" >"$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "deploy/.env: created (${count} variables)"
elif [ "$count" -gt 0 ]; then
  # File without a trailing newline: add one first so two variables are not joined
  if [ -s "$source_file" ] && [ -n "$(tail -c 1 "$source_file")" ]; then
    echo >>"$source_file"
  fi
  printf '%s' "$new_lines" >>"$source_file"
  if [ "$source_file" = "$TMP_FILE" ]; then
    mv -f "$TMP_FILE" "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
  echo "deploy/.env: added:${missing}"
elif [ "$source_file" = "$TMP_FILE" ]; then
  # Rare: an empty line next to the same name with a value - only the empty one is removed
  mv -f "$TMP_FILE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "deploy/.env: removed empty lines (variables already have values)"
else
  chmod 600 "$ENV_FILE"
  echo "deploy/.env: unchanged"
fi
new_lines=""

# ---- deploy/secrets/jwt-private.pem and jwt-public.pem ----
SECRETS_DIR="$SCRIPT_DIR/secrets"
PRIVATE_KEY="$SECRETS_DIR/jwt-private.pem"
PUBLIC_KEY="$SECRETS_DIR/jwt-public.pem"
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

# Public key from the private key (SPKI, "BEGIN PUBLIC KEY")
write_public_key() {
  openssl pkey -in "$PRIVATE_KEY" -pubout -out "$PUBLIC_KEY.tmp"
  mv -f "$PUBLIC_KEY.tmp" "$PUBLIC_KEY"
}

if [ ! -f "$PRIVATE_KEY" ]; then
  # LibreSSL prints generation progress to stderr, so stderr is shown only on error.
  # Write to a temporary file first so an interrupted run does not leave a broken key.
  if ! errors=$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$PRIVATE_KEY.tmp" 2>&1); then
    rm -f "$PRIVATE_KEY.tmp"
    printf '%s\n' "$errors" >&2
    echo "Failed to generate the RSA key." >&2
    exit 1
  fi
  mv -f "$PRIVATE_KEY.tmp" "$PRIVATE_KEY"
  write_public_key
  echo "deploy/secrets/jwt-*.pem: created"
elif [ ! -f "$PUBLIC_KEY" ]; then
  write_public_key
  echo "deploy/secrets/jwt-public.pem: recreated from private key"
else
  echo "deploy/secrets/jwt-*.pem: unchanged"
fi
chmod 600 "$PRIVATE_KEY"
chmod 644 "$PUBLIC_KEY"

echo "Done. Start: docker compose -f deploy/compose.yaml up -d --wait"
