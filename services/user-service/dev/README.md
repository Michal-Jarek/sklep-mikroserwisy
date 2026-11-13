# Izolowany zestaw User + Cart

Ten zestaw uruchamia obie usługi, osobny PostgreSQL, Redis i Consul. Nie zawiera Auth, Gateway, Product ani Inventory. Nie uruchamiaj go równocześnie ze wspólną infrastrukturą na tych samych portach.

```sh
cd services/user-service
cp .env.example .env
# Ustaw DB_PASSWORD w .env.
docker compose --env-file .env -f dev/compose.yaml up -d --build
```

Wspólne repo ma infrastrukturę w `deploy/`. Wpięcie kontenerów User/Cart i ustawienie `USER_SERVICE_ENABLED=true` po stronie Auth zostawiono właścicielowi wspólnej konfiguracji — ten PR zmienia tylko `services/user-service/` i `services/cart-service/`.
