#!/bin/sh
# Loads service configuration into Consul KV: /kv/config/<service>.yaml -> key config/<service>/data.
# Run by the consul-kv-seed container (deploy/compose.yaml) on every "up"; overwrites values in KV.
# A failure of any write ends the script with a non-zero exit code.
set -eu

for f in /kv/config/*.yaml; do
  # Empty directory: the pattern stays literal, nothing to load.
  [ -f "$f" ] || continue
  key="config/$(basename "$f" .yaml)/data"
  consul kv put "$key" "@$f" >/dev/null
  echo "loaded $key"
done
