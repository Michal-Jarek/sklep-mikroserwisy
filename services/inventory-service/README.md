# Inventory Service

Stany magazynowe produktów i rezerwacje towaru dla zamówień.

| | |
|---|---|
| Właściciel | Aleksandra Krzeszewska |
| Technologia | Python 3.12 · FastAPI · PostgreSQL · RabbitMQ |
| Port | 8084 |
| Nazwa w Consulu, Kubernetesie i obrazie Docker | `inventory-service` |
| Namespace Kubernetes | `shop` |
| Health checki | `/health/live`, `/health/ready` |
| Dokumentacja API | `/docs` |

## Zakres

Usługa przechowuje w PostgreSQL (`inventory_db`, tabele `stock_items`, `stock_reservations`, `processed_events`) stan magazynowy każdego produktu: `quantity` (stan fizyczny), `reserved` (zarezerwowane dla zamówień) i `available = quantity - reserved`. Identyfikatory produktu (`productId`) i zamówienia (`orderId`) to UUID zapisany tekstem; wielkie litery są zamieniane na małe, więc ten sam UUID zapisany wielkimi literami to ta sama rezerwacja. Rezerwacja dla zamówienia jest jedną transakcją z blokadą wierszy (`SELECT ... FOR UPDATE`, zawsze w kolejności `productId`), atomową (wszystkie pozycje albo żadna) i idempotentną względem `orderId`. Rezerwację zwalnia wywołanie REST albo zdarzenie `order.cancelled` z RabbitMQ, a towar jest wydawany po zdarzeniu `shipment.status_changed` ze statusem `SHIPPED`.

| Metoda | Ścieżka | Kto | Znaczenie |
|---|---|---|---|
| GET | `/inventory/{productId}` | Product, Cart, Gateway | Stan produktu: `productId`, `quantity`, `reserved`, `available`, `inStock`; 404, gdy brak wpisu; 400, gdy `productId` nie jest UUID |
| PUT | `/inventory/{productId}` | ADMIN | Ustawienie stanu `{"quantity": 10}`; tworzy wpis, gdy go nie było; 409, gdy nowy stan jest mniejszy niż zarezerwowany; nieznane pola w treści dają 400 |
| POST | `/inventory/reservations` | SERVICE (Order) | `{orderId, items:[{productId, quantity}]}`; 201 nowa rezerwacja, 200 powtórzone żądanie, 409 `INSUFFICIENT_STOCK`; 400, gdy `orderId` albo `productId` nie jest UUID, `quantity` nie jest liczbą całkowitą albo treść ma nieznane pole |
| DELETE | `/inventory/reservations/{orderId}` | SERVICE (Order) | Zwolnienie rezerwacji; 204, także gdy rezerwacji nie ma; 400, gdy `orderId` nie jest UUID |

Błędy mają format `{"status", "error", "message", "requestId"}`, a odpowiedź każdego błędu zawiera nagłówek `X-Request-Id`. Gateway udostępnia endpointy pod `/api/v1/...`, usługa widzi ścieżki bez prefiksu.

Zdarzenia RabbitMQ są odbierane z kolejki `inventory.q`: `order.cancelled` (zwolnienie rezerwacji `ACTIVE`) oraz `shipment.status_changed` (przy `newStatus: SHIPPED` maleją `quantity` i `reserved`, a rezerwacja dostaje status `ISSUED`). Kolejki, `inventory.dlq` i bindingi tworzy wspólna konfiguracja, a usługa tylko czyta. Błędną kopertę (zły JSON, `eventId` albo `orderId` niebędący UUID, błędne pola, nieznana `version`, `type` różny od klucza routingu, każdy wyjątek przy odczycie koperty) usługa odrzuca od razu (`inventory.dlq`), a linia logu zawiera `eventId` i `requestId`, gdy da się je odczytać. `requestId` niepasujący do `^[A-Za-z0-9._-]{1,64}$` nie odrzuca zdarzenia: w logach dostaje nowy UUID. Błąd chwilowy jest ponawiany w procesie (po 5 s, potem po 30 s, każdy odstęp z losowym dodatkiem do +50 %), a po trzeciej nieudanej próbie wiadomość trafia do `inventory.dlq` (log `error` z `eventId`, `type`, `requestId` i klasą wyjątku). Przetworzone `eventId` są zapisywane w bazie w tej samej transakcji co skutek (idempotencja).

