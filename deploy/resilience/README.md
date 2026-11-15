# Automaty odporności etapu 8 (K14)

Regresja hipotez z przeglądów PR #17 (Order, Shipping) i #18 (Inventory) na stosie compose `sklep` (profil `full-shop`): odporność na restart RabbitMQ, przerwę bazy, równoległe zakupy, przerwę Consula, starą bazę Inventory i błędny adres bazy.

## Uruchomienie

Z katalogu głównego repo:

```bash
bash deploy/resilience/run.sh                 # wszystkie przypadki, ok. 6–8 min
bash deploy/resilience/run.sh rabbit consul   # wybrane przypadki
```

Wynik: tabela `PASS`/`FAIL` na końcu wyjścia, linia `RESULT: PASSED|FAILED — …`, kod 0 tylko przy samych `PASS`. To samo wyjście trafia do `deploy/resilience/results/<czas UTC>.txt` (katalog ignorowany przez git, `.gitignore` obok).

**Wymagany stan:** stos `sklep` uruchomiony, wszystkie usługi `healthy` (inaczej kod 2 bez zmian w stosie); stany produktów startowych ustawione (`bash postman/run.sh compose` — przypadki kupują produkt `a0000000-0000-4000-8000-000000000005`). Obrazy `:dev` nie są przebudowywane. Potrzebne `docker`, `curl`, `python3` i obraz `python:3.12-slim`.

**W tym czasie nic innego na compose** (scenariusz, E2E, `resilience-demo.sh`): automaty restartują RabbitMQ, zatrzymują i wstrzymują Postgresa i zatrzymują Consula.

## Przypadki

| Przypadek | Co robi | PASS, gdy |
|---|---|---|
| `olddb` | Osobny Postgres `e8t7-pg` z tabelami starego kodu Inventory (`inventory_items`, `reservations`, `product_id BIGINT`, po 1 wierszu — `old-inventory.sql`, schemat tabel starego kodu) i kontener `e8t7-inventory` z obrazu `inventory-service:dev` (Consul i broker wyłączone). Wspólnej `inventory_db` nie dotyka | `/health/ready` 200, `PUT`/`GET /inventory/<uuid>` 200, rezerwacja 201, nowe tabele `stock_items`/`stock_reservations` (`varchar(36)`), stare tabele nietknięte (md5 wierszy przed = po) |
| `rabbit` | `docker compose restart rabbitmq`, potem zakup klienta K14 | `consumers=1` na `inventory.q`, `order.q`, `shipping.q`, `notification.q` najpóźniej 30 s po `healthy` brokera; zakup `PAID` i e-mail „Potwierdzenie zamówienia” w Mailpit w 30 s |
| `db` | Kolejka podsłuchu `e8t7.tap` łapie prawdziwe `order.created` i `shipment.status_changed` jednego zakupu. Potem osobno `stop` i `pause` kontenera Postgres na 20 s; w trakcie te dwa zdarzenia są wysyłane ponownie (ten sam `eventId`, 6 razy: 3 na początku, 3 po 10 s). `order_db` i `shipping_db` są w jednym Postgresie, więc odcięcie dotyczy całego serwera (jak K5c T2/T3) | po powrocie bazy kolejki `*.q` puste (ponowienia odbiorców po 5 s i 30–45 s), liczba wiadomości we wszystkich `*.dlq` bez zmian, stos `healthy` |
| `parallel` | 20 nowych klientów (losowe UUID), każdy z 1 sztuką w koszyku, 20 × `POST /orders` naraz | 20 × 201 `PAID`, najwolniejsza odpowiedź ≤ 10 s |
| `consul` | zakup rozgrzewający (Order zna już listy instancji — świeżo uruchomiony Order bez listy odpowiada 503 `NoInstances`, zgodnie z D13), potem `docker compose stop consul` na 15 s: 3 zakupy i `GET /api/v1/products` przez Gateway w trakcie, 3 zakupy po powrocie | 3/3 × 201 i katalog 200 w trakcie, 3/3 × 201 po powrocie (0 × 503), rejestracje w Consulu jak przed testem |
| `dburl` | Jednorazowy kontener obrazu usługi ze środowiskiem stosu (`docker compose run --no-deps`, Consul i broker wyłączone). W kontenerze adres bazy z literówką: zły format (`//` zamiast `://`) i zły host (`postgress`) — Inventory `DATABASE_URL`, Order i Shipping `DB_URL` (z `DB_HOST` i hasła stosu) | `secret_count` = 0 we wszystkich 6 logach (hasło porównywane w kontenerze, na ekran tylko liczba i 2 ostatnie linie logu, gdy liczba = 0) |
| `state` (zawsze na końcu) | porównanie `docker compose ps` i `rabbitmqctl list_queues name messages messages_unacknowledged consumers` z chwilą przed testem | to samo przed i po |

