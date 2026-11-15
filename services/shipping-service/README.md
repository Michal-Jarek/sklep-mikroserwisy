# Shipping Service

Przesyłki zamówień, historia ich statusów i cennik metod dostawy.

| | |
|---|---|
| Właściciel | Piotr (`Piotr210203`) |
| Technologia | Python 3.12 · FastAPI · PostgreSQL · RabbitMQ |
| Port | 8089 |
| Nazwa w Consulu, Kubernetesie i obrazie Docker | `shipping-service` |
| Namespace Kubernetes | `shop` |
| Health checki | `/health/live`, `/health/ready` |
| Dokumentacja API | `/docs` |

## Zakres

Usługa przechowuje w PostgreSQL (`shipping_db`, konto `shipping_service`, tabele `shipments`, `shipping_history`, `shipping_processed`, `shipping_outbox`) przesyłki i historię ich statusów. Przesyłka powstaje ze zdarzenia `order.created` w stanie `PREPARING` (albo od razu `CANCELLED`, gdy zamówienie anulowano, zanim zdarzenie dotarło — niżej); administrator przesuwa ją o jeden krok naprzód: `SHIPPED` (wtedy powstaje lokalny numer śledzenia), `IN_TRANSIT`, `DELIVERED`. Przed nadaniem przesyłkę anuluje Order (`POST /shipments/cancel` albo zdarzenie `order.cancelled`).

| Metoda | Ścieżka | Kto | Znaczenie |
|---|---|---|---|
| GET, HEAD | `/shipping/methods` | publiczny | Cennik: `code`, `name`, `price` (tekst), `currency`, `estimatedDays`. Kurier 14.99 PLN (`COURIER_COST`), paczkomat 9.99 PLN, odbiór osobisty 0.00 PLN |
| GET, HEAD | `/shipping/methods/{code}` | publiczny (woła Order) | Jedna metoda; nieznany kod → 404 |
| GET | `/shipments` | zalogowany | Strona przesyłek; opcjonalnie `orderId`, `status`, `page` (od 1), `size` (1–100). ADMIN widzi wszystkie, klient tylko swoje (cudze `orderId` → pusta strona) |
| GET | `/shipments/{shipmentId}` | właściciel albo ADMIN | Szczegóły z historią i numerem śledzenia; cudza albo nieistniejąca przesyłka → 404 |
| PATCH | `/shipments/{shipmentId}/status` | ADMIN | `{"status": "SHIPPED"}`; tylko następny krok, inaczej 409 `INVALID_STATUS_TRANSITION` (także powtórzenie tego samego statusu) |
| POST | `/shipments/cancel` | SERVICE (Order) — **wewnętrzny** | `{"orderId": "<uuid>"}` → 200 `{"orderId", "shipmentId", "status": "CANCELLED"}` albo 409; Gateway blokuje go z zewnątrz (404) |

