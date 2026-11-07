# Cart Service

Koszyk zalogowanego użytkownika.

| | |
| --- | --- |
| Właściciel | @karola2001km-blip |
| Technologia | Python 3.12 · FastAPI · Redis |
| Port | 8085 |
| Nazwa w Consulu, Kubernetesie i obrazie Docker | `cart-service` |
| Namespace Kubernetes | `shop` |
| Health checki | `/health/live`, `/health/ready` |
| Dokumentacja API | `/docs`, `/openapi.json` |

## Zakres

Koszyk przechowuje nazwę produktu, cenę i ilość w hashu Redis `cart:{userId}`. TTL wynosi siedem dni od ostatniej zmiany. Cena jest pobierana z Product, a dostępność z Inventory. Atomowy zapis Lua chroni równoległe zmiany. Kwoty są obliczane przez Decimal w groszach.

| Metoda | Ścieżka | Znaczenie |
| --- | --- | --- |
| GET | `/cart` | Własny koszyk; również odczyt przez Order z ID klienta |
| POST | `/cart/items` | Zwiększenie ilości |
| PATCH | `/cart/items/{productId}` | Ustawienie ilości |
| DELETE | `/cart/items/{productId}` | Usunięcie pozycji |
| DELETE | `/cart/{userId}` | Wyczyszczenie po zakupie, tylko SERVICE |

## Uruchomienie lokalne

Wariant Compose dla User i Cart: [../user-service/dev/README.md](../user-service/dev/README.md).

Bez kontenera aplikacji, z działającym Redisem:

```sh
cd services/cart-service
python -m venv .venv
# Linux/macOS: source .venv/bin/activate
# PowerShell: .\.venv\Scripts\Activate.ps1
python -m pip install --require-hashes -r requirements-dev.lock
uvicorn app.main:app --host 127.0.0.1 --port 8085 --reload --no-access-log
```

Domyślny Redis: `redis://localhost:6379/0`, Consul: `http://localhost:8500`. Opcjonalne zmienne są wymienione w `.env.example`. Dla pracy bez Consula można ustawić `CONSUL_ENABLED=false` oraz lokalne adresy `PRODUCT_SERVICE_URL` i `INVENTORY_SERVICE_URL`.

Brak Product powoduje 503 przy dodawaniu pozycji. Brak Inventory dopuszcza zapis z `inventoryChecked:false`. Ostateczną rezerwację towaru wykonuje Order.

## Testy

Z katalogu `services/cart-service`, po instalacji zależności deweloperskich i uruchomieniu lokalnego Redisa:

```sh
python -m pytest -q
```

Testy wskazują domyślnie `redis://127.0.0.1:6379/15`. Inny adres można podać przez TEST_REDIS_URL; wymagana jest oddzielna baza nr 15. Testy usuwają tylko utworzone przez siebie klucze, nie wykonują FLUSHDB. Product, Inventory i Consul są zastępowane transportem testowym httpx.

## Zależności i wdrożenie

Cart wyszukuje `product-service` i `inventory-service` w Consulu. Lista zdrowych instancji jest przechowywana przez 10 s i wybierana round robin. GET ma timeout 2 s na próbę i maksymalnie dwa ponowienia. Circuit breaker dla każdej zależności reaguje na co najmniej pięć błędów w ostatnich dziesięciu wywołaniach i otwiera obwód na 30 s.

W klastrze adres Redisa pochodzi z Secret `cart-redis-secret`, klucz `url`. Consul jest dostępny pod `http://consul:8500`.

## Pliki

- `app/` — kod aplikacji.
- `tests/` — testy pytest.
- `requirements*.lock` — dokładne wersje i hashe zależności.
- `k8s/` — manifesty tej usługi i instrukcja ich stosowania.
- `postman/` — kolekcja Postman tej usługi.
- [docs/OPIS-KODU.md](docs/OPIS-KODU.md) — odpowiedzialność modułów i przepływ żądania.
- [docs/KONTRAKT.md](docs/KONTRAKT.md) — pola JSON, odpowiedzi i integracje.
- [docs/INTEGRACJA.md](docs/INTEGRACJA.md) — wymagania wspólnej infrastruktury.

Tożsamość jest przekazywana w nagłówkach z zaufanego Gateway. W klastrze niezbędne są ograniczenia ruchu sieciowego. Usługa nie jest publicznym punktem wejścia do sklepu.

Wyniki sprawdzenia: [docs/WERYFIKACJA.md](docs/WERYFIKACJA.md).