Odbiorca łączy się przez `connect_robust` (połączenie w panelu RabbitMQ nazywa się jak ID instancji) i sam wznawia połączenie po restarcie brokera. Co 15 s sprawdza pasywnie, czy `inventory.q` istnieje: usunięta kolejka zatrzymuje odbiór bez błędu po stronie klienta, więc usługa zapisuje wtedy `warning` i łączy się od nowa co 5 s, aż kolejka wróci.

## Uruchomienie lokalne

Całość sklepu (z PostgreSQL, RabbitMQ i Consulem) uruchamia się z katalogu głównego repozytorium według [deploy/README.md](../../deploy/README.md): najpierw `bash deploy/create-secrets.sh` (hasła w `deploy/.env`), potem `docker compose -f deploy/compose.yaml --profile full-shop up -d --wait --build`. Inventory jest wtedy dostępne przez Gateway pod `/api/v1/inventory/...`.

Bez kontenera aplikacji, z działającym PostgreSQL. Wymagany Python 3.12 (na macOS polecenie `python3`; w aktywnym środowisku `.venv` wystarczy `python`):

```
cd services/inventory-service
python3 -m venv .venv
# Linux/macOS: source .venv/bin/activate
# PowerShell: .\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
export DATABASE_URL=postgresql+psycopg2://inventory_service:<haslo>@localhost:5432/inventory_db
export CONSUL_ENABLED=false
uvicorn app.main:app --host 127.0.0.1 --port 8084 --reload --no-access-log
```

`DATABASE_URL` jest wymagany, tabele tworzą się przy starcie (przy kilku instancjach naraz tylko jedna je tworzy). Domyślny Consul: `http://consul:8500`, dlatego bez infrastruktury lokalnie `CONSUL_ENABLED=false`. Przy infrastrukturze z Docker Compose usługa z VS Code rejestruje się w Consulu po ustawieniu `CONSUL_HOST=127.0.0.1` i `SERVICE_ADDRESS=host.docker.internal` (Consul w kontenerze sprawdza `/health/ready` pod tym adresem), a serwer nasłuchuje na `127.0.0.1`. Nazwy zmiennych są też w `.env.example` (bez wartości).

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `DATABASE_URL` | — (wymagana) | adres PostgreSQL z użytkownikiem usługi (`postgresql+psycopg2://…/inventory_db`); zawiera hasło, nie trafia do logów |
| `SERVICE_PORT` | `8084` | port rejestrowany w Consulu |
| `SERVICE_ADDRESS` | własny adres IP | adres rejestrowany w Consulu (w Kubernetesie adres poda) |
| `INSTANCE_ID` | `inventory-service-<hostname>` | pełne ID instancji w Consulu, nazwa połączenia w RabbitMQ i nagłówek `X-Instance-Id` (w Kubernetesie nazwa poda) |
| `LOG_LEVEL` | `info` albo `logLevel` z Consul KV | poziom logów usługi; zmienna ma pierwszeństwo przed KV |
| `CONSUL_ENABLED`, `CONSUL_HOST`, `CONSUL_PORT` | `true`, `consul`, `8500` | Consul (rejestracja i KV) |
| `RABBITMQ_HOST` | pusty | broker zdarzeń; pusty wyłącza odbiorcę (REST działa dalej) |
| `RABBITMQ_PORT` | `5672` | port brokera |
| `RABBITMQ_USER`, `RABBITMQ_PASSWORD` | puste | konto `inventory-service` z prawem odczytu `inventory.q`; hasło nie trafia do logów |