Błędy mają format `{"status", "error", "message", "requestId"}` (400 zamiast 422 przy złych danych, nieznane pola w treści → 400), a każda odpowiedź ma nagłówki `X-Request-Id` i `X-Instance-Id`. Gateway udostępnia endpointy pod `/api/v1/...`, usługa widzi ścieżki bez prefiksu. Kontrakt dla frontendu: [frontend-api.md](../../docs/frontend-api.md#shipping).

### Anulowanie przed nadaniem (`POST /shipments/cancel`)

Order woła ten endpoint, zanim anuluje zamówienie (rola `SERVICE` w `X-User-Roles`, także obok `CUSTOMER`/`ADMIN`; bez niej 403 `FORBIDDEN`). Shipping ufa wołającemu co do własności zamówienia — sprawdza ją Order. `orderId` musi być UUID (zapisywany małymi literami); zły UUID albo nieznane pole → 400 `VALIDATION_ERROR`. Wynik zależy od stanu przesyłki, ustalanego pod blokadą wiersza `shipments`:

| Stan przesyłki | Wynik |
|---|---|
| brak przesyłki | zapisane anulowanie bez przesyłki (zaślepka); 200, `shipmentId: null`. Późne `order.created` tworzy przesyłkę od razu jako `CANCELLED` i wysyła jedno `shipment.status_changed` (`oldStatus: null`, `newStatus: CANCELLED`) |
| `PREPARING` | `CANCELLED` + wpis historii + zdarzenie `shipment.status_changed` (`oldStatus: PREPARING`); 200 |
| `CANCELLED` | 200 bez nowego zdarzenia |
| `SHIPPED`, `IN_TRANSIT`, `DELIVERED` | 409 `INVALID_STATUS_TRANSITION` |

`PATCH /shipments/{id}/status` bierze tę samą blokadę wiersza, więc równoczesne anulowanie i nadanie paczki są szeregowane: wygrywa dokładnie jedno, drugie dostaje 409.

Zdarzenie przy późnym `order.created` jest potrzebne, gdy Shipping zatwierdził anulowanie, a Order nie zapisał wyniku (odpowiedź po ponad 2 s, utracona odpowiedź, błąd bazy Order). Order dostaje wtedy `shipment.status_changed` z `CANCELLED` i sam anuluje zamówienie; gdy zamówienie już jest `CANCELLED`, nic nie robi. Klient widzi przesyłkę „Anulowana” bez numeru śledzenia. Adres dostawy takiej przesyłki nie jest zapisywany. Równoczesne `POST /shipments/cancel` i `order.created` kończą się jednym z dwóch wyników: przesyłka `CANCELLED` z jednym zdarzeniem (`null → CANCELLED`) albo `PREPARING → CANCELLED` z dwoma zdarzeniami.

## Zdarzenia

Usługa odbiera z kolejki `shipping.q` zdarzenia `order.created` (nowa przesyłka `PREPARING`; po wcześniejszym anulowaniu — przesyłka `CANCELLED`) i `order.cancelled` (anulowanie przesyłki `PREPARING` albo zapamiętanie anulowania, jeśli przyszło przed `order.created`) oraz publikuje `shipment.status_changed` do exchange `shop.events` ([events.md](../../docs/events.md)):

- zdarzenie wychodzi już przy utworzeniu przesyłki (`oldStatus: null`, `newStatus: PREPARING`, a przy zamówieniu anulowanym wcześniej `newStatus: CANCELLED`) i przy każdej zmianie statusu; `trackingNumber` jest `null` do `SHIPPED`;
- `order.cancelled` dla przesyłki już nadanej (`SHIPPED` i dalej) nie zmienia stanu: wiadomość jest potwierdzana, a w logu pojawia się linia `error` („Cancellation inconsistency”). Przy anulowaniu przez `POST /shipments/cancel` to nie powinno wystąpić.

**Odbiorca** łączy się przez `connect_robust` (połączenie w panelu RabbitMQ nazywa się jak ID instancji) i sam wznawia połączenie po restarcie brokera. Kolejkę otwiera pasywnie (topologię zakłada platforma) i co 15 s sprawdza, czy istnieje: usunięta kolejka daje `warning` i ponowne połączenie co 5 s, aż kolejka wróci. Kopertę sprawdza przed skutkiem: `eventId` musi być UUID, `type` = klucz routingu, `version` 1; błędna koperta albo treść (np. `shippingCost` bez dwóch miejsc po przecinku) trafia od razu do `shipping.dlq` (`nack` bez ponowienia, jedna linia `error` z `eventId`). `requestId` niepasujący do `^[A-Za-z0-9._-]{1,64}$` nie odrzuca zdarzenia — usługa używa wtedy nowego UUID. Błąd chwilowy (np. baza niedostępna) jest ponawiany w procesie po 5 s i po 30 s (każdy odstęp z losowym dodatkiem do +50 %), więc krótka awaria bazy (do ok. 35 s) nie przenosi zdarzeń do DLQ; po trzeciej nieudanej próbie wiadomość trafia do `shipping.dlq` (log `error` z `eventId`, `type`, `requestId` i klasą wyjątku). Przetworzone `eventId` są zapisywane w tej samej transakcji co skutek (duplikat jest potwierdzany bez skutku).

**Przekaźnik outboxu** to osobne zadanie z osobnym połączeniem (`<ID instancji>-relay`) i potwierdzeniami publikacji. Zmiana statusu i zdarzenie zapisują się w jednej transakcji (`shipping_outbox`); przekaźnik co 0,5 s bierze do 10 wierszy w dzierżawę na 30 s (`locked_until`, `FOR UPDATE SKIP LOCKED`), publikuje je bez otwartej transakcji i usuwa wiersz po potwierdzeniu brokera (dostarczenie „co najmniej raz”). Błąd bazy albo brokera: `warning` i pauza 2–5 s — odbiorca działa dalej. Wiadomość, której broker nie przyjął (brak trasy), zostaje w outboxie (log `error`) i wraca po wygaśnięciu dzierżawy. Zaległość: `select count(*) from shipping_outbox`.

## Uruchomienie

### W całym sklepie (Docker Compose)

Z katalogu głównego repozytorium według [deploy/README.md](../../deploy/README.md):

```bash
bash deploy/create-secrets.sh
shop=(docker compose -f deploy/compose.yaml --profile full-shop)
"${shop[@]}" up -d --wait --build
"${shop[@]}" ps shipping-service
curl -fsS 'http://127.0.0.1:8500/v1/health/service/shipping-service?passing=true'
curl -fsS http://127.0.0.1:8090/api/v1/shipping/methods
"${shop[@]}" logs --tail=40 shipping-service
```

Usługa powinna mieć stan `healthy`, wynik Consula — niepustą tablicę, a cennik przez Gateway — trzy metody. Tabele tworzą się przy starcie (przy kilku instancjach naraz tworzy je jedna, pod blokadą doradczą). Hasła (`SHIPPING_DB_PASSWORD`, `SHIPPING_RABBITMQ_PASSWORD`) są w `deploy/.env`, konto brokera, exchange i kolejki zakłada platforma. Usługa nie publikuje portu na hoście: z zewnątrz tylko przez Gateway, w sieci `backend` pod `http://shipping-service:8089`.

W Kubernetesie usługę wdraża platforma (`deploy/k8s/services/shipping-service.yaml`, sekret `shipping-service-secret` z `deploy/k8s/secrets.sh`, całość `bash deploy/k8s/up.sh`). Plik `k8s/app.yaml` w tym folderze jest wzorem tego manifestu — nie aplikuj go w namespace `shop`.

### Przejście z wersji z PR #17

Baza `shipping_db` z tabelami pierwszej wersji (PR #17, `develop` przed etapem 8) naprawia się sama przy starcie. Pod tą samą blokadą doradczą co tworzenie tabel usługa wykonuje dwie idempotentne instrukcje: `ALTER TABLE shipping_outbox ADD COLUMN IF NOT EXISTS locked_until` i `ALTER TABLE shipments ALTER COLUMN user_id DROP NOT NULL`. Dane zostają, a wiersze outboxu ze starej wersji przekaźnik wysyła jak nowe. Bez tych zmian odbiór `order.created` kończył się błędem bazy i trafiał do `shipping.dlq`, przekaźnik stał, a `POST /shipments/cancel` bez przesyłki dawał 503 — przy `/health/ready` 200. Sprawdzenie po starcie (hasło rozwija powłoka w kontenerze `postgres`):

```bash
docker compose -f deploy/compose.yaml exec -T postgres sh -c 'PGPASSWORD="$SHIPPING_DB_PASSWORD" psql -h 127.0.0.1 -U shipping_service -d shipping_db -c "SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE column_name IN ('"'"'user_id'"'"', '"'"'locked_until'"'"')"'
```

Wynik: `shipments.user_id` i `shipping_outbox.locked_until` z `is_nullable = YES`.

### Z VS Code albo terminala (infrastruktura z compose)

Wymagany Python 3.12 (na macOS polecenie `python3`; w aktywnym `.venv` wystarczy `python`):

```bash
cd services/shipping-service
python3 -m venv .venv
source .venv/bin/activate            # PowerShell: .\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
export DB_HOST=127.0.0.1 SHIPPING_DB_PASSWORD='<hasło z deploy/.env>'
export RABBITMQ_HOST=127.0.0.1 RABBITMQ_PASSWORD='<SHIPPING_RABBITMQ_PASSWORD z deploy/.env>'
export CONSUL_URL=http://127.0.0.1:8500 SERVICE_ADDRESS=host.docker.internal
uvicorn app.main:app --host 127.0.0.1 --port 8089 --no-access-log
```

`SERVICE_ADDRESS=host.docker.internal`: Consul w kontenerze sprawdza `/health/ready` pod tym adresem. Bez Consula: `CONSUL_ENABLED=false`, bez brokera: `BROKER_ENABLED=false` (REST działa, zdarzeń nie ma). Zmienne można też wpisać do `.env` w tym folderze (wzór: `.env.example`, sam plik `.env` nie trafia do repozytorium ani do obrazu).

### Zmienne środowiskowe

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `DB_HOST` | `localhost` | Host PostgreSQL (baza `shipping_db`, konto `shipping_service`, port 5432) |
| `SHIPPING_DB_PASSWORD` | — | Hasło konta `shipping_service` (sekret) |
| `DB_URL` | — | Pełny adres SQLAlchemy zamiast trzech powyższych (np. inny port, testy); zawiera hasło. Zły format kończy start komunikatem „DB_URL has an invalid format” bez adresu |
| `RABBITMQ_HOST` | `localhost` | Host RabbitMQ |
| `RABBITMQ_PORT` | `5672` | Port RabbitMQ |
| `RABBITMQ_USER` | `shipping-service` | Konto RabbitMQ (odczyt `shipping.q`, publikacja `shipment.status_changed`) |
| `RABBITMQ_PASSWORD` | — | Hasło konta RabbitMQ (sekret; w compose `${SHIPPING_RABBITMQ_PASSWORD}`) |
| `CONSUL_URL` | `http://localhost:8500` | Adres Consula (rejestracja, KV) |
| `CONSUL_ENABLED` | `true` | `false` — bez rejestracji i bez KV |
| `BROKER_ENABLED` | `true` | `false` — bez odbiorcy i przekaźnika zdarzeń |
| `SERVICE_ADDRESS` | adres IP na trasie do Consula | Adres rejestrowany w Consulu (k8s: adres poda; na macOS z VS Code: `host.docker.internal`) |
| `INSTANCE_ID` | `shipping-service-<hostname>` | Pełne ID instancji w Consulu i nazwa połączenia z RabbitMQ (k8s: nazwa poda) |
| `LOG_LEVEL` | z KV albo `info` | `debug`, `info`, `warning`, `error`; ma pierwszeństwo przed `logLevel` z Consul KV |
| `COURIER_COST` | `14.99` | Cena kuriera (`^\d{1,6}\.\d{2}$`) |

Przy starcie usługa czyta z Consul KV klucz `config/shipping-service/data` (YAML, pole `logLevel`); start bez Consula jest dozwolony. Rejestruje się w Consulu jako `shipping-service` z health checkiem `/health/ready` co 10 s; stan początkowy checku (`passing` albo `critical`) wynika z bieżącej gotowości (to samo sprawdzenie bazy co `/health/ready`), także przy ponownej rejestracji po awarii bazy. Przy pierwszej rejestracji procesu usuwa wpisy o nazwie `shipping-service` z tym samym adresem i portem, ale innym ID (poprzedni kontener na tym samym IP; log „Removed an orphaned entry from Consul”), oraz wpis z własnym ID pozostawiony przez poprzedni proces (Consul zachowałby jego stan `critical`). Wpisów z innym adresem albo portem nie rusza; odmowa usunięcia jednego wpisu nie zatrzymuje pozostałych (jedno ostrzeżenie), a błędna odpowiedź Consula nie blokuje rejestracji. Co 15 s sprawdza swój wpis (po restarcie Consula rejestruje się ponownie), a przy zatrzymaniu się wyrejestrowuje.

### Zdrowie i logi

`/health/live` nie korzysta z bazy ani z brokera i odpowiada od razu. `/health/ready` sprawdza bazę (503, gdy niedostępna) i nie zależy od RabbitMQ — odbiorca ponawia połączenie sam. Gotowość ma też 503, gdy zadanie odbiorcy się zakończyło; odbiorca ponawia każdy błąd połączenia i brak kolejki, więc kończy się tylko przy błędzie programu (zostaje jako zabezpieczenie, z linią `error` w logu). Operacje przy niedostępnej bazie (odmowa połączenia, nowe połączenie po 2 s bez odpowiedzi) dają 503 „Baza przesyłek niedostępna”. `/health/ready` sprawdza bazę w osobnym wątku z limitem 1,5 s: baza, która nie odpowiada, daje 503 zamiast braku odpowiedzi. Połączenia z PostgreSQL mają TCP keepalive (5 s bezczynności, 2 próby co 2 s) i `tcp_user_timeout` 5 s, więc baza, która zniknęła z sieci, jest wykrywana w kilka sekund: przekaźnik i odbiorca dostają błąd i ponawiają, zamiast wisieć na starym połączeniu (po 30 s bez sieci zdarzenie wychodzi ok. 3 s po powrocie bazy). Usługa nie ma limitu czasu samego zapytania. Gdy serwer bazy jest zawieszony, ale jego system odpowiada na poziomie TCP (np. `docker pause`), czekają tylko operacje, które dostały bezczynne połączenie z puli (najwyżej kilka). Kolejne nie dostają nowego połączenia i po 2 s odpowiadają 503, a odbiorca idzie zwykłą ścieżką ponowień. Wiszące operacje wykonują się po powrocie bazy, także gdy wołający dawno zrezygnował (np. `POST /shipments/cancel` po 503 w Order — wtedy pomaga zdarzenie z późnego `order.created`, wyżej). `/health/live` odpowiada przez cały czas od razu.

Logi to jedna linia JSON na wpis na stdout: `time`, `level`, `service`, `requestId`, `userId`, `msg` (w odbiorcy także `eventId`, `type`). Każde żądanie HTTP (poza `/health/*`) daje jedną linię z metodą, ścieżką i kodem; błąd 500 — linię `error` z klasą wyjątku. Biblioteki (aio-pika, httpx, SQLAlchemy, uvicorn) logują tylko ostrzeżenia i błędy, wyjątki zawsze tylko jako klasa. W logach nie ma haseł, adresu dostawy ani adresów e-mail.

## Przykłady (nagłówki jak z Gateway)

Bezpośrednio do usługi — z VS Code (`http://127.0.0.1:8089`) albo z kontenera w sieci `backend` (`http://shipping-service:8089`). Nagłówki `X-User-*` ustawia normalnie Gateway; tutaj podaje się je ręcznie.

```bash
S=http://127.0.0.1:8089
CUSTOMER=11111111-0000-4000-8000-000000000001
curl -s $S/shipping/methods
curl -s "$S/shipments?page=1&size=5" -H "X-User-Id: $CUSTOMER" -H 'X-User-Roles: CUSTOMER'
curl -s -X PATCH $S/shipments/<shipmentId>/status -H 'X-User-Id: adadadad-0000-4000-8000-0000000000ad' \
  -H 'X-User-Roles: ADMIN' -H 'Content-Type: application/json' -d '{"status":"SHIPPED"}'
curl -s -X POST $S/shipments/cancel -H "X-User-Id: $CUSTOMER" -H 'X-User-Roles: CUSTOMER,SERVICE' \
  -H 'Content-Type: application/json' -d '{"orderId":"<orderId>"}'
```

Przesyłkę tworzy tylko zdarzenie `order.created`. Ręcznie można je wysłać poleceniem z [events.md](../../docs/events.md) („Wiersz poleceń w kontenerze”) z kluczem `order.created`.

## Pełny zakup przez sklep

Po zalogowaniu klient dodaje produkt do koszyka i składa zamówienie (`POST /api/v1/orders`, przykład w [kontrakcie Order](../../docs/frontend-api.md#order)). Po `PAID` koszyk jest pusty, a w ciągu kilku sekund pojawia się przesyłka `PREPARING` (`GET /api/v1/shipments?orderId=<id>`). Administrator nadaje paczkę (`PATCH /api/v1/shipments/{id}/status` z `SHIPPED`); po dotarciu zdarzenia Order pokazuje `SHIPPED` i odrzuca anulowanie (409 `ORDER_NOT_CANCELLABLE`). Anulowanie przed nadaniem (`POST /api/v1/orders/{id}/cancel`) zmienia przesyłkę na `CANCELLED`. Karta testowa kończąca się cyfrą 0 daje `PAYMENT_FAILED` — wtedy przesyłka nie powstaje. Cały przebieg sprawdza scenariusz z [postman/README.md](../../postman/README.md).

## Testy

Z katalogu `services/shipping-service`, po instalacji zależności deweloperskich:

```bash
python -m pytest -q
```

Testy w kontenerze (bez lokalnego Pythona, z katalogu głównego repozytorium):

```bash
docker run --rm -v "$PWD/services/shipping-service":/src:ro python:3.12-slim \
  sh -c 'cp -r /src /tmp/shipping && cd /tmp/shipping && pip install -q -r requirements-dev.txt && python -m pytest -q -p no:cacheprovider'
```

Folder usługi jest montowany tylko do odczytu, a testy działają na kopii, więc w repozytorium nie powstają `__pycache__` ani `.pytest_cache`. Wynik: `… passed, 4 skipped`.

Testy działają na SQLite (plik tymczasowy), bez PostgreSQL, RabbitMQ i Consula. Obejmują cennik i `HEAD`, uprawnienia i własność danych (także cudze `orderId` i `PATCH` z rolą `SERVICE`), przejścia statusów i zdarzenia, `POST /shipments/cancel` (każdy wiersz tabeli, 403, 400), późne `order.created` po anulowaniu, odbiorcę (`ack`, natychmiastowe DLQ przy złej kopercie, 3 próby z odstępami i DLQ, linie logu), przekaźnik (publikacja i usunięcie wiersza, brak trasy, błąd brokera, dzierżawa), logi JSON, błędny `DB_URL` i rejestrację w Consulu.

`tests/test_postgres.py` sprawdza to, czego SQLite nie pokazuje: równoległe anulowanie i nadanie (20 rund), równoległe anulowanie i `order.created` (20 rund, oba dopuszczalne wyniki), wykrycie powtórzonego `eventId` i migrację tabel z PR #17. Działa tylko ze zmienną `SHIPPING_TEST_DB_URL` (bez niej 4 testy są pomijane). Zmienna musi wskazywać **osobną, testową** bazę PostgreSQL, nigdy bazę działającej usługi: testy dopisują przesyłki i wiersze outboxu, które przekaźnik działającej usługi wysłałby do `shop.events`, a test migracji zakłada i usuwa własny schemat. Najprościej użyć jednorazowego PostgreSQL w kontenerze. Hasło jest losowe dla każdego uruchomienia, a kontener na końcu jest usuwany:

```bash
pw=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
docker network create shipping-test
docker run -d --name shipping-test-pg --network shipping-test -e POSTGRES_PASSWORD="$pw" -e POSTGRES_DB=shipping_test postgres:17-alpine
until docker exec shipping-test-pg pg_isready -q -h 127.0.0.1 -U postgres; do sleep 1; done
docker run --rm --network shipping-test \
  -e SHIPPING_TEST_DB_URL="postgresql+psycopg://postgres:$pw@shipping-test-pg:5432/shipping_test" \
  -v "$PWD/services/shipping-service":/src:ro python:3.12-slim \
  sh -c 'cp -r /src /tmp/shipping && cd /tmp/shipping && pip install -q -r requirements-dev.txt && python -m pytest -q -p no:cacheprovider'
docker rm -f shipping-test-pg && docker network rm shipping-test
```

Wynik: `… passed` bez `skipped`.

Kolekcja Postman (`postman/shipping-service.postman_collection.json`) woła usługę bezpośrednio z nagłówkami `X-User-*` (przez Gateway `POST /shipments/cancel` jest zablokowany). Zmienne `userId` i `adminId` są ustawione w kolekcji, a każdy przebieg anuluje nowe losowe `orderId`, więc można ją uruchamiać wielokrotnie:

```bash
npx newman run postman/shipping-service.postman_collection.json --env-var baseUrl=http://127.0.0.1:8089
```