Zakupy idą prosto do usług w sieci `sklep_backend` (kontener `python:3.12-slim` z `driver.py`) z nagłówkami, które ustawia Gateway (`X-User-Id`, `X-User-Roles: CUSTOMER`, `X-Request-Id`) — bez logowania, więc bez limitu 5 logowań na minutę. Jeden klient K14 (`e8t7-k14-…@example.com`) jest rejestrowany przez wejście sklepu, żeby e-maile miały adresata; jego hasło i hasła kontenerów `e8t7-pg` i `e8t7-inventory` są losowe w każdym przebiegu (nie trafiają na ekran ani do `results/`, w plikach nie ma żadnego hasła); klienci przypadku `parallel` nie istnieją w User (Notification pomija e-mail po 404 z User — tak działa usługa).

## Co skrypt przywraca (także po błędzie, Ctrl+C i `kill`)

`trap` na EXIT/INT/TERM: `unpause`/`start` Postgresa, RabbitMQ i Consula, jeśli nie działają; usunięcie kolejki `e8t7.tap`, kontenerów `e8t7-inventory`, `e8t7-pg` i sieci `e8t7-net`; anulowanie wszystkich zamówień K14 (rezerwacje wracają przez `order.cancelled`); stan produktu `…0005` = wartość sprzed testu (skrypt dodaje na czas testu 60 sztuk). Na końcu czeka, aż wszystkie usługi będą `healthy`.

Po `kill -9` (albo zatrzymaniu zadania w tle przez narzędzie, które zabija twardo) pułapka się nie wykona. Wtedy ręcznie:

```bash
dc=(docker compose -p sklep -f deploy/compose.yaml --profile full-shop)
"${dc[@]}" unpause postgres 2>/dev/null; "${dc[@]}" start postgres rabbitmq consul
docker rm -fv e8t7-inventory e8t7-pg $(docker ps -aq --filter name=e8t7-dburl) 2>/dev/null; docker network rm e8t7-net 2>/dev/null
"${dc[@]}" exec -T rabbitmq sh -c 'wget -q -O - --method=DELETE --header "Authorization: Basic $(printf %s "admin:$RABBITMQ_DEFAULT_PASS" | base64)" http://127.0.0.1:15672/api/queues/%2F/e8t7.tap'
docker run --rm --network sklep_backend -v "$PWD/deploy/resilience:/r:ro" python:3.12-slim \
  python /r/driver.py set-stock a0000000-0000-4000-8000-000000000005 25
```

Zamówienia K14 z przerwanego przebiegu zostają wtedy `PAID` (rezerwacje na `…0005`); `S11` scenariusza i tak ustawia `quantity` = 25 + `reserved`.

## Pliki

| Plik | Po co |
|---|---|
| `run.sh` | przypadki, przywracanie stanu, tabela wyników |
| `driver.py` | wywołania HTTP w sieci `sklep_backend` (stan magazynu, zakupy pojedyncze i równoległe, anulowanie); tylko biblioteka standardowa |
| `old-inventory.sql` | stara `inventory_db` dla `olddb` (rola bez hasła; hasło ustawia `run.sh`) |
| `.gitignore` | wyklucza `results/` z gita |
| `results/` | wyniki przebiegów (tworzone przy pierwszym uruchomieniu, poza gitem) |
