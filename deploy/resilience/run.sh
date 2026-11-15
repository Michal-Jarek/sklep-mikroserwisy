#!/usr/bin/env bash
# K14 of stage 8: resilience automata on the compose stack `sklep` (profile full-shop). Regression of the hypotheses
# of CR #17/#18. Prints a PASS/FAIL table, writes it to results/<UTC time>.txt (ignored by git), exit 0 only
# when every case passes.
#   bash deploy/resilience/run.sh [case ...]     cases: olddb rabbit db parallel consul dburl
# Needs: the stack up and healthy, stock of the seed products (bash postman/run.sh compose), Docker, curl, python3.
# Changes the shared stack on purpose (restarts RabbitMQ, stops and pauses Postgres, stops Consul) and restores it,
# also after an error or Ctrl+C (trap). Passwords stay in the containers: compared there, only counts come out.
# Own objects: containers/network e8t7-*, queue e8t7.tap (removed at the end), one customer e8t7-k14-…@example.com.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
dc=(docker compose -p sklep -f "$repo/deploy/compose.yaml" --profile full-shop)
SHOP=http://127.0.0.1:8090/api/v1
MAILPIT=http://127.0.0.1:8025
PRODUCT=a0000000-0000-4000-8000-000000000005   # seed product with stock 25 (scenario S11)
QUEUES="inventory.q order.q shipping.q notification.q"
cases=("$@")
[ ${#cases[@]} -eq 0 ] && cases=(olddb rabbit db parallel consul dburl)
mkdir -p "$here/results"
result_file="$here/results/$(date -u +%Y%m%dT%H%M%SZ).txt"
work=$(mktemp -d)
exec > >(tee "$result_file") 2>&1

ts() { date '+%T'; }
log() { echo "[$(ts)] $*"; }
declare -a table=()
record() { table+=("$(printf '%-9s %-4s %s' "$1" "$2" "$3")"); log "RESULT $1: $2 — $3"; }

drive() {
  docker run --rm --name "e8t7-driver-$RANDOM" --network sklep_backend -v "$here:/r:ro" python:3.12-slim \
    python /r/driver.py "$@"
}
# A new random password for every throwaway account and container of a run; never printed, never in a file.
random_secret() { python3 -c 'import secrets; print(secrets.token_hex(16))'; }
jget() { python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(eval(sys.argv[1], {}, {"d": d}))' "$1"; }

# Queues: name messages unacked consumers (rabbitmqctl, no password).
queues() { "${dc[@]}" exec -T rabbitmq rabbitmqctl list_queues -q name messages messages_unacknowledged consumers 2>/dev/null | tail -n +2 | sort; }
consumers_of() { queues | awk -v q="$1" '$1 == q {print $4}'; }
dlq_counts() { queues | awk '$1 ~ /\.dlq$/ {printf "%s=%s ", $1, $2}'; }
# Management API inside the RabbitMQ container: the admin password never leaves it. BusyBox wget there knows only
# GET and POST, so the request is plain HTTP/1.0 through BusyBox nc (the server closes the connection, no chunks).
# rmq_api <METHOD> <path under /api/>, body on stdin; prints "HTTP <code>" on stderr and the body on stdout.
rmq_api() {
  "${dc[@]}" exec -T rabbitmq sh -c 'auth=$(printf %s "admin:$RABBITMQ_DEFAULT_PASS" | base64 | tr -d "\n")
    body=$(cat); len=$(printf %s "$body" | wc -c | tr -d " ")
    rm -f /tmp/e8t7-rmq.out
    # BusyBox nc ends when its stdin ends: stdin stays open until the answer headers came (at most 5 s), +0.2 s.
    { printf "%s /api/%s HTTP/1.0\r\nHost: localhost\r\nAuthorization: Basic %s\r\nContent-Type: application/json\r\nContent-Length: %s\r\n\r\n" \
        "$1" "$2" "$auth" "$len"; printf %s "$body"
      i=0; while [ $i -lt 50 ] && ! grep -q "$(printf "^\r\$")" /tmp/e8t7-rmq.out 2>/dev/null; do sleep 0.1; i=$((i + 1)); done
      sleep 0.2; } | nc 127.0.0.1 15672 >/tmp/e8t7-rmq.out
    head -1 /tmp/e8t7-rmq.out | awk "{print \"HTTP \" \$2}" >&2
    sed "1,/^\r\$/d" /tmp/e8t7-rmq.out; rm -f /tmp/e8t7-rmq.out' sh "$@"
}
rmq_delete() { rmq_api DELETE "$1" </dev/null >/dev/null 2>&1; }
health_of() { docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$("${dc[@]}" ps -aq "$1")" 2>/dev/null; }
wait_healthy() { # wait_healthy <service> <seconds>
  local i
  for i in $(seq 1 "$2"); do [ "$(health_of "$1")" = healthy ] && return 0; sleep 1; done
  return 1
}
stack_state() { "${dc[@]}" ps --format '{{.Service}} {{.State}} {{.Health}}' | sort; }
wait_stack_healthy() { # all running services healthy, at most <seconds>
  local i
  for i in $(seq 1 "$1"); do
    stack_state | awk '$3 != "healthy"' | grep -q . || return 0
    sleep 1
  done
  return 1
}
passing() { # passing instances per service in Consul
  curl -s "http://127.0.0.1:8500/v1/health/state/passing" | python3 -c 'import json,sys,collections; c=collections.Counter(x["ServiceName"] for x in json.load(sys.stdin) if x["ServiceName"]); print(" ".join(f"{k}={v}" for k,v in sorted(c.items())))'
}
mails() { # mails <address> <subject> -> count
  curl -s "$MAILPIT/api/v1/search?query=to:$1" | python3 -c 'import json,sys; print(sum(1 for m in json.load(sys.stdin)["messages"] if m["Subject"] == sys.argv[1]))' "$2"
}

# --- restore (trap) --------------------------------------------------------------------------------------------
orders_file="$work/orders"   # user:order of every purchase of this run, cancelled at the end
touch "$orders_file"
stock_before=""
restored=0
restore() {
  [ "$restored" = 1 ] && return
  restored=1
  trap '' INT TERM
  log "restore: Postgres, RabbitMQ, Consul, tap queue, own containers, K14 orders, stock"
  [ "$(docker inspect -f '{{.State.Paused}}' "$("${dc[@]}" ps -aq postgres)" 2>/dev/null)" = true ] && "${dc[@]}" unpause postgres >/dev/null 2>&1
  for service in postgres rabbitmq consul; do
    [ "$(docker inspect -f '{{.State.Running}}' "$("${dc[@]}" ps -aq "$service")" 2>/dev/null)" = true ] || "${dc[@]}" start "$service" >/dev/null 2>&1
  done
  wait_healthy postgres 60; wait_healthy rabbitmq 90; wait_healthy consul 60
  rmq_delete "queues/%2F/e8t7.tap"
  docker rm -fv e8t7-inventory e8t7-pg >/dev/null 2>&1
  docker network rm e8t7-net >/dev/null 2>&1
  if [ -s "$orders_file" ]; then
    log "cancelling $(wc -l <"$orders_file" | tr -d ' ') K14 order(s): $(drive cancel $(cat "$orders_file") 2>&1 | tail -1)"
  fi
  if [ -n "$stock_before" ]; then
    local quantity reserved i
    quantity=$(echo "$stock_before" | jget 'd["quantity"]'); reserved=$(echo "$stock_before" | jget 'd["reserved"]')
    for i in $(seq 1 30); do # reservations come back after order.cancelled (Inventory)
      [ "$(drive stock "$PRODUCT" | jget 'd["reserved"]')" = "$reserved" ] && break
      sleep 1
    done
    log "stock of $PRODUCT restored: $(drive set-stock "$PRODUCT" "$quantity")"
  fi
  wait_stack_healthy 120 || log "WARNING: not every service is healthy after the restore"
  rm -rf "$work"
}
on_signal() { log "interrupted ($1), restoring"; restore; exit "$2"; }
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap restore EXIT

# --- preconditions and the state before ------------------------------------------------------------------------
log "K14 resilience automata, cases: ${cases[*]}"
log "memory: $(docker stats --no-stream --format '{{.MemUsage}}' | awk '{gsub("MiB","",$1); gsub("GiB","*1024",$1); s+=$1} END {printf "%.0f MiB used by containers", s}' 2>/dev/null)"
if ! wait_stack_healthy 5; then
  log "precondition failed: not every service of the stack is healthy"; stack_state | awk '$3 != "healthy"'
  exit 2
fi
state_before=$(stack_state)
queues_before=$(queues)
passing_before=$(passing)
log "stack: $(echo "$state_before" | wc -l | tr -d ' ') services healthy; queues: $(echo "$queues_before" | tr '\t\n' ' ;')"
log "Consul passing: $passing_before"
stock_before=$(drive stock "$PRODUCT")
if [ "$(echo "$stock_before" | jget 'd["code"]')" != 200 ]; then
  log "precondition failed: no stock of $PRODUCT, run bash postman/run.sh compose first"; stock_before=""; exit 2
fi
log "stock of $PRODUCT before: $stock_before; +60 for the run: $(drive set-stock "$PRODUCT" "$(( $(echo "$stock_before" | jget 'd["quantity"]') + 60 ))")"
# One real customer (registration through the shop entrance, no login): its purchases end with e-mails.
email="e8t7-k14-$(date +%s)-$RANDOM@example.com"
# The password is never used again (no login): random, sent on stdin (printf is a shell builtin, so it is not in
# the argument list of any process).
customer=$(printf '{"email": "%s", "password": "%s", "firstName": "K14", "lastName": "Test"}' "$email" "$(random_secret)" |
  curl -s -X POST "$SHOP/auth/register" -H 'Content-Type: application/json' --data-binary @- | jget 'd.get("id", "")')
log "customer $email id=$customer"
buy_as() { # buy_as <user> -> JSON; remembers the order for the cancellation
  local out
  out=$(drive buy-as "$1" "$PRODUCT")
  echo "$out" | jget '"\n".join(f"{u}:{o}" for u, o in d["orders"])' >>"$orders_file"
  echo "$out"
}

# --- 1. old Inventory database ----------------------------------------------------------------------------------
case_olddb() {
  log "== olddb: tables of the old Inventory code (product_id BIGINT) in a separate database e8t7-pg -> image inventory-service:dev"
  docker network create e8t7-net >/dev/null
  # Random passwords of this run: only in environment variables of docker (-e NAME without a value takes it from
  # the environment, so the value is not in the command line) and in the containers.
  local INVENTORY_DB_PASSWORD
  INVENTORY_DB_PASSWORD=$(random_secret)
  POSTGRES_PASSWORD=$(random_secret) INVENTORY_DB_PASSWORD=$INVENTORY_DB_PASSWORD \
    docker run -d --name e8t7-pg --network e8t7-net -e POSTGRES_PASSWORD -e INVENTORY_DB_PASSWORD \
    -v "$here/old-inventory.sql:/docker-entrypoint-initdb.d/01.sql:ro" postgres:17-alpine >/dev/null
  local i
  for i in $(seq 1 60); do docker exec e8t7-pg pg_isready -U postgres -d inventory_db >/dev/null 2>&1 && break; sleep 1; done
  sleep 2 # the init script runs on a temporary server first
  for i in $(seq 1 30); do docker exec e8t7-pg psql -U postgres -d inventory_db -tAc 'select 1 from inventory_items limit 1' 2>/dev/null | grep -q 1 && break; sleep 1; done
  # old-inventory.sql creates the role without a password; it is set here from the variable of the container
  # (psql variable :'pw' on stdin, so no literal and no value on the host).
  echo "ALTER ROLE inventory_service PASSWORD :'pw';" |
    docker exec -i e8t7-pg sh -c 'psql -U postgres -q -v ON_ERROR_STOP=1 -v pw="$INVENTORY_DB_PASSWORD"'
  psqlq() { docker exec e8t7-pg psql -U postgres -d inventory_db -tAc "$1"; }
  local sums_before tables_before
  tables_before=$(psqlq "select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname='public'")
  sums_before=$(psqlq "select md5(string_agg(t::text, ',')) from (select * from inventory_items order by 1) t")/$(psqlq "select md5(string_agg(t::text, ',')) from (select * from reservations order by 1) t")
  log "old database: tables=$tables_before, product_id type=$(psqlq "select data_type from information_schema.columns where table_name='inventory_items' and column_name='product_id'")"
  DATABASE_URL="postgresql+psycopg2://inventory_service:$INVENTORY_DB_PASSWORD@e8t7-pg:5432/inventory_db" \
    docker run -d --name e8t7-inventory --network e8t7-net -p 127.0.0.1:18784:8084 --read-only --tmpfs /tmp --cap-drop ALL \
    -e DATABASE_URL -e CONSUL_ENABLED=false -e RABBITMQ_HOST= -e INSTANCE_ID=e8t7-inventory-1 inventory-service:dev >/dev/null
  local ready=000
  for i in $(seq 1 60); do ready=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18784/health/ready); [ "$ready" = 200 ] && break; sleep 0.5; done
  local p=3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77 o=5b8e2f1a-3c4d-4e6f-8a9b-0c1d2e3f4a5b put get res
  put=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'X-User-Id: e8700000-0000-4000-8000-000000000001' -H 'X-User-Roles: ADMIN' \
    -H 'Content-Type: application/json' -d '{"quantity": 10}' "http://127.0.0.1:18784/inventory/$p")
  get=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:18784/inventory/$p")
  res=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-User-Id: e8700000-0000-4000-8000-000000000002' -H 'X-User-Roles: CUSTOMER,SERVICE' \
    -H 'Content-Type: application/json' -d "{\"orderId\": \"$o\", \"items\": [{\"productId\": \"$p\", \"quantity\": 3}]}" http://127.0.0.1:18784/inventory/reservations)
  local tables_after sums_after types
  tables_after=$(psqlq "select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname='public'")
  sums_after=$(psqlq "select md5(string_agg(t::text, ',')) from (select * from inventory_items order by 1) t")/$(psqlq "select md5(string_agg(t::text, ',')) from (select * from reservations order by 1) t")
  types=$(psqlq "select table_name||'.'||column_name||'='||data_type||coalesce('('||character_maximum_length||')','') from information_schema.columns where column_name='product_id' order by 1" | tr '\n' ' ')
  log "ready=$ready PUT=$put GET=$get reservation=$res; tables after: $tables_after; product_id: $types; old rows md5 before/after: $sums_before = $sums_after"
  log "log lines: $(docker logs e8t7-inventory 2>&1 | wc -l | tr -d ' '), warning/error: $(docker logs e8t7-inventory 2>&1 | grep -cE '"level": "(warning|error)"')"
  docker rm -fv e8t7-inventory e8t7-pg >/dev/null; docker network rm e8t7-net >/dev/null
  if [ "$ready/$put/$get/$res" = 200/200/200/201 ] && [ "$sums_before" = "$sums_after" ] && [[ "$tables_after" == *stock_items*stock_reservations* ]]; then
    record olddb PASS "old tables kept (md5 equal), stock_items/stock_reservations created; ready 200, PUT 200, GET 200, reservation 201"
  else
    record olddb FAIL "ready=$ready PUT=$put GET=$get reservation=$res tables=$tables_after md5 $sums_before vs $sums_after"
  fi
}

# --- 2. RabbitMQ restart ----------------------------------------------------------------------------------------
case_rabbit() {
  log "== rabbit: restart of RabbitMQ; consumers of $QUEUES back within 30 s; a purchase afterwards ends with an e-mail"
  local start up i q all t back="" mails0
  "${dc[@]}" restart rabbitmq >/dev/null 2>&1
  start=$(date +%s)
  wait_healthy rabbitmq 90 || { record rabbit FAIL "RabbitMQ not healthy after restart"; return; }
  up=$(date +%s)
  log "RabbitMQ healthy $((up - start)) s after the restart command"
  for i in $(seq 1 60); do
    all=1
    for q in $QUEUES; do
      if [ "$(consumers_of "$q")" = 1 ]; then
        [[ "$back" == *"$q="* ]] || back="$back $q=$(( $(date +%s) - up ))s"
      else
        all=0
      fi
    done
    [ "$all" = 1 ] && break
    sleep 1
  done
  t=$(( $(date +%s) - up ))
  log "consumers=1 per queue (seconds after healthy):$back; all after ${t} s"
  mails0=$(mails "$email" 'Potwierdzenie zamówienia')
  local purchase status sent=""
  purchase=$(buy_as "$customer")
  status=$(echo "$purchase" | jget 'list(d["statuses"])[0]')
  log "purchase after the restart: $purchase"
  for i in $(seq 1 30); do
    [ "$(mails "$email" 'Potwierdzenie zamówienia')" -gt "$mails0" ] && { sent=$i; break; }
    sleep 1
  done
  if [ "$all" = 1 ] && [ "$t" -le 30 ] && [ "$status" = PAID ] && [ -n "$sent" ]; then
    record rabbit PASS "consumers back after ${t} s ($back ); purchase PAID, confirmation e-mail after ~${sent} s"
  else
    record rabbit FAIL "consumers all=$all after ${t} s ($back ); purchase $status; e-mail ${sent:-none in 30 s}"
  fi
}

# --- 3. Postgres outage 20 s (stop, pause) with events in flight ---------------------------------------------------
# Order and Shipping share the Postgres container, so the whole server goes away (stop, then separately pause);
# order_db and shipping_db are both cut. Events in flight: the real order.created and shipment.status_changed of a
# purchase, captured in the temporary queue e8t7.tap and published again with the same eventId during the outage
# (duplicates: the consumers need their database for the idempotency check, the effect is a no-op afterwards).
case_db() {
  log "== db: Postgres stop 20 s and pause 20 s, duplicates of real events published during the outage -> 0 in the DLQs"
  # Durable classic queue: RabbitMQ 4 refuses transient non-exclusive queues. Removed right after the capture.
  log "tap queue e8t7.tap: $( { echo '{"durable": true, "auto_delete": false, "arguments": {"x-queue-type": "classic"}}' | rmq_api PUT "queues/%2F/e8t7.tap" >/dev/null; } 2>&1 )"
  local key
  for key in order.created shipment.status_changed; do
    log "binding $key: $( { echo "{\"routing_key\": \"$key\"}" | rmq_api POST "bindings/%2F/e/shop.events/q/e8t7.tap" >/dev/null; } 2>&1 )"
  done
  buy_as "$customer" >"$work/db-purchase.json"
  log "purchase for the captured events: $(cat "$work/db-purchase.json")"
  local i
  for i in $(seq 1 20); do [ "$(queues | awk '$1 == "e8t7.tap" {print $2}')" -ge 2 ] 2>/dev/null && break; sleep 0.5; done
  echo '{"count": 10, "ackmode": "ack_requeue_false", "encoding": "auto"}' | rmq_api POST "queues/%2F/e8t7.tap/get" >"$work/tap.json"
  rmq_delete "queues/%2F/e8t7.tap"
  python3 - "$work/tap.json" "$work" <<'PY'
import json, sys
messages = json.load(open(sys.argv[1]))
for m in messages:
    body = json.loads(m["payload"])
    name = f'{sys.argv[2]}/event-{m["routing_key"]}.json'
    json.dump({"properties": {"content_type": "application/json", "delivery_mode": 2, "message_id": body["eventId"],
               "type": body["type"]}, "routing_key": m["routing_key"], "payload": m["payload"], "payload_encoding": "string"},
              open(name, "w"))
    print(f'captured {m["routing_key"]} eventId={body["eventId"]}')
PY
  local events=("$work"/event-*.json)
  if [ ${#events[@]} -lt 2 ]; then record db FAIL "tap queue did not capture order.created and shipment.status_changed"; return; fi
  local mode dlq_before dlq_after waited ok=1 summary=""
  for mode in stop pause; do
    dlq_before=$(dlq_counts)
    if [ "$mode" = stop ]; then "${dc[@]}" stop -t 5 postgres >/dev/null 2>&1; else "${dc[@]}" pause postgres >/dev/null 2>&1; fi
    local cut=$(date +%s)
    : >"$work/routed"
    publish_all() { local f; for f in "${events[@]}"; do rmq_api POST "exchanges/%2F/shop.events/publish" <"$f" 2>/dev/null >>"$work/routed"; echo >>"$work/routed"; done; }
    for i in 1 2 3; do publish_all; done
    sleep 10
    for i in 1 2 3; do publish_all; done
    while [ $(( $(date +%s) - cut )) -lt 20 ]; do sleep 1; done
    log "$mode: in flight during the outage: $(queues | awk '$1 ~ /^(order|shipping)\.q$/ {printf "%s messages=%s unacked=%s; ", $1, $2, $3}')"
    if [ "$mode" = stop ]; then "${dc[@]}" start postgres >/dev/null 2>&1; else "${dc[@]}" unpause postgres >/dev/null 2>&1; fi
    wait_healthy postgres 60
    for waited in $(seq 1 120); do
      queues | awk '$1 ~ /\.q$/ && ($2 != 0 || $3 != 0)' | grep -q . || break
      sleep 1
    done
    dlq_after=$(dlq_counts)
    log "$mode: queues empty ${waited} s after the database came back; DLQ before: $dlq_before after: $dlq_after"
    wait_stack_healthy 90 || log "$mode: WARNING not healthy: $(stack_state | awk '$3 != "healthy" {print $1}' | tr '\n' ' ')"
    [ "$dlq_before" = "$dlq_after" ] && [ "$waited" -lt 120 ] || ok=0
    log "$mode: published $(grep -c '"routed":true' "$work/routed") duplicates, routed"
    summary="$summary $mode: $(grep -c '"routed":true' "$work/routed") duplicates routed (6 x ${#events[@]} events), queues drained after ${waited} s, DLQ unchanged=$([ "$dlq_before" = "$dlq_after" ] && echo yes || echo NO);"
  done
  if [ "$ok" = 1 ]; then record db PASS "$summary"; else record db FAIL "$summary"; fi
}

# --- 4. 20 purchases at once ------------------------------------------------------------------------------------
case_parallel() {
  log "== parallel: 20 purchases of 20 customers at once (directly to order-service), every answer within 10 s"
  local out
  out=$(drive parallel 20 "$PRODUCT")
  echo "$out" | jget '"\n".join(f"{u}:{o}" for u, o in d["orders"])' >>"$orders_file"
  log "result: $(echo "$out" | jget '{k: d[k] for k in ("cart", "codes", "statuses", "maxS")}'); times: $(echo "$out" | jget 'sorted(d["times"])')"
  if [ "$(echo "$out" | jget 'd["codes"] == {"201": 20} and d["statuses"] == {"PAID": 20} and d["maxS"] <= 10')" = True ]; then
    record parallel PASS "20 x 201 PAID, slowest answer $(echo "$out" | jget 'd["maxS"]') s"
  else
    record parallel FAIL "$(echo "$out" | jget '{k: d[k] for k in ("codes", "statuses", "maxS")}')"
  fi
}

# --- 5. Consul down 15 s ----------------------------------------------------------------------------------------
case_consul() {
  log "== consul: Consul stopped 15 s; purchases (Order: last known list) and the catalog through the API Gateway work"
  local during after catalog cut i passing_now warm
  # Warm-up purchase: Order must have looked the services up once (a running shop always has). A service restarted
  # just before has no last known list and answers 503 NoInstances without Consul — correct per D13, not tested here.
  warm=$(drive buy 1 "$PRODUCT")
  echo "$warm" | jget '"\n".join(f"{u}:{o}" for u, o in d["orders"])' >>"$orders_file"
  log "warm-up purchase before the outage: $(echo "$warm" | jget 'd["codes"]')"
  "${dc[@]}" stop consul >/dev/null 2>&1
  cut=$(date +%s)
  during=$(drive buy 3 "$PRODUCT")
  echo "$during" | jget '"\n".join(f"{u}:{o}" for u, o in d["orders"])' >>"$orders_file"
  catalog=$(curl -s -o /dev/null -w '%{http_code}' "$SHOP/products?size=5")
  log "during the outage: purchases $(echo "$during" | jget '{k: d[k] for k in ("codes", "statuses", "maxS")}'), catalog through the Gateway $catalog"
  while [ $(( $(date +%s) - cut )) -lt 15 ]; do sleep 1; done
  "${dc[@]}" start consul >/dev/null 2>&1
  wait_healthy consul 60
  after=$(drive buy 3 "$PRODUCT")
  echo "$after" | jget '"\n".join(f"{u}:{o}" for u, o in d["orders"])' >>"$orders_file"
  log "after the return: purchases $(echo "$after" | jget '{k: d[k] for k in ("codes", "statuses", "maxS")}')"
  for i in $(seq 1 60); do passing_now=$(passing); [ "$passing_now" = "$passing_before" ] && break; sleep 1; done
  log "Consul passing after ${i} s: $passing_now"
  if [ "$(echo "$during" | jget 'd["codes"] == {"201": 3}')" = True ] && [ "$(echo "$after" | jget 'd["codes"] == {"201": 3}')" = True ] \
    && [ "$catalog" = 200 ] && [ "$passing_now" = "$passing_before" ]; then
    record consul PASS "3/3 purchases 201 and catalog 200 during the outage, 3/3 purchases 201 after it (0 x 503), registrations back after ${i} s"
  else
    record consul FAIL "during $(echo "$during" | jget 'd["codes"]') catalog $catalog, after $(echo "$after" | jget 'd["codes"]'), Consul: $passing_now"
  fi
}

# --- 6. database URL with a typo --------------------------------------------------------------------------------
# A one-off container of the service image with the stack environment (dc run --no-deps), Consul and broker off.
# The URL with the real password is built and compared inside the container; only counts and log lines without
# the password come out (the lines are printed only when the count is 0).
case_dburl() {
  log "== dburl: database URL with a typo (format and host) -> the password never appears in the log (secret_count 0)"
  local ok=1 out
  # shellcheck disable=SC2016  # expanded inside the container
  local scan='
    for variant in format host; do
      url=$(build "$variant")
      eval "export $VAR=\"\$url\""
      timeout -k 5 40 uvicorn app.main:app --host 127.0.0.1 --port 18799 --no-access-log >/tmp/e8t7.log 2>&1; rc=$?
      n=$(printf "%s\n" "$SECRET" | grep -c -F -f - /tmp/e8t7.log)
      echo "$variant: exit=$rc lines=$(wc -l </tmp/e8t7.log) secret_count=$n"
      [ "$n" = 0 ] && grep -v "^$" /tmp/e8t7.log | tail -2 | cut -c1-220 | sed "s/^/    /"
    done'
  # Inventory: DATABASE_URL of the stack.
  out=$("${dc[@]}" run --rm --no-deps -T --name e8t7-dburl-inventory -e CONSUL_ENABLED=false -e RABBITMQ_HOST= \
    --entrypoint sh inventory-service -c '
      SECRET=$(python -c "import os; from sqlalchemy.engine import make_url; print(make_url(os.environ[\"DATABASE_URL\"]).password)")
      orig=$DATABASE_URL; VAR=DATABASE_URL
      build() { if [ "$1" = format ]; then printf %s "$orig" | sed "s#://#//#"; else printf %s "$orig" | sed "s#@postgres:#@postgress:#"; fi; }
      '"$scan" 2>&1)
  log "inventory-service:"; echo "$out"
  echo "$out" | grep -q 'secret_count=0' && ! echo "$out" | grep -qE 'secret_count=[1-9]' || ok=0
  [ "$(echo "$out" | grep -c 'secret_count=0')" = 2 ] || ok=0
  # Order and Shipping: DB_URL (optional) built from DB_HOST and the password of the stack.
  local service user db secret_var
  for service in order-service shipping-service; do
    user=${service%-service}_service; db=${service%-service}_db
    secret_var=$(echo "${service%-service}" | tr '[:lower:]' '[:upper:]')_DB_PASSWORD
    out=$("${dc[@]}" run --rm --no-deps -T --name "e8t7-dburl-$service" -e CONSUL_ENABLED=false -e BROKER_ENABLED=false \
      --entrypoint sh "$service" -c '
        SECRET=$'"$secret_var"'; VAR=DB_URL
        build() { if [ "$1" = format ]; then printf "postgresql+psycopg//'"$user"':%s@%s/'"$db"'" "$SECRET" "$DB_HOST"
                  else printf "postgresql+psycopg://'"$user"':%s@postgress/'"$db"'" "$SECRET"; fi; }
        '"$scan" 2>&1)
    log "$service:"; echo "$out"
    ! echo "$out" | grep -qE 'secret_count=[1-9]' || ok=0
    [ "$(echo "$out" | grep -c 'secret_count=0')" = 2 ] || ok=0
  done
  if [ "$ok" = 1 ]; then
    record dburl PASS "Inventory DATABASE_URL, Order and Shipping DB_URL, 2 variants each (format, host): secret_count 0 in 6/6"
  else
    record dburl FAIL "secret_count other than 0 or a variant did not run (lines above)"
  fi
}

for name in "${cases[@]}"; do
  case "$name" in
    olddb | rabbit | db | parallel | consul | dburl) "case_$name" ;;
    *) log "unknown case $name"; record "$name" FAIL "unknown case" ;;
  esac
done

restore
trap - EXIT INT TERM
state_after=$(stack_state)
queues_after=$(queues)
if [ "$state_before" = "$state_after" ] && [ "$queues_before" = "$queues_after" ]; then
  record state PASS "dc ps and queues (messages, unacked, consumers) as before: $(echo "$state_after" | wc -l | tr -d ' ') services, $(echo "$queues_after" | wc -l | tr -d ' ') queues"
else
  record state FAIL "differs from before"
  diff <(echo "$state_before"; echo "$queues_before") <(echo "$state_after"; echo "$queues_after")
fi

echo
echo "K14 $(date '+%F %T') — case     result details"
printf '%s\n' "${table[@]}"
failed=$(printf '%s\n' "${table[@]}" | awk '$2 != "PASS"' | wc -l | tr -d ' ')
echo "RESULT: $([ "$failed" = 0 ] && echo PASSED || echo FAILED) — ${#table[@]} rows, failed $failed; file: ${result_file#"$repo"/}"
[ "$failed" = 0 ]
