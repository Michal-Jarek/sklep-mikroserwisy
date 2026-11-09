# user-service — struktura kodu

## Obsługa żądania

Przepływ dla `PUT /users/me`:

1. Uvicorn uruchamia obiekt `app` z `app/main.py`. Funkcja `create_app()` składa aplikację, bazę, router i obsługę błędów.
2. Middleware w `http_support.py` odczytuje lub tworzy `X-Request-Id`. Dzięki temu można połączyć logi tego samego żądania w różnych usługach.
3. FastAPI dopasowuje metodę w `routes.py`. Pydantic sprawdza JSON według `UpdateUser` z `schemas.py`.
4. Zależność `current_user()` z `security.py` odczytuje `X-User-Id` i role. ID właściciela nie pochodzi z JSON, więc użytkownik nie wybiera sobie cudzego profilu.
5. `session_dependency()` tworzy sesję SQLAlchemy na czas żądania i przekazuje ją do funkcji endpointu przez `Depends`.
6. `ProfileService.update()` rozpoczyna transakcję, pobiera profil przez repozytorium i ustawia imię i nazwisko.
7. `with session.begin()` zatwierdza zmianę po poprawnym zakończeniu; wyjątek powoduje wycofanie. SQLAlchemy generuje parametryzowane zapytanie SQL.
8. `UserView` jest serializowany do JSON. Pythonowe `first_name` wraca jako `firstName` dzięki aliasom Pydantic.

### Pliki User Service

Wszystkie ścieżki w tabeli są względem `services/user-service/`.

| Plik | Odpowiedzialność |
| --- | --- |
| `app/main.py` | Składa FastAPI, sesje bazy, rejestrację w Consulu, endpointy zdrowia i mapowanie błędów SQLAlchemy. |
| `app/config.py` | Odczytuje zmienne środowiskowe. Buduje URL PostgreSQL z bezpiecznym kodowaniem hasła. |
| `app/database.py` | Tworzy silnik SQLAlchemy, pulę połączeń i sesję na czas żądania. |
| `app/models.py` | Encje `UserProfile` i `Address`: opis tabel, kolumn, UUID, klucza obcego i unikalnego e-maila. |
| `app/schemas.py` | DTO Pydantic: pola wejścia/wyjścia, długości, e-mail, kraj i nazwy camelCase. |
| `app/repository.py` | Zapytania do bazy. `owned_address()` szuka jednocześnie po ID adresu i ID właściciela. |
| `app/service.py` | Reguły biznesowe, transakcje, tworzenie i edycja profilu oraz operacje adresów. |
| `app/routes.py` | Ścieżki HTTP, zależności `Depends`, wymagane uprawnienia, modele odpowiedzi i statusy 201/204. |
| `app/security.py` | Wymusza tożsamość oraz role CUSTOMER, ADMIN i SERVICE. Nie weryfikuje JWT. |
| `app/http_support.py` | Request ID, nagłówki odpowiedzi, logi JSON, jednolite błędy i dokumentacja nagłówków w OpenAPI. |
| `app/discovery.py` | Rejestruje i wyrejestrowuje instancję w Consulu; wspólny klient discovery. User nie wywołuje innych usług biznesowych. |
| `alembic.ini`, `migrations/env.py` | Konfiguracja narzędzia migracji; korzysta z tego samego adresu bazy co aplikacja. |
| `migrations/versions/0001_profiles.py` | Pierwsza migracja: tabele profili i adresów, UNIQUE e-maila, klucz obcy i indeks. |
| `migrations/script.py.mako` | Szablon następnych migracji Alembic. |
| `tests/conftest.py` | Izolowana baza testowa, zastosowanie migracji oraz klient HTTP testowanej aplikacji. |
| `tests/test_users.py` | Testy API profilu, walidacji, uprawnień, właściciela adresu, konfliktów i zdrowia. |

### Ważne decyzje w User

Profil korzysta z UUID konta nadanego przez Auth. Nowe adresy mają własne UUID. E-maila nie można zmienić przez `PUT /users/me`, ponieważ jest również loginem w Auth, a architektura nie określa przepływu jego synchronizacji.

`models.py` opisuje bazę, a `schemas.py` opisuje API. To rozdzielenie chroni przed przypadkowym ujawnieniem wewnętrznych pól i pozwala zmieniać sposób zapisu bez zmiany kontraktu HTTP. `extra="forbid"` odrzuca dodatkowe pola, np. próbę dopisania sobie roli ADMIN.

Alembic tworzy schemat osobnym poleceniem `alembic upgrade head`; aplikacja nie tworzy automatycznie tabel przy każdym starcie. Kolejne zmiany schematu są zapisywane jako nowe migracje. Zastosowana migracja `0001` pozostaje niezmienna.
