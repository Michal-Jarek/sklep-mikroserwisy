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

Usługa przechowuje w PostgreSQL (`inventory_db`) stan magazynowy każdego produktu: `quantity` (stan fizyczny), `reserved` (zarezerwowane dla zamówień) i `available = quantity - reserved`. Identyfikator produktu (`productId`) to UUID zapisany tekstem. Rezerwacja dla zamówienia jest jedną transakcją z blokadą wierszy (`SELECT ... FOR UPDATE`, zawsze w kolejności `productId`), atomową (wszystkie pozycje albo żadna) i idempotentną względem `orderId`. Rezerwację zwalnia wywołanie REST albo zdarzenie `order.cancelled` z RabbitMQ, a towar jest wydawany po zdarzeniu `shipment.status_changed` ze statusem `SHIPPED`.

| Metoda | Ścieżka | Kto | Znaczenie |
|---|---|---|---|
| GET | `/inventory/{productId}` | Product, Cart, Gateway | Stan produktu: `productId`, `quantity`, `reserved`, `available`, `inStock`; 404, gdy brak wpisu; 400, gdy `productId` nie jest UUID |
| PUT | `/inventory/{productId}` | ADMIN | Ustawienie stanu `{"quantity": 10}`; tworzy wpis, gdy go nie było; 409, gdy nowy stan jest mniejszy niż zarezerwowany; nieznane pola w treści dają 400 |
| POST | `/inventory/reservations` | SERVICE (Order) | `{orderId, items:[{productId, quantity}]}`; 201 nowa rezerwacja, 200 powtórzone żądanie, 409 `INSUFFICIENT_STOCK` |
| DELETE | `/inventory/reservations/{orderId}` | SERVICE (Order) | Zwolnienie rezerwacji; 204, także gdy rezerwacji nie ma |

Błędy mają format `{"status", "error", "message", "requestId"}`, a odpowiedź każdego błędu zawiera nagłówek `X-Request-Id`. Gateway udostępnia endpointy pod `/api/v1/...`, usługa widzi ścieżki bez prefiksu.

Zdarzenia RabbitMQ są odbierane z kolejki `inventory.q`: `order.cancelled` (zwolnienie rezerwacji `ACTIVE`) oraz `shipment.status_changed` (przy `newStatus: SHIPPED` maleją `quantity` i `reserved`, a rezerwacja dostaje status `ISSUED`). Kolejki, `inventory.dlq` i bindingi tworzy wspólna konfiguracja, a usługa tylko czyta. Błędną kopertę (zły JSON, błędne pola, nieznana `version`, `type` różny od klucza routingu) usługa odrzuca od razu. Błąd chwilowy jest ponawiany w procesie (po 5 s, potem po 30 s), a po trzeciej nieudanej próbie wiadomość trafia do `inventory.dlq`. Przetworzone `eventId` są zapisywane w bazie (idempotencja).

## Uruchomienie lokalne

Bez kontenera aplikacji, z działającym PostgreSQL:

```
cd services/inventory-service
python -m venv .venv
# Linux/macOS: source .venv/bin/activate
# PowerShell: .\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
export DATABASE_URL=postgresql+psycopg2://inventory:<haslo>@localhost:5432/inventory_db
export CONSUL_ENABLED=false
uvicorn app.main:app --host 127.0.0.1 --port 8084 --reload --no-access-log
```

`DATABASE_URL` jest wymagany, tabele tworzą się przy starcie (przy kilku instancjach naraz tylko jedna je tworzy). Domyślny Consul: `http://consul:8500`, dlatego bez infrastruktury lokalnie `CONSUL_ENABLED=false`. Przy infrastrukturze z Docker Compose usługa z VS Code rejestruje się w Consulu po ustawieniu `CONSUL_HOST=127.0.0.1` i `SERVICE_ADDRESS=host.docker.internal` (Consul w kontenerze sprawdza `/health/ready` pod tym adresem), a serwer nasłuchuje na `127.0.0.1`. Opcjonalne zmienne są wymienione w `.env.example`.