Odbiorca zdarzeń włącza się tylko po ustawieniu `RABBITMQ_HOST` (oraz `RABBITMQ_PORT`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD`); bez niego usługa działa, ale nie odbiera zdarzeń. Tożsamość jest odczytywana z nagłówków `X-User-Id` (UUID) i `X-User-Roles` (lista oddzielona przecinkami, wielkość liter ma znaczenie), np. `X-User-Roles: SERVICE` przy wołaniu rezerwacji z Postmana.

Brak PostgreSQL powoduje 503 `SERVICE_UNAVAILABLE` przy operacjach, a `/health/ready` odpowiada 503 w mniej niż 2 s. Baza, która przyjmuje połączenie, ale nie odpowiada (zawieszony serwer, zerwana sieć), też daje 503: każda operacja na bazie ma limit 2 s, a czekanie na wolne połączenie z puli najwyżej 2 s. Termin 2 s liczy się od wywołania operacji: praca, która skończy się po nim (np. rezerwacja przy wstrzymanej bazie), nie zapisuje niczego — przed zatwierdzeniem transakcji usługa sprawdza termin i wycofuje zmiany (w logu `warning` „Operacja na bazie skończyła się po limicie 2 s, zmiany wycofane”). Po stronie PostgreSQL czekanie na blokadę wiersza kończy się po 1,5 s (`lock_timeout`), a pojedyncze zapytanie po 1,8 s (`statement_timeout`). Połączenie z serwerem, który zniknął z sieci bez zamknięcia połączeń (zerwana sieć, restart poda), jest zrywane po ok. 5 s (keepalive TCP i `tcp_user_timeout`), więc także odbiorca zdarzeń nie czeka na nie minutami. Wołający i tak traktuje 503 jak wynik nieznany: Order po 503 przy rezerwacji zwalnia ją (`DELETE`), co domyka milisekundowe okno, w którym zatwierdzenie zaczęło się tuż przed terminem. `/health/live` nie korzysta z bazy i odpowiada od razu. Niepoprawny format `DATABASE_URL` kończy start komunikatem „Niepoprawny format DATABASE_URL” bez adresu (adres zawiera hasło).

`/health/ready` nie zależy od RabbitMQ: brak brokera nie zatrzymuje REST i nie zmienia gotowości, a odbiorca ponawia połączenie sam. Gotowość ma 503 także wtedy, gdy zadanie odbiorcy się zakończyło. Zadanie samo ponawia każdy błąd połączenia i brak kolejki, więc kończy się tylko przy błędzie programu — ten warunek zostaje jako zabezpieczenie.

## Testy

Z katalogu `services/inventory-service`, po instalacji zależności deweloperskich:

```
python -m pytest -q
```

Testy działają na SQLite w pamięci, więc nie potrzebują PostgreSQL, RabbitMQ ani Consula. Obejmują stany, identyfikatory UUID (także `orderId` wielkimi literami), role, rezerwacje (idempotencja, brak towaru, atomowość), zwolnienie, walidację (nieznane pola, `quantity` tylko jako liczba całkowita), 503 przy błędach bazy i przy bazie, która nie odpowiada, obsługę zdarzeń i reguły koperty, odbiorcę (`ack`, `nack` przy złej kopercie i po 3 próbach, ponowne połączenie po usunięciu kolejki), ponowną rejestrację w Consulu, odczyt konfiguracji z Consul KV i logi JSON. Blokady `FOR UPDATE` i współbieżność rezerwacji wymagają PostgreSQL i nie są objęte testami automatycznymi.

Kolekcję Postman (`postman/inventory-service.postman_collection.json`) uruchamia się w Postmanie (Runner, po kolei) albo przez newman, przy usłudze dostępnej pod `http://localhost:8084` (zmienna kolekcji `baseUrl`). Kolekcja woła usługę bezpośrednio i sama ustawia nagłówki `X-User-*`, więc przez Gateway nie przejdzie (rezerwacje są z zewnątrz zablokowane). Każdy przebieg tworzy nowe `orderId`, więc kolekcję można uruchamiać wielokrotnie:

```
npx newman run postman/inventory-service.postman_collection.json --env-var baseUrl=http://localhost:8084
```

## Zależności i wdrożenie

Inventory nie woła innych usług przez REST, więc nie ma w nim circuit breakera ani ponowień. Rejestruje się w Consulu jako `inventory-service` z ID `INSTANCE_ID` (pełne ID, w Kubernetesie nazwa poda) albo `inventory-service-<hostname>`, adresem `SERVICE_ADDRESS` (w Kubernetesie adres poda) albo własnym adresem IP i health checkiem `/health/ready` co 10 s; stan początkowy checku (`passing` albo `critical`) wynika ze sprawdzenia bazy, więc Gateway widzi instancję od razu po rejestracji. Wpis z tym samym ID pozostały po poprzednim procesie zatrzymanym bez wyrejestrowania (np. restart kontenera w compose) usługa przy starcie najpierw usuwa, bo Consul przy ponownej rejestracji zachowuje stary stan checku (np. `critical` z czasu przerwy). Przy tej pierwszej rejestracji usuwa też wpisy `inventory-service` z tym samym adresem i portem, ale innym ID (np. kontener w compose zabity i utworzony od nowa dostaje nowe ID i zwykle ten sam IP); błąd tego sprzątania kończy się ostrzeżeniem w logu i nie blokuje rejestracji. Co ok. 15 s sprawdza, czy wpis istnieje z aktualnym adresem, i rejestruje się ponownie, gdy go nie ma, a przy zatrzymaniu się wyrejestrowuje. Przy starcie czyta z Consul KV klucz `config/inventory-service/data` (dokument YAML, pole `logLevel`: `debug`, `info`, `warning` lub `error`); zmienna `LOG_LEVEL` ma pierwszeństwo, a start bez Consula jest dozwolony. Wymaga PostgreSQL oraz RabbitMQ z kontem dla tej usługi (tylko odczyt `inventory.q`).

Wdrożenie w klastrze robi platforma (`deploy/k8s/services/inventory-service.yaml`, sekret tworzy `deploy/k8s/secrets.sh`, całość `bash deploy/k8s/up.sh`). Manifesty w folderze `k8s/` są wzorem — nie aplikuj ich w namespace `shop`.

## Przejście ze starej wersji

Wcześniejsza wersja zapisywała stany i rezerwacje w tabelach `inventory_items` i `reservations` z `product_id` liczbowym. Ta wersja używa nowych tabel `stock_items` i `stock_reservations` (`processed_events` bez zmian), które zakłada sama przy starcie, więc istniejąca baza `inventory_db` nie wymaga ręcznych kroków. Stany magazynowe trzeba wpisać ponownie (`PUT /inventory/{productId}`). Usługa nie czyta i nie usuwa starych tabel; ich usunięcie opisuje [deploy/README.md](../../deploy/README.md) (w klastrze robi to platforma).

## Pliki

* `app/` — kod aplikacji.
* `tests/` — testy pytest.
* `Dockerfile`, `.dockerignore`, `.env.example`, `requirements*.txt` — obraz, nazwy zmiennych i zależności.
* `k8s/` — wzór manifestów tej usługi (ConfigMap, Deployment, Service); wdrożenie w klastrze jest w `deploy/k8s/`.
* `postman/` — kolekcja Postman tej usługi.
* [docs/OPIS-KODU.md](docs/OPIS-KODU.md) — odpowiedzialność plików, przepływ rezerwacji, współbieżność i zachowanie przy awariach.
* [docs/KONTRAKT.md](docs/KONTRAKT.md) — pola JSON, odpowiedzi, zdarzenia i błędy.
* [docs/INTEGRACJA.md](docs/INTEGRACJA.md) — wymagania wspólnej infrastruktury.

Tożsamość jest przekazywana wyłącznie w nagłówkach z zaufanego Gateway. W klastrze niezbędne są ograniczenia ruchu sieciowego (NetworkPolicy po stronie infrastruktury). Usługa nie jest publicznym punktem wejścia do sklepu.

Wyniki sprawdzenia: [docs/WERYFIKACJA.md](docs/WERYFIKACJA.md).
