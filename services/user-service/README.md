# User Service

Profile klientów i adresy dostawy.

| | |
| --- | --- |
| Właściciel | @karola2001km-blip |
| Technologia | Python 3.12 · FastAPI · SQLAlchemy · Alembic · PostgreSQL |
| Port | 8082 |
| Nazwa w Consulu, Kubernetesie i obrazie Docker | `user-service` |
| Namespace Kubernetes | `shop` |
| Health checki | `/health/live`, `/health/ready` |
| Dokumentacja API | `/docs`, `/openapi.json` |

## Zakres

Profile zawierają ID nadane przez Auth, imię, nazwisko i e-mail. Adresy dostawy są powiązane z właścicielem. Dane logowania, hasła i wydawanie JWT należą do Auth. Operacje zapisu korzystają z transakcji SQLAlchemy; schemat bazy tworzy Alembic.

| Metoda | Ścieżka | Dostęp |
| --- | --- | --- |
| POST | `/users` | SERVICE, wywołanie z Auth |
| GET / PUT | `/users/me` | Własny profil |
| GET / POST | `/users/me/addresses` | Własne adresy |
| DELETE | `/users/me/addresses/{id}` | Właściciel adresu |
| GET | `/users/{id}` | ADMIN lub SERVICE |

## Uruchomienie lokalne

Wariant Compose dla User i Cart: [dev/README.md](dev/README.md).

Bez kontenera aplikacji, z działającą bazą PostgreSQL:

```sh
cd services/user-service
python -m venv .venv
# Linux/macOS: source .venv/bin/activate
# PowerShell: .\.venv\Scripts\Activate.ps1
python -m pip install --require-hashes -r requirements-dev.lock
cp .env.example .env
```

W `.env` należy ustawić DB_PASSWORD i pozostałe wartości zależne od lokalnej infrastruktury. Domyślne połączenie: `localhost:5432`, baza `user_db`, użytkownik `user_service`. Przy pracy bez Consula: `CONSUL_ENABLED=false`.

```sh
alembic upgrade head
uvicorn app.main:app --host 127.0.0.1 --port 8082 --reload --no-access-log
```

W PowerShell zamiast `cp`: `Copy-Item .env.example .env`. Opcjonalne pola `.env.example` są zakomentowane, żeby puste wpisy nie zastępowały wartości domyślnych.

## Testy

Z katalogu `services/user-service`, po instalacji zależności deweloperskich:

```sh
python -m pytest -q
```

Domyślnie testy używają tymczasowej SQLite. Dla testowego PostgreSQL należy ustawić `TEST_DATABASE_URL`, np. w formacie `postgresql+psycopg://uzytkownik:haslo@localhost:5432/test_user_db`. Testy stosują migracje i dodają rekordy, dlatego połączenie musi wskazywać bazę testową.

## Zależności i wdrożenie

W klastrze oczekiwany jest PostgreSQL `user-postgres:5432` i Consul `http://consul:8500`. Hasło bazy pochodzi z Secret `user-db-secret`, klucz `password`. Nazwa hosta bazy jest konfigurowalna. Migracja jest osobnym Jobem wykonywanym przed Deploymentem.

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