Odbiorca zdarzeń włącza się tylko po ustawieniu `RABBITMQ_HOST` (oraz `RABBITMQ_PORT`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD`); bez niego usługa działa, ale nie odbiera zdarzeń. Tożsamość jest odczytywana z nagłówków `X-User-Id` (UUID) i `X-User-Roles` (lista oddzielona przecinkami, wielkość liter ma znaczenie), np. `X-User-Roles: SERVICE` przy wołaniu rezerwacji z Postmana.

Brak PostgreSQL powoduje 503 `SERVICE_UNAVAILABLE` przy operacjach, a `/health/ready` odpowiada 503 w mniej niż 2 s. Brak RabbitMQ nie zatrzymuje REST i nie zmienia gotowości, a odbiorca ponawia połączenie co 5 s.

## Testy

Z katalogu `services/inventory-service`, po instalacji zależności deweloperskich:

```
python -m pytest -q
```

Testy działają na SQLite w pamięci, więc nie potrzebują PostgreSQL, RabbitMQ ani Consula. Obejmują stany, identyfikatory UUID, role, rezerwacje (idempotencja, brak towaru, atomowość), zwolnienie, walidację i obsługę zdarzeń, ponowienia odbiorcy, ponowną rejestrację w Consulu oraz odczyt konfiguracji z Consul KV. Blokady `FOR UPDATE` i współbieżność rezerwacji wymagają PostgreSQL i nie są objęte testami automatycznymi.

## Zależności i wdrożenie

Inventory nie woła innych usług przez REST, więc nie ma w nim circuit breakera ani ponowień. Rejestruje się w Consulu jako `inventory-service` (adres poda z `status.podIP`, health check `/health/ready` co 10 s). Co ok. 15 s sprawdza, czy wpis istnieje z aktualnym adresem, i rejestruje się ponownie, gdy go nie ma, a przy zatrzymaniu się wyrejestrowuje. Przy starcie czyta z Consul KV klucz `config/inventory-service/data` (dokument YAML, pole `logLevel`: `debug`, `info`, `warning` lub `error`); zmienna `LOG_LEVEL` ma pierwszeństwo, a start bez Consula jest dozwolony. Wymaga PostgreSQL oraz RabbitMQ z kontem dla tej usługi (tylko odczyt `inventory.q`).

W klastrze dane dostępowe pochodzą z Secret `inventory-service-secret` (klucze `DATABASE_URL` i `RABBITMQ_PASSWORD`), tworzonego ręcznie:

```
kubectl -n shop create secret generic inventory-service-secret \
  --from-literal=DATABASE_URL='postgresql+psycopg2://inventory:<haslo>@postgres:5432/inventory_db' \
  --from-literal=RABBITMQ_PASSWORD='<haslo>'

kubectl apply -f k8s/
```

Host, port i użytkownik RabbitMQ są w `k8s/configmap.yaml`. Deployment ma 2 repliki, requests i limity, probes oraz bezpieczny kontekst (UID 10001, `readOnlyRootFilesystem`). Obraz: `docker build -t inventory-service:latest .`. Consul jest dostępny pod `http://consul:8500`.

## Pliki

* `app/` — kod aplikacji.
* `tests/` — testy pytest.
* `Dockerfile`, `.env.example`, `requirements*.txt` — obraz, nazwy zmiennych i zależności.
* `k8s/` — ConfigMap, Deployment i Service tej usługi wraz z instrukcją.
* `postman/` — kolekcja Postman tej usługi.
* [docs/OPIS-KODU.md](docs/OPIS-KODU.md) — odpowiedzialność plików, przepływ rezerwacji, współbieżność i zachowanie przy awariach.
* [docs/KONTRAKT.md](docs/KONTRAKT.md) — pola JSON, odpowiedzi, zdarzenia i błędy.
* [docs/INTEGRACJA.md](docs/INTEGRACJA.md) — wymagania wspólnej infrastruktury.

Tożsamość jest przekazywana wyłącznie w nagłówkach z zaufanego Gateway. W klastrze niezbędne są ograniczenia ruchu sieciowego (NetworkPolicy po stronie infrastruktury). Usługa nie jest publicznym punktem wejścia do sklepu.

Wyniki sprawdzenia: [docs/WERYFIKACJA.md](docs/WERYFIKACJA.md).
