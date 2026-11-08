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

Usługa przechowuje w PostgreSQL (`inventory_db`) stan magazynowy każdego produktu: `quantity` (stan fizyczny), `reserved` (zarezerwowane dla zamówień) i `available = quantity - reserved`. Rezerwacja dla zamówienia jest jedną transakcją z blokadą wierszy (`SELECT ... FOR UPDATE`, zawsze w kolejności `productId`), atomową (wszystkie pozycje albo żadna) i idempotentną względem `orderId`. Rezerwację zwalnia wywołanie REST albo zdarzenie `order.cancelled` z RabbitMQ.

| Metoda | Ścieżka | Kto | Znaczenie |
|---|---|---|---|
| GET | `/inventory/{productId}` | Product, Cart, Gateway | Stan produktu: `productId`, `quantity`, `reserved`, `available`, `inStock`; 404, gdy brak wpisu |
| PUT | `/inventory/{productId}` | ADMIN | Ustawienie stanu `{"quantity": 10}`; tworzy wpis, gdy go nie było; 409, gdy nowy stan jest mniejszy niż zarezerwowany |
| POST | `/inventory/reservations` | SERVICE (Order) | `{orderId, items:[{productId, quantity}]}`; 201 nowa rezerwacja, 200 powtórzone żądanie, 409 `INSUFFICIENT_STOCK` |
| DELETE | `/inventory/reservations/{orderId}` | SERVICE (Order) | Zwolnienie rezerwacji; 204, także gdy rezerwacji nie ma |

Błędy mają format `{"status", "error", "message", "requestId"}`. Gateway udostępnia endpointy pod `/api/v1/...`, usługa widzi ścieżki bez prefiksu.

Zdarzenia RabbitMQ: exchange `shop.events` (topic), kolejka `inventory.q` z bindingiem `order.cancelled`, kolejka błędów `inventory.dlq`. Koperta zdarzenia zawiera `eventId`, `type`, `occurredAt`, `version` i `payload` z `orderId`. Wiadomość jest potwierdzana po przetworzeniu, po trzech nieudanych próbach trafia do `inventory.dlq`, a przetworzone `eventId` są zapisywane w bazie (idempotencja).

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

`DATABASE_URL` jest wymagany, tabele tworzą się przy starcie. Domyślny Consul: `http://consul:8500`, dlatego lokalnie `CONSUL_ENABLED=false`. Opcjonalne zmienne są wymienione w `.env.example`.

Konsument zdarzeń włącza się tylko po ustawieniu `RABBITMQ_URL`; bez niego usługa działa, ale nie zwalnia rezerwacji po `order.cancelled`. Bez `JWT_JWKS_URL` rola jest odczytywana z nagłówków `X-User-Id` i `X-User-Roles`, np. `X-User-Roles: SERVICE` przy wołaniu rezerwacji z Postmana.

Brak PostgreSQL powoduje błędy 500 przy operacjach, a `/health/ready` zwraca 503. Brak RabbitMQ nie zatrzymuje REST, konsument ponawia połączenie co 5 s.

## Testy

Z katalogu `services/inventory-service`, po instalacji zależności deweloperskich:

```
python -m pytest -q
```

Testy działają na SQLite w pamięci, więc nie potrzebują PostgreSQL, RabbitMQ ani Consula. Obejmują stany, role, rezerwacje (idempotencja, brak towaru, atomowość), zwolnienie oraz zdarzenie `order.cancelled`. Blokady `FOR UPDATE` i współbieżność rezerwacji wymagają PostgreSQL i nie są objęte testami automatycznymi.

## Zależności i wdrożenie

Inventory nie woła innych usług przez REST, więc nie ma w nim circuit breakera ani ponowień. Rejestruje się w Consulu jako `inventory-service` (adres poda z `status.podIP`, health check `/health/ready` co 10 s). Wymaga PostgreSQL oraz RabbitMQ z kontem dla tej usługi.

W klastrze dane dostępowe pochodzą z Secret `inventory-service-secret` (klucze `DATABASE_URL` i `RABBITMQ_URL`), tworzonego ręcznie:

```
kubectl -n shop create secret generic inventory-service-secret \
  --from-literal=DATABASE_URL='postgresql+psycopg2://inventory:<haslo>@postgres:5432/inventory_db' \
  --from-literal=RABBITMQ_URL='amqp://inventory-service:<haslo>@rabbitmq:5672/'

kubectl apply -f k8s/
```

Deployment ma 2 repliki, requests i limity, probes oraz bezpieczny kontekst (UID 10001, `readOnlyRootFilesystem`). Obraz: `docker build -t inventory-service:latest .`. Consul jest dostępny pod `http://consul:8500`.

## Pliki

* `app/` — kod aplikacji.
* `tests/` — testy pytest.
* `Dockerfile`, `.env.example`, `requirements*.txt` — obraz, nazwy zmiennych i zależności.
* `k8s/` — ConfigMap, Deployment i Service tej usługi.
* `postman/` — kolekcja Postman tej usługi.
* [docs/OPIS-KODU.md](docs/OPIS-KODU.md) — odpowiedzialność plików, przepływ rezerwacji, współbieżność i zachowanie przy awariach.
* [docs/KONTRAKT.md](docs/KONTRAKT.md) — pola JSON, odpowiedzi i integracje.
* [docs/INTEGRACJA.md](docs/INTEGRACJA.md) — wymagania wspólnej infrastruktury.

Tożsamość jest przekazywana w nagłówkach z zaufanego Gateway albo w tokenie JWT weryfikowanym kluczem z JWKS. W klastrze niezbędne są ograniczenia ruchu sieciowego (NetworkPolicy po stronie infrastruktury). Usługa nie jest publicznym punktem wejścia do sklepu.

Wyniki sprawdzenia: [docs/WERYFIKACJA.md](docs/WERYFIKACJA.md).

