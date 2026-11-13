# Product Service

Katalog sklepu: produkty, kategorie i wyszukiwanie po atrybutach. Strona produktu pokazuje ocenę (z Review) i dostępność (z Inventory).

| | |
|---|---|
| Właściciel | ([@micbanavio](https://github.com/micbanavio)) |
| Technologia | Python 3.12 · FastAPI · SQLAlchemy · Alembic · PostgreSQL |
| Port | 8083 |
| Nazwa w Consulu, Kubernetesie i obrazie Docker | `product-service` |
| Baza | PostgreSQL `product_db`, użytkownik `product_service` |
| Health checki | `/health/live`, `/health/ready` |
| Dokumentacja API | `/docs`, `/openapi.json` (tylko bezpośrednio, nie przez Gateway — D18) |

Kontrakt (ścieżki, pola, kody błędów): [docs/frontend-api.md, sekcja Product](../../docs/frontend-api.md#product). Zasady wspólne: [docs/decisions.md](../../docs/decisions.md).

## Endpointy

Ścieżki bez `/api/v1` (Gateway obcina prefiks, D12). Każdy `GET` obsługuje też `HEAD`.

| Metoda | Ścieżka | Dostęp | Odpowiedź |
|---|---|---|---|
| GET | `/products?q=&categoryId=&minPrice=&maxPrice=&sort=&page=&size=` | publiczny | 200 strona `ProductSummary` |
| GET | `/products/{productId}` | publiczny | 200 `ProductDetail` z `rating` i `availability` |
| GET | `/products/{productId}` z rolą `SERVICE` | inne usługi (Cart, Order, Review) | 200, **bez** wywołań Review i Inventory (`rating`, `availability` = `null`) i **z pominięciem cache**, prosto z bazy (D4) |
| GET | `/categories` | publiczny | 200 lista alfabetycznie |
| POST | `/products` | ADMIN | 201 `ProductDetail` |
| PUT | `/products/{productId}` | ADMIN | 200 `ProductDetail` (pełna zamiana) |
| DELETE | `/products/{productId}` | ADMIN | 204; produkt znika z katalogu (potem 404) |

Brak endpointów wewnętrznych (D10).

Najważniejsze reguły:

- identyfikatory to UUID; zły UUID → 400 `VALIDATION_ERROR` (D1);
- cena to tekst `"19.99"` razem z `"currency": "PLN"`, nigdy liczba JSON (D3);
- `q` szuka w nazwie i opisie bez względu na wielkość liter; `minPrice` > `maxPrice` → 400; nieznana kategoria w filtrze → pusta lista;
- `sort`: `NAME` (domyślnie), `PRICE_ASC`, `PRICE_DESC`, `NEWEST`; `page` od 1, `size` 1–100 (domyślnie 20);
- `POST`/`PUT`: nieznane pola → 400; nieznana kategoria → 400; `imageUrl` tylko `https://…` albo `null`; cena co najmniej `"0.01"`;
- `DELETE` nie usuwa wiersza z bazy, tylko oznacza produkt jako wycofany (`deleted_at`), bo opinie, stany i zamówienia w innych usługach dalej się do niego odnoszą. Wycofany produkt daje 404 wszędzie.

## Jak to działa

### Szczegóły produktu: Review i Inventory

`GET /products/{id}` dla klienta woła równolegle `GET /reviews/summary/{id}` (Review) i `GET /inventory/{id}` (Inventory). Adresy instancji bierze z Consula (lista trzymana 10 s, instancje po kolei). Obie informacje są opcjonalne: gdy usługa nie odpowiada, pole jest `null`, a strona produktu działa dalej.

Wywołania spełniają D2 i D5:

- każda próba ma timeout 2 s, a całe żądanie wspólny termin 8 s;
- ponowienia (najwyżej 2, po 200 i 400 ms) są tylko po braku połączenia, timeoucie, 502, 503 i 504;
- 404 to odpowiedź działającej usługi, nie awaria. Dla Inventory oznacza „produkt nie ma jeszcze stanu”;
- każda z usług ma własny wyłącznik (circuit breaker): przy co najmniej 50 % awarii w ostatnich 10 wywołaniach otwiera się na 30 s, a potem przepuszcza jedno wywołanie próbne;
- przekazywane są nagłówki `X-User-Id`, `X-User-Roles` z dopisanym `SERVICE` i `X-Request-Id` (D11).

Z rolą `SERVICE` (wołają Cart, Order i Review) Product w ogóle nie woła Review ani Inventory (D4), więc awaria tamtych usług nie blokuje koszyka ani zamówień.

### Cache

Katalog czyta się dużo częściej, niż się go zmienia, więc wyniki zapytań do bazy (listy, szczegóły, kategorie) są trzymane w pamięci przez `cacheTtlSeconds` (domyślnie 60 s). To odpowiednik Caffeine z instrukcji (zagadnienie 2). Każdy `POST`, `PUT` i `DELETE` czyści cały cache tej instancji. Przy kilku instancjach zmiana zrobiona przez inną instancję jest widoczna w katalogu najpóźniej po czasie TTL. Lekki odczyt z rolą `SERVICE` (Cart, Order) zawsze czyta bazę, bo koszyk i zamówienie zapisują cenę (D4). Ocena i dostępność nie są cache'owane, bo należą do innych usług.

### Dane startowe

Migracja `0002_demo_catalog` dodaje 4 kategorie i 24 produkty, te same (z tymi samymi UUID) co atrapy frontendu w `frontend/src/mocks/seed.ts`. Sklep pokazuje więc te same dane z atrapami i z prawdziwą usługą, a Inventory i Review mogą używać tych samych `productId`. Usunięcie danych demo: `alembic downgrade 0001`.

### Pliki

| Plik | Co robi |
|---|---|
| `app/main.py` | składa aplikację: baza, cache, Consul, endpointy, `/health/*` |
| `app/routes.py` | endpointy HTTP |
| `app/catalog.py` | logika katalogu i zapytania do bazy (bez sklejania SQL z tekstem klienta) |
| `app/clients.py` | wywołania Review i Inventory: ponowienia, termin, fallback |
| `app/breaker.py` | wyłącznik (D2) |
| `app/cache.py` | cache z czasem życia wpisu |
| `app/consul.py` | rejestracja w Consulu, konfiguracja z KV, wyszukiwanie innych usług |
| `app/web.py` | format błędów, `X-Request-Id`, `X-Instance-Id`, logi żądań, tożsamość z nagłówków |
| `app/logs.py` | logi JSON (D16) |
| `app/config.py` | ustawienia: zmienne środowiskowe > Consul KV > wartości domyślne (D14) |
| `app/models.py`, `migrations/` | tabele i migracje Alembic |
| `tests/` | testy pytest |
| `postman/` | kolekcja Postman i środowisko lokalne |
| `k8s/` | manifesty Kubernetes (Job migracji, Deployment, Service) i instrukcja w `k8s/README.md` |

## Uruchomienie z VS Code (Windows)

Wymagania: Python 3.12 (`py -3.12 --version`) i działająca wspólna infrastruktura (`docker compose -f deploy/compose.yaml up -d --wait`, [deploy/README.md](../../deploy/README.md)). Polecenia wpisuje się w **Git Bash**, w folderze `services/product-service`.

**1. Środowisko Pythona i biblioteki** (raz):

```bash
py -3.12 -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt
```

W VS Code: `Ctrl+Shift+P` → „Python: Select Interpreter” → `.venv`.

**2. Plik `.env`** z hasłem do bazy. Hasło kopiuje się tak, żeby nie pojawiło się na ekranie:

```bash
cp .env.example .env
sed -i '/^DB_PASSWORD=/d' .env
printf 'DB_PASSWORD=%s\n' "$(grep '^PRODUCT_DB_PASSWORD=' ../../deploy/.env | cut -d= -f2-)" >> .env
git check-ignore -q .env && echo IGNORED
```

Ostatnie polecenie ma wypisać `IGNORED`, czyli `.env` nie trafi do gita.

**3. Tabele i dane startowe** (raz, i po każdej nowej migracji):

```bash
.venv/Scripts/alembic upgrade head
```

**4. Start usługi:**

```bash
.venv/Scripts/python -m app
```

W logu: `Registered in Consul` i `Uvicorn running on http://127.0.0.1:8083`. Zatrzymanie: `Ctrl+C`.

**5. Sprawdzenie:**

- http://127.0.0.1:8083/products — lista produktów;
- http://127.0.0.1:8083/docs — Swagger;
- http://127.0.0.1:8500/ui → Services → `product-service` — zielony.

Gdy w Consulu check jest czerwony (`critical`), Consul z kontenera nie może dojść do usługi na laptopie. Zgłoś to Michałowi i nie zmieniaj `HOST` na `0.0.0.0` (patterns.md, sekcja 1). Z Docker Desktop zamiast Rancher Desktop może to wymagać innej wartości `SERVICE_ADDRESS`.

## Testy

```bash
.venv/Scripts/python -m pytest
```

Testy nie potrzebują Dockera: używają tymczasowej bazy SQLite z migracjami i atrap Review i Inventory. Na prawdziwym PostgreSQL uruchamia się je ze zmienną `TEST_DATABASE_URL` (np. `postgresql+psycopg://product_service:<hasło>@127.0.0.1:5432/test_db`). Testy czyszczą tę bazę, więc nie może to być `product_db`.

**Postman:** zaimportuj oba pliki z `postman/`, wybierz środowisko „product-service local” i uruchom kolekcję (Run collection) przy działającej usłudze. Nagłówki `X-User-*` są w niej wpisane ręcznie, tak jak dodałby je Gateway.

## Obraz Docker

```bash
docker build -t product-service:dev .
docker inspect -f '{{.Config.User}}' product-service:dev    # 10001, nie root
docker run --rm --entrypoint find product-service:dev /app -name '.env*'    # pusto
```

Migracje uruchamia ten sam obraz z poleceniem `alembic upgrade head` (osobny kontener `product-migrate`, D6).

## Dla Michała: wpis w `deploy/`

Do opisu PR (patterns.md, sekcja 5).

1. **Zmienne:** `PORT` (8083), `CONSUL_HOST`, `CONSUL_PORT`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (**hasło**, z `PRODUCT_DB_PASSWORD`), opcjonalnie `LOG_LEVEL`, `CACHE_TTL_SECONDS`, `SERVICE_ADDRESS`, `INSTANCE_ID`.
2. **Baza:** PostgreSQL `product_db`; migracje `alembic upgrade head` w osobnym kontenerze `product-migrate`.
3. **Zależności:** woła `review-service` (`GET /reviews/summary/{productId}`) i `inventory-service` (`GET /inventory/{productId}`), obie opcjonalne. Bez RabbitMQ i bez SMTP.
4. **Obraz:** port 8083, `USER 10001`; `/health/ready` sprawdza się przez `python` (w obrazie nie ma `curl` ani `wget`).
5. **Gateway:** zasoby `products` i `categories` są już w `api-gateway.yaml` (GET publiczne, zapis tylko `ADMIN`). Endpointów wewnętrznych nie ma.
6. **KV** (`deploy/consul/config/product-service.yaml`): proponowany klucz `cacheTtlSeconds: 60` obok `logLevel`.
7. **Zmiana kontraktu:** brak, implementacja propozycji v1 z `docs/frontend-api.md` bez zmian.

Wpis do `deploy/compose.yaml` (wzór Inventory bez RabbitMQ):

```yaml
  # One-off: applies the Product Service database migrations, then exits.
  product-migrate:
    image: product-service:dev
    build: ../services/product-service
    profiles: [full-shop]
    command: ["alembic", "upgrade", "head"]
    environment:
      DB_HOST: postgres
      DB_PORT: "5432"
      DB_NAME: product_db
      DB_USER: product_service
      DB_PASSWORD: ${PRODUCT_DB_PASSWORD:?Run deploy/create-secrets.sh}
    networks: [backend]
    restart: "no"
    depends_on:
      postgres:
        condition: service_healthy

  # No ports: reachable only inside the backend network, from outside through the Gateway.
  product-service:
    image: product-service:dev
    build: ../services/product-service
    profiles: [full-shop]
    environment:
      PORT: "8083"
      CONSUL_HOST: consul
      CONSUL_PORT: "8500"
      DB_HOST: postgres
      DB_PORT: "5432"
      DB_NAME: product_db
      DB_USER: product_service
      DB_PASSWORD: ${PRODUCT_DB_PASSWORD:?Run deploy/create-secrets.sh}
    networks: [backend]
    depends_on:
      postgres:
        condition: service_healthy
      consul:
        condition: service_healthy
      consul-kv-seed:
        condition: service_completed_successfully
      product-migrate:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8083/health/ready', timeout=2)"]
      interval: 5s
      timeout: 3s
      retries: 20
      start_period: 10s
```
