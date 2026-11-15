# Order Service

Zamówienia sklepu. Python 3.12, FastAPI, port **8086**. Dane w PostgreSQL (`order_db`, konto `order_service`), zdarzenia przez RabbitMQ (`shop.events`), adresy innych usług z Consula. Właściciel: Piotr (`Piotr210203`).

Kontrakt dla frontendu: [docs/frontend-api.md, „Order”](../../docs/frontend-api.md#order). Zdarzenia: [docs/events.md](../../docs/events.md). Wzorce platformy (Consul, wywołania innych usług, outbox): [docs/patterns.md](../../docs/patterns.md).

## Endpointy

Ścieżki bez prefiksu — Gateway wystawia je jako `/api/v1/orders…`. Tożsamość tylko z nagłówków Gateway: `X-User-Id`, `X-User-Roles` (`CUSTOMER`, `ADMIN`, `SERVICE`), `X-Request-Id`. Błędy w formacie `{"status", "error", "message", "requestId"}`; niepoprawne dane i nieznane pola → 400 `VALIDATION_ERROR`.

| Metoda i ścieżka | Kto | Wynik |
|---|---|---|
| `POST /orders` | zalogowany | 201 `OrderDetail` ze statusem `PAID` albo `PAYMENT_FAILED`; opis niżej |
| `GET /orders?page=1&size=20` | zalogowany | strona **własnych** zamówień, najnowsze najpierw |
| `GET /orders/{orderId}` | właściciel albo ADMIN | 200 `OrderDetail`; cudze lub brak → 404 |
| `POST /orders/{orderId}/cancel` | właściciel albo ADMIN | 200 `CANCELLED`; opis niżej |
| `GET /orders/purchased?userId=&productId=` | tylko `SERVICE` (Review) | 200 `{"purchased": true\|false}` — zamówienie `PAID`, `SHIPPED` albo `DELIVERED` z tym produktem; bez `SERVICE` → 403; z zewnątrz Gateway → 404 |
| `GET /health/live`, `GET /health/ready` | — | zdrowie, opis niżej |
| `GET /docs`, `GET /openapi.json` | — | OpenAPI |

`GET` odpowiada też na `HEAD` (bez treści).

### Zakup — `POST /orders`

Treść: `shippingMethod` (`COURIER`, `PARCEL_LOCKER`, `PICKUP`), `shippingAddress` (`firstName`, `lastName`, `street`, `postalCode`, `city`, `countryCode`), `payment.cardNumber` (12–19 cyfr). Atrapa płatności: karta kończąca się cyfrą `0` jest odrzucana. Numer karty nie trafia do bazy, zdarzeń ani logów.

Nagłówek **`Idempotency-Key`** (opcjonalny, UUID; zły format → 400):
- ten sam klient i ten sam klucz → 201 z tym samym zamówieniem (gdy nie jest już `NEW`);
- ten sam klucz z innym adresem albo metodą dostawy → 409 `CONFLICT` „Klucz zakupu został użyty z innymi danymi”;
- drugie żądanie z tym samym kluczem, gdy pierwsze jeszcze trwa → 503 „Zakup jest w toku; ponów z tym samym kluczem” (próba zakupu „trzyma” zamówienie `NEW` przez 10 s — kolumna `attempt_until`); po zakończeniu pierwszej próby albo po upływie tego czasu (proces padł) ponowienie dokańcza zakup;
- klucz innego klienta nie ma znaczenia (klucze są osobne dla każdego klienta).

Przebieg (kroki 1–5 muszą się zmieścić w **8 s**):
1. Migawka: `GET /cart`, `GET /shipping/methods/{code}`, `GET /products/{id}` dla każdej pozycji.
2. Zapis zamówienia `NEW`.
3. `POST /inventory/reservations` (`orderId`, pozycje). 409 albo 404 od Inventory → **409 `INSUFFICIENT_STOCK`** i usunięcie `NEW`.
4. Atrapa płatności. Karta `…0` → `DELETE /inventory/reservations/{orderId}` → **201 `PAYMENT_FAILED`** dopiero po zwolnieniu rezerwacji (koszyk bez zmian).
5. `PAID` i zdarzenie `order.created` w jednej transakcji, warunkowo (`WHERE status = 'NEW'`). Gdy zamówienie zostało w tym czasie anulowane, anulowanie wygrywa: rezerwacja jest zwalniana, odpowiedź zawiera bieżący stan.
6. Po zapisie `PAID` odpowiedź to zawsze **201 `PAID`**. Koszyk (`DELETE /cart/{userId}`) jest czyszczony raz, z limitem 1,5 s, bez ponawiania — błąd to tylko ostrzeżenie w logu (spóźnione ponowienie mogłoby usunąć produkty dodane już po zakupie).

**Kompensacja** (najwyżej 1,5 s; najdłuższa odpowiedź: 8 s + 1,5 s = 9,5 s, Gateway czeka 10 s):
- Żądanie rezerwacji w ogóle nie wyszło (otwarty wyłącznik, brak instancji w Consulu, brak połączenia, mniej niż 0,5 s do terminu) → rezerwacji nie ma, więc bez `DELETE`: usunięcie `NEW` i **503 „Zamówienie nie powstało; spróbuj ponownie”**. Brakiem połączenia jest też adres, który nie odpowiada (np. Inventory zatrzymane przed chwilą, a jeszcze na liście z Consula): łączenie kończy się po 1 s (`reason: ConnectTimeout`), przed limitem całego wywołania, a `POST` jest ponawiany najwyżej 2 razy, jak przy odmowie połączenia.
- Żądanie wyszło, a Inventory odmówiło (nieoczekiwany 4xx) albo wynik jest nieznany (timeout, zerwane połączenie, 5xx), albo termin 8 s minął po rezerwacji → `DELETE /inventory/reservations/{orderId}` (2xx, 404 i 409 = nie ma czego zwalniać), usunięcie `NEW` i **503 „Zamówienie nie powstało; spróbuj ponownie”**. Przy **nieznanym wyniku** 3 s później idzie jeszcze jedno `DELETE` tej rezerwacji: Inventory mogło ją zapisać już po swojej odpowiedzi albo po timeoucie Order, a `DELETE` jest idempotentne. W logu `info` „Reservation released again after compensation” albo `warning` „Late release of the reservation failed”.
- Zwolnienie się nie udało → `NEW` zostaje (bez drugiego `DELETE`: ponowienie potrzebuje tej rezerwacji), w logu linia `error` z `orderId`, odpowiedź **503 „…ponów z tym samym kluczem”** — ponowienie z tym samym kluczem dokończy zakup.
- Termin 8 s minął w trakcie zapisu `NEW` → **503 „…ponów z tym samym kluczem”**: zapis w bazie mógł się jeszcze udać. Ponowienie z tym samym kluczem dokończy zakup; przez 10 s od zapisu może dostać 503 „Zakup jest w toku…”.

**Odmowy innych usług:** do klienta trafiają tylko `CART_EMPTY` (pusty koszyk), `PRODUCT_UNAVAILABLE` (404 z Product) i `INSUFFICIENT_STOCK`. Każda inna odpowiedź 4xx zależności to błąd integracji: **503** i linia `error` w logu z nazwą usługi i kodem.

### Anulowanie — `POST /orders/{orderId}/cancel`

1. Zamówienie właściciela albo ADMIN (inaczej 404). Status inny niż `NEW`/`PAID` → **409 `ORDER_NOT_CANCELLABLE`**.
2. `POST /shipments/cancel {"orderId"}` do Shipping (endpoint wewnętrzny; rozstrzyga pod blokadą wiersza przesyłki, więc anulowanie i nadanie paczki nie mogą się minąć). 200 → krok 3; 409 (paczka już nadana) → **409 `ORDER_NOT_CANCELLABLE`**; timeout, 5xx, otwarty wyłącznik albo inna odpowiedź → **503**, zamówienie bez zmian.
3. `CANCELLED` i `order.cancelled` w jednej transakcji, warunkowo. Gdy zamówienie w międzyczasie już zostało anulowane (ścieżka samonaprawy z odbiorcy) → 200 z bieżącym stanem. Każde zamówienie ma dokładnie jedno `order.cancelled` (także zamówienie `NEW`).

Gdy Shipping zgodził się na anulowanie, a zapis w kroku 3 się nie udał (np. baza zamówień niedostępna → 503 dla klienta), zamówienie zostaje chwilowo `PAID`, a przesyłka jest już `CANCELLED`. Order naprawia to sam przy zdarzeniu `shipment.status_changed` z `newStatus: CANCELLED`. Jeśli Shipping anulował, zanim dostał `order.created` (przesyłka jeszcze nie istniała), to zdarzenie przychodzi po spóźnionym `order.created`: Shipping zakłada wtedy przesyłkę od razu jako `CANCELLED` i wysyła `oldStatus: null → CANCELLED` (Z10). Do tego czasu stan naprawia też ponowne anulowanie przez klienta (Shipping odpowiada wtedy 200, a Order zapisuje `CANCELLED`).

## Zdarzenia

| Kierunek | Typ | Kiedy |
|---|---|---|
| publikuje | `order.created` | razem z zapisem `PAID` |
| publikuje | `order.cancelled` | razem z zapisem `CANCELLED` (także dla `NEW`) |
| odbiera (`order.q`) | `shipment.status_changed` | `SHIPPED`, `DELIVERED` → status zamówienia (tylko do przodu); `PREPARING`, `IN_TRANSIT` → bez zmian; `CANCELLED` dla `NEW`/`PAID` → `CANCELLED` + `order.cancelled` (samonaprawa: Shipping anulował, a Order nie zdążył zapisać; także `oldStatus: null` po spóźnionym `order.created`, Z10); `SHIPPED`/`IN_TRANSIT`/`DELIVERED` dla zamówienia `CANCELLED` → bez zmian i linia `error` „Cancellation inconsistency” |

**Przekaźnik outboxu** (`app/relay.py`): zdarzenia zapisuje się do tabeli `outbox_events` w tej samej transakcji co status. Osobne zadanie z własnym połączeniem do RabbitMQ (`connect_robust`, potwierdzenia publikacji, `mandatory`, limit 2 s) pobiera wiersze dzierżawą (`locked_until`, `SKIP LOCKED`, 30 s), publikuje bez otwartej transakcji i usuwa wiersz po potwierdzeniu (dostarczenie „co najmniej raz”). Błąd bazy albo brokera → ostrzeżenie i przerwa 2–5 s; wiadomość zwrócona przez brokera (brak trasy) zostaje w tabeli z linią `error`.

**Odbiorca** (`app/consumer.py`): osobne połączenie `connect_robust`, `prefetch 10`, kolejka `order.q` otwierana pasywnie i sprawdzana co 15 s (usunięta kolejka → ostrzeżenie i ponowne połączenie po 5 s). Błąd przetwarzania → do 3 prób w procesie (po 5 s i 30 s, z losowym dodatkiem do +50 %), potem `nack(requeue=False)` → `order.dlq` i jedna linia `error` z `eventId`. Niepoprawna koperta (zły JSON, `eventId` inny niż UUID, `type` inny niż klucz routingu, brak pól) → od razu `order.dlq`; linia `error` ma `requestId` koperty, jeśli spełnia regułę `^[A-Za-z0-9._-]{1,64}$`, inaczej `null`. Każdy obsłużony komunikat zostawia po `ack` jedną linię `info`: „Event processed”, „Event already processed (duplicate eventId), acknowledged” albo „Event type not handled, acknowledged”, z polami `eventId`, `type`, `orderId`, `requestId` (z koperty) i `userId` (z `payload.userId`). Idempotencja: przetworzone `eventId` w tabeli `order_processed`, w tej samej transakcji co skutek (`INSERT … ON CONFLICT DO NOTHING RETURNING`: brak zwróconego wiersza = duplikat, komunikat dostaje `ack` bez skutku). `requestId` z koperty niezgodny z `^[A-Za-z0-9._-]{1,64}$` → nowy UUID w logach.

Nazwy połączeń w panelu RabbitMQ: `<INSTANCE_ID>` (odbiorca) i `<INSTANCE_ID>-relay` (przekaźnik).

## Inne usługi, Consul, zdrowie

- Wywołania Cart, Product, Inventory i Shipping: adres z Consula (lista zdrowych instancji na 10 s, po kolei), timeout 2 s, z czego nawiązanie połączenia najwyżej 1 s (połowa krótszego limitu), wyłącznik na każdą usługę (≥ 50 % błędów z 10 wywołań → otwarty 30 s, potem jedno wywołanie próbne). Awaria dla wyłącznika: brak połączenia, timeout, 5xx, 408, 429. `GET` ponawiany najwyżej 2 razy (200 i 400 ms) po błędzie sieci, timeoucie albo 502/503/504; inne metody tylko wtedy, gdy połączenie w ogóle nie powstało. W zakupie timeout jest krótszy, gdy termin 8 s jest bliżej; przy mniej niż 0,5 s do terminu wywołania nie ma wcale (`reason: deadline`), więc ucięty timeout nie liczy się do wyłącznika usługi docelowej. Znane zachowanie: okno 10 wywołań nie wygasa z czasem, więc po serii błędów pierwszy sukces może je dopełnić i otworzyć wyłącznik na 30 s (np. 9 błędów + 1 sukces); zdarza się to po teście awarii, nie w zwykłym ruchu. Nagłówki: `X-User-Id` klienta, `X-User-Roles` = role klienta + `SERVICE`, `X-Request-Id`.
- Gdy Consul nie odpowiada, usługa używa **ostatniej znanej listy** instancji (przez 10 s nie pyta Consula o żadną usługę); błędy Consula nie liczą się do wyłączników usług docelowych. Pusta lista zdrowych instancji (np. tuż po restarcie Consula, zanim checki przejdą) też nie usuwa ostatniej znanej listy: usługa używa jej, dopóki Consul bez przerwy zwraca pustą listę przez 30 s (licząc od pierwszej pustej odpowiedzi; niepusta odpowiedź albo błąd Consula przerywa serię). Przy przerywanych błędach Consula (pusta lista, błąd, znów pusta…) ostatnia lista może więc działać dłużej niż 30 s. Logi: jedna linia `warning` przy wejściu w ten stan i jedna przy porzuceniu listy, a `info` „Consul lists healthy instances again” przy pierwszej niepustej odpowiedzi (także po porzuceniu listy albo po błędzie Consula w trakcie). Brak instancji (i brak ostatniej listy) albo otwarty wyłącznik → 503 „Usługa … niedostępna” i jedna linia `warning` „Service unavailable” (`target`, `method`, `reason` = `NoInstances` / `CircuitOpen`).
- Zapytania do Consula: `GET /v1/health/service/<usługa>?passing=true` i `GET /v1/kv/config/order-service/data?raw=true`. W k8s Consul stoi za `consul-guard` (`deploy/k8s/infra/consul-guard.py`), który odrzuca (403) każde inne zapytanie — nowy parametr wymaga zmiany guarda.
- Rejestracja w Consulu: ID = `INSTANCE_ID`, check `GET /health/ready` co 10 s, `"Status"` z bieżącej gotowości: to samo sprawdzenie bazy co `/health/ready` (`passing` albo `critical`). Dotyczy też ponownej rejestracji w trakcie awarii bazy (Consul usunął wpis po 1 min `critical`), więc wpis nie wraca jako `passing`, zanim baza odpowie. Co 15 s usługa sprawdza swój wpis i rejestruje się ponownie, gdy go nie ma (restart Consula). Przy starcie procesu wpis z tym samym ID pozostawiony przez zabity proces jest usuwany i zakładany od nowa (Consul zachowałby jego stan `critical`). Wcześniej usługa usuwa wpisy `order-service` z tym samym adresem i portem, ale innym ID (zabity kontener, którego IP dostał nowy kontener albo pod — taki wpis zostałby `passing` i instancja byłaby na liście dwa razy). Brak połączenia z Consulem → cała próba ponawiana jak rejestracja; błędna odpowiedź Consula przy sprzątaniu → jedna linia `warning` i rejestracja dalej. Odmowa usunięcia jednego wpisu (np. 403, gdy Consul właśnie sam go usunął) nie przerywa sprzątania pozostałych; jedna linia `warning` z liczbą nieudanych po całej pętli. Przy zatrzymaniu (SIGTERM) — wyrejestrowanie. Start bez Consula działa (rejestracja ponawiana).
- `logLevel` z Consul KV `config/order-service/data` (czytany przy starcie); `LOG_LEVEL` ma pierwszeństwo.
- `/health/live` — proces żyje, bez bazy i brokera. `/health/ready` — zapytanie do bazy z limitem 2 s (503, gdy baza nie odpowiada). Broker nie wpływa na gotowość (odbiorca i przekaźnik same wznawiają połączenie). Gałąź „zadanie odbiorcy albo przekaźnika się zakończyło → 503” zostaje jako zabezpieczenie: te zadania kończą się tylko przy błędzie programu.
- **Baza zniknęła z sieci** (odłączona sieć, pod przeniesiony bez zamknięcia połączeń): połączenia z PostgreSQL mają keepalive TCP i `tcp_user_timeout` 5 s, więc zapytanie na takim połączeniu kończy się błędem po około 5 s, a pula otwiera nowe. Dotyczy też przekaźnika outboxu i odbiorcy: piszą `warning` i ponawiają, zamiast wisieć bez błędu do wyczerpania retransmisji TCP.
- **Zawieszona baza** (np. `docker pause`: proces bazy stoi, ale system dalej potwierdza ruch TCP): limit 2 s ma tylko `/health/ready`, a zakup — swój termin 8 s. Pozostałe operacje bazy nie mają limitu. Operacja, która dostanie z puli bezczynne połączenie, wisi do powrotu bazy i wtedy się wykonuje (klient przez Gateway dostaje 504 po 10 s). Operacja, która potrzebuje nowego połączenia, dostaje po 2 s (`connect_timeout`) **503 „Baza zamówień niedostępna”**. Dotyczy `GET /orders`, `GET /orders/{id}`, anulowania, `GET /orders/purchased`, zapisu `PAYMENT_FAILED`, odbiorcy i przekaźnika. Zakup po terminie odpowiada 503, a wiszący zapis kończy się po powrocie bazy.
- Start: tabele (`orders`, `outbox_events`, `order_processed`) zakładane przy starcie pod blokadą doradczą; gdy baza jeszcze nie działa (albo `DB_URL` wskazuje zły host), usługa ponawia co 2 s i pisze `warning` co 30 s. `create_all` nie zmienia istniejących tabel — zmiana kolumny wymaga nowej nazwy tabeli albo migracji. Jedyna migracja: kolumna `orders.attempt_until` dodawana przy starcie, gdy jej brak (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`, pod tą samą blokadą) — patrz „Przejście z wersji z PR #17”.

## Logi

Jedna linia JSON na wpis na stdout: `time`, `level`, `service`, `requestId`, `userId`, `msg` (+ `eventId`, `type` w odbiorcy, `reason` = klasa wyjątku). Jedna linia `HTTP request` na żądanie (`method`, `path`, `status`, `durationMs`). Biblioteki (`aio_pika`, `aiormq`, `httpx`, `sqlalchemy`, `uvicorn`) tylko od poziomu `warning`, przez ten sam formater. Wyjątki tylko jako klasa — bez treści i stosu. W logach nigdy: hasła, numer karty, adres, e-mail. Linie pracy w tle (start, Consul, połączenie z brokerem) mają `requestId: null`.

## Zmienne środowiskowe

Wzór pliku: [.env.example](.env.example) (same nazwy).

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `DB_HOST` | `localhost` | host PostgreSQL (`order_db`, konto `order_service`) |
| `ORDER_DB_PASSWORD` | — | hasło konta `order_service` (sekret) |
| `DB_URL` | — | pełny adres SQLAlchemy zamiast `DB_HOST` + hasła (testy: `sqlite:////tmp/order.db`); błąd formatu → jedna linia `error` „Startup failed: DB_URL has an invalid format (value not shown)” i kod wyjścia 1 (bez adresu i hasła) |
| `RABBITMQ_HOST` | `localhost` | host brokera |
| `RABBITMQ_PORT` | `5672` | port AMQP |
| `RABBITMQ_USER` | `order-service` | konto brokera |
| `RABBITMQ_PASSWORD` | — | hasło konta brokera (sekret; w compose `${ORDER_RABBITMQ_PASSWORD}`) |
| `CONSUL_URL` | `http://localhost:8500` | adres Consula |
| `INSTANCE_ID` | `order-service-<hostname>` | ID instancji w Consulu i nazwa połączeń z brokerem; w k8s = nazwa poda |
| `SERVICE_ADDRESS` | własny IP na trasie do Consula | adres rejestrowany w Consulu. **Na macOS przy uruchomieniu poza kontenerem** trasa do Consula na `localhost` prowadzi przez `127.0.0.1` i usługa tego nie przyjmie — ustaw np. `SERVICE_ADDRESS=host.docker.internal` albo `CONSUL_ENABLED=false` |
| `LOG_LEVEL` | `logLevel` z KV, inaczej `info` | `debug`, `info`, `warning`, `error` |
| `CONSUL_ENABLED` | `true` | `false` — bez rejestracji i KV (wtedy podaj `*_SERVICE_URL`) |
| `BROKER_ENABLED` | `true` | `false` — bez odbiorcy i przekaźnika (zdarzenia zostają w `outbox_events`) |
| `PORT` | `8086` | port rejestrowany w Consulu (serwer uruchamia `uvicorn --port`) |
| `CART_SERVICE_URL`, `PRODUCT_SERVICE_URL`, `INVENTORY_SERVICE_URL`, `SHIPPING_SERVICE_URL` | — | stały adres zależności zamiast Consula (testy, uruchomienie lokalne) |

## Uruchomienie

### W stosie sklepu (Docker Compose)

Usługa jest w profilu `full-shop` pliku [deploy/compose.yaml](../../deploy/compose.yaml) (wymagania i hasła: [deploy/README.md](../../deploy/README.md)). W katalogu głównym repozytorium (na Windows: Git Bash, Rancher Desktop z dockerd):

```bash
bash deploy/create-secrets.sh                      # raz: deploy/.env z hasłami
shop=(docker compose -f deploy/compose.yaml --profile full-shop)
"${shop[@]}" up -d --wait --build
"${shop[@]}" ps order-service shipping-service      # stan healthy
curl -fsS 'http://127.0.0.1:8500/v1/health/service/order-service?passing=true'   # niepusta tablica
curl -fsS http://127.0.0.1:8090/api/v1/shipping/methods                          # COURIER, PARCEL_LOCKER, PICKUP
"${shop[@]}" logs --tail=40 order-service
```

Tabele tworzą się przy starcie w `order_db`. Konta brokera, exchange `shop.events` i kolejki zakłada platforma. Port usługi nie jest wystawiony na hoście — klient wchodzi przez Gateway (`http://127.0.0.1:8090/api/v1/orders`).

Sprawdzenie zakupu przez Gateway: scenariusz Postman robi wszystkie kroki sam (stan produktu w Inventory jako ADMIN, rejestracja i logowanie klienta, koszyk, zakup, anulowanie). W katalogu głównym repozytorium:

```bash
bash postman/run.sh compose     # kolekcja postman/collections/shop-purchase…, folder „08 order”
```

Wynik: liczba żądań i asercji oraz `0 failed` (opis w [postman/README.md](../../postman/README.md)). Folder „08 order” sprawdza:
- zakup `PAID`, pusty koszyk i przesyłkę `PREPARING` (`GET /api/v1/shipments?orderId=`);
- nadanie paczki przez ADMIN (`PATCH /api/v1/shipments/{id}/status`), po którym zamówienie ma `SHIPPED`, a anulowanie daje 409;
- zakup z kartą kończącą się na `0` → `PAYMENT_FAILED`, rezerwacja zwolniona, koszyk zachowany.

Treść żądania zakupu jest też w [kontrakcie](../../docs/frontend-api.md#post-orders--zalogowany).

### Przejście z wersji z PR #17

Baza `order_db` z tabelami pierwszej wersji (PR #17, `develop` przed etapem 8) naprawia się sama przy starcie. Usługa dodaje brakującą kolumnę `orders.attempt_until`, a dotychczasowe zamówienia zostają. Nowe zdarzenia idą do tabeli `outbox_events`, a starej `order_outbox` usługa już nie czyta. Wiersze w niej to zdarzenia, których stara wersja nie wysłała. Sprawdź je przed usunięciem tabeli (hasło rozwija powłoka w kontenerze `postgres`):

```bash
pg=(docker compose -f deploy/compose.yaml exec -T postgres sh -c)
"${pg[@]}" 'PGPASSWORD="$ORDER_DB_PASSWORD" psql -h 127.0.0.1 -U order_service -d order_db -c "SELECT count(*) FROM order_outbox"'
"${pg[@]}" 'PGPASSWORD="$ORDER_DB_PASSWORD" psql -h 127.0.0.1 -U order_service -d order_db -c "DROP TABLE order_outbox"'   # gdy 0
```

Gdy tabeli nie ma (baza założona od etapu 8), pierwsze polecenie kończy się błędem `relation "order_outbox" does not exist` — nie ma czego robić.

### Lokalnie (bez kontenera)

```bash
cd services/order-service
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q
# serwer bez Consula i brokera, z SQLite i stałymi adresami zależności:
CONSUL_ENABLED=false BROKER_ENABLED=false DB_URL=sqlite:///./order.db \
CART_SERVICE_URL=http://127.0.0.1:8085 PRODUCT_SERVICE_URL=http://127.0.0.1:8083 \
INVENTORY_SERVICE_URL=http://127.0.0.1:8084 SHIPPING_SERVICE_URL=http://127.0.0.1:8089 \
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8086
```

Testy w kontenerze (bez lokalnego Pythona):

```bash
docker run --rm -v "$PWD/services/order-service":/src:ro python:3.12-slim \
  sh -c 'cp -r /src /tmp/order && cd /tmp/order && pip install -q -r requirements-dev.txt && python -m pytest -q -p no:cacheprovider'
```

Folder usługi jest montowany tylko do odczytu, a testy działają na kopii, więc w repozytorium nie powstają `__pycache__` ani `.pytest_cache`. Wynik: `… passed, 6 skipped`.

Testy domyślnie używają SQLite. `tests/test_postgres.py` sprawdza to, czego SQLite nie pokazuje: wykrycie powtórzonego `eventId` i linię odbiorcy „duplicate”, `rowcount` warunkowych `UPDATE`/`DELETE`, równoległe dostarczenie tego samego zdarzenia i migrację tabel z PR #17. Działa tylko ze zmienną `ORDER_TEST_DB_URL` (bez niej 6 testów jest pomijanych). Zmienna musi wskazywać **osobną, testową** bazę PostgreSQL, nigdy bazę działającej usługi: testy dopisują wiersze, a test migracji zakłada i usuwa własny schemat. Najprościej użyć jednorazowego PostgreSQL w kontenerze. Hasło jest losowe dla każdego uruchomienia, a kontener na końcu jest usuwany:

```bash
pw=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
docker network create order-test
docker run -d --name order-test-pg --network order-test -e POSTGRES_PASSWORD="$pw" -e POSTGRES_DB=order_test postgres:17-alpine
until docker exec order-test-pg pg_isready -q -h 127.0.0.1 -U postgres; do sleep 1; done
docker run --rm --network order-test \
  -e ORDER_TEST_DB_URL="postgresql+psycopg://postgres:$pw@order-test-pg:5432/order_test" \
  -v "$PWD/services/order-service":/src:ro python:3.12-slim \
  sh -c 'cp -r /src /tmp/order && cd /tmp/order && pip install -q -r requirements-dev.txt && python -m pytest -q -p no:cacheprovider'
docker rm -f order-test-pg && docker network rm order-test
```

Wynik: `… passed` bez `skipped`.

Obraz: `docker build -t order-service:dev services/order-service` (użytkownik 10001, bez roota).

### Żądania bezpośrednio do usługi

Gateway zamienia token na nagłówki; bezpośrednio do usługi (uruchomienie lokalne albo kontener w sieci `backend`) podajesz je sam:

```bash
O=http://127.0.0.1:8086
U=0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e
KEY=$(python3 -c 'import uuid; print(uuid.uuid4())')
curl -s -X POST $O/orders -H "X-User-Id: $U" -H 'X-User-Roles: CUSTOMER' -H "Idempotency-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"shippingMethod":"COURIER","shippingAddress":{"firstName":"Anna","lastName":"Nowak","street":"ul. Prosta 1/2","postalCode":"00-001","city":"Warszawa","countryCode":"PL"},"payment":{"cardNumber":"4111111111111111"}}'
curl -s "$O/orders?page=1&size=5" -H "X-User-Id: $U" -H 'X-User-Roles: CUSTOMER'
curl -s -X POST $O/orders/<orderId>/cancel -H "X-User-Id: $U" -H 'X-User-Roles: CUSTOMER'
curl -s "$O/orders/purchased?userId=$U&productId=<productId>" -H 'X-User-Roles: SERVICE'
```

### Postman

Kolekcja [postman/order-service.postman_collection.json](postman/order-service.postman_collection.json) — żądania bezpośrednio do usługi z nagłówkami Gateway i asercjami (kody i kluczowe pola). Każdy przebieg tworzy nowe zamówienia z nowym `Idempotency-Key`, więc można ją uruchamiać wiele razy. Wymaga Cart, Product, Inventory i Shipping (prawdziwych albo atrap) z koszykiem zawierającym produkt. Zmienne: `baseUrl`, `userId`, `otherUserId`.

### Kubernetes

[k8s/app.yaml](k8s/app.yaml) to wzór manifestu (namespace `shop`, ClusterIP, sondy, bez roota, Secret `order-service-secret` z kluczami `ORDER_DB_PASSWORD` i `RABBITMQ_PASSWORD`). Sklep w klastrze wdraża `deploy/k8s/` (`bash deploy/k8s/up.sh`), nie ten plik.
