# Review Service

Oceny i opinie o produktach oraz średnia ocena produktu.

| | |
|---|---|
| Właściciel | Aleksandra Krzeszewska |
| Technologia | Python 3.12 · FastAPI · MongoDB |
| Port | 8088 |
| Nazwa w Consulu, Kubernetesie i obrazie Docker | `review-service` |
| Namespace Kubernetes | `shop` |
| Health checki | `/health/live`, `/health/ready` |
| Dokumentacja API | `/docs` |

## Zakres

Usługa przechowuje w MongoDB (`review_db`, kolekcja `reviews`) opinie o produktach: ocenę 1–5 i opcjonalny komentarz do 2000 znaków. Opinię może dodać tylko użytkownik, który kupił produkt (usługa pyta Order Service), i najwyżej jedną o danym produkcie. Unikalny indeks `(productId, userId)` chroni przed duplikatem także przy równoległych żądaniach. Średnia ocena i liczba opinii są liczone agregacją MongoDB.

| Metoda | Ścieżka | Kto | Znaczenie |
|---|---|---|---|
| GET | `/reviews?productId=&page=&size=` | Gateway | Lista opinii od najnowszych: `items`, `page`, `size`, `total`; `productId` jest wymagany |
| POST | `/reviews` | zalogowany użytkownik | `{productId, rating, comment}`; 201, 403 gdy nie kupił produktu, 409 gdy już ocenił, 503 gdy nie można sprawdzić zakupu |
| DELETE | `/reviews/{id}` | autor lub ADMIN | Usunięcie opinii; 204, 403 dla cudzej opinii, 404 gdy nie istnieje |
| GET | `/reviews/summary/{productId}` | Product | `{productId, averageRating, reviewCount}`; bez opinii `averageRating` jest `null` |

Błędy mają format `{"status", "error", "message", "requestId"}`. Gateway udostępnia endpointy pod `/api/v1/...`, usługa widzi ścieżki bez prefiksu.

## Uruchomienie lokalne

Bez kontenera aplikacji, z działającą MongoDB i atrapą Order Service:

```
cd services/review-service
python -m venv .venv
# Linux/macOS: source .venv/bin/activate
# PowerShell: .\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
python tests/mock_order_service.py
```

Atrapa Order Service nasłuchuje na porcie 8086 i uznaje każdy produkt za kupiony poza `productId=999`. Zostaw ją w osobnym oknie, a w drugim uruchom usługę:

```
export MONGODB_URL=mongodb://localhost:27017/review_db
export ORDER_SERVICE_URL=http://localhost:8086
export CONSUL_ENABLED=false
uvicorn app.main:app --host 127.0.0.1 --port 8088 --reload --no-access-log
```

`MONGODB_URL` jest wymagany, a indeksy są zakładane przy starcie. Domyślny Consul: `http://consul:8500`, dlatego lokalnie `CONSUL_ENABLED=false`, a adres Order Service podaje `ORDER_SERVICE_URL`. Opcjonalne zmienne są wymienione w `.env.example`.

Bez `JWT_JWKS_URL` tożsamość jest odczytywana z nagłówków `X-User-Id` i `X-User-Roles`, np. `X-User-Id: u1` przy dodawaniu opinii z Postmana. Brak Order Service powoduje 503 przy dodawaniu opinii. Bez działającej MongoDB usługa nie wystartuje, a gdy baza przestanie odpowiadać później, operacje zwracają 500, a `/health/ready` 503.

## Testy

Z katalogu `services/review-service`, po instalacji zależności deweloperskich:

```
python -m pytest -q
```

Testy działają na `mongomock`, a Order Service jest zastępowany atrapą klienta i transportem testowym httpx, więc nie potrzebują MongoDB, Consula ani Order Service. Obejmują dodawanie i walidację opinii, uprawnienia, duplikaty, listę, średnią, usuwanie oraz klienta Order (ponowienia i circuit breaker). Unikalny indeks jest sprawdzany tylko na `mongomock`.

## Zależności i wdrożenie

Review woła wyłącznie Order Service, przy dodawaniu opinii (`GET /orders/purchased`). Adres `order-service` pochodzi z Consula, a lista zdrowych instancji jest przechowywana przez 10 s i wybierana round robin. GET ma timeout 2 s i maksymalnie dwa ponowienia. Circuit breaker po pięciu kolejnych błędach otwiera obwód na 30 s, a wtedy usługa od razu zwraca 503. Review rejestruje się w Consulu jako `review-service` (adres poda z `status.podIP`, health check `/health/ready` co 10 s).

W klastrze adres MongoDB pochodzi z Secret `review-service-secret` (klucz `MONGODB_URL`), tworzonego ręcznie:

```
kubectl -n shop create secret generic review-service-secret \
  --from-literal=MONGODB_URL='mongodb://review:<haslo>@mongodb:27017/review_db'

kubectl apply -f k8s/
```

Deployment ma 2 repliki, requests i limity, probes oraz bezpieczny kontekst (UID 10001, `readOnlyRootFilesystem`). Obraz: `docker build -t review-service:latest .`. Consul jest dostępny pod `http://consul:8500`.

## Pliki

* `app/` — kod aplikacji.
* `tests/` — testy pytest oraz atrapa Order Service do ręcznych testów.
* `Dockerfile`, `.env.example`, `requirements*.txt` — obraz, nazwy zmiennych i zależności.
* `k8s/` — ConfigMap, Deployment i Service tej usługi wraz z instrukcją.
* `postman/` — kolekcja Postman tej usługi.
* [docs/OPIS-KODU.md](docs/OPIS-KODU.md) — odpowiedzialność plików, przepływ dodania opinii, współbieżność i zachowanie przy awariach.
* [docs/KONTRAKT.md](docs/KONTRAKT.md) — pola JSON, odpowiedzi i wywołanie Order Service.
* [docs/INTEGRACJA.md](docs/INTEGRACJA.md) — wymagania wspólnej infrastruktury.

Tożsamość jest przekazywana w nagłówkach z zaufanego Gateway albo w tokenie JWT weryfikowanym kluczem z JWKS. W klastrze niezbędne są ograniczenia ruchu sieciowego (NetworkPolicy po stronie infrastruktury). Usługa nie jest publicznym punktem wejścia do sklepu.

Wyniki sprawdzenia: [docs/WERYFIKACJA.md](docs/WERYFIKACJA.md).
