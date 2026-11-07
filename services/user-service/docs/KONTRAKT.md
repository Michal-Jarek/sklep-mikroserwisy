# Kontrakty integracyjne

Ścieżki, porty i odpowiedzialności pochodzą z architektury. Poniższe pola JSON uzupełniają kontrakty opisane w dokumencie architektury. Wymagają potwierdzenia przy integracji z pozostałymi usługami. Wszystkie identyfikatory użytkowników, produktów i adresów są UUID. Waluta w tej wersji to PLN.

## Wspólne nagłówki i błędy

`X-User-Id`: UUID zalogowanego użytkownika. `X-User-Roles`: role oddzielone przecinkami (`CUSTOMER,ADMIN,SERVICE`). `X-Request-Id`: identyfikator korelacji; jeśli brak lub ma niepoprawny format, serwis tworzy nowy. Odpowiedź zawiera też `X-Instance-Id`.

User i Cart nie sprawdzają JWT. To działa bezpiecznie dopiero z Gateway, który usuwa klienckie `X-User-*`, oraz z izolacją sieciową. Role SERVICE nie identyfikują konkretnej usługi: NetworkPolicy musi ograniczać źródła połączeń. Wewnętrzne endpointy nie mogą mieć tras publicznych w Gateway. Reguły pokazane w manifestach zakładają wspólny namespace, nazwy etykiet `app` i CNI egzekwujące NetworkPolicy.

Błąd ma postać:

```json
{"status":409,"error":"CONFLICT","message":"Brak wystarczającej liczby sztuk","requestId":"demo-1"}
```

## User :8082

| Metoda i ścieżka | Uprawnienie | Sukces |
| --- | --- | --- |
| POST `/users` | SERVICE (Auth) | 201, profil |
| GET `/users/me` | Użytkownik z poprawnym ID | 200, własny profil |
| PUT `/users/me` | Użytkownik z poprawnym ID | 200, zmieniony profil |
| GET `/users/{id}` | ADMIN lub SERVICE | 200, profil |
| GET `/users/me/addresses` | Właściciel | 200, lista adresów |
| POST `/users/me/addresses` | Właściciel | 201, nowy adres |
| DELETE `/users/me/addresses/{id}` | Właściciel | 204 |

Auth nadaje ID i wysyła:

```json
{"id":"11111111-1111-4111-8111-111111111111","firstName":"Anna","lastName":"Nowak","email":"anna@example.com"}
```

Profil ma takie same pola. PUT przyjmuje tylko `firstName` i `lastName`. Adres wejściowy:

```json
{"street":"Lipowa 1/2","city":"Warszawa","postalCode":"00-001","countryCode":"PL"}
```

Odpowiedź adresu dodaje `id`. `street` mieści ulicę, budynek i mieszkanie w jednym polu. Adres nie jest weryfikowany w zewnętrznym rejestrze. Cudzy lub nieistniejący adres przy usuwaniu daje 404. Profil można utworzyć tylko raz: powtórzenie ID lub e-maila daje 409. Auth musi obsłużyć niejednoznaczny wynik po timeout: ponowienie zapisu nie jest automatycznie sukcesem. Przepływ kompensacji przy rejestracji jest odpowiedzialnością Auth.


## Consul i odporność

Obie aplikacje FastAPI rejestrują się przez API agenta Consul. Nazwy: `user-service`, `cart-service`; każda instancja ma własne ID i adres dostępny dla Consula oraz innych usług. Adres rejestracji w klastrze musi być osiągalny z Consula i innych podów; loopback nie spełnia tego warunku. Cart pobiera tylko zdrowe instancje, cache 10 s, round robin. User nie ma połączeń wychodzących do usług biznesowych.

GET do Product i Inventory: timeout 2 s dla każdej próby HTTP, pierwsze wywołanie + maksymalnie dwa ponowienia, odstępy 100 i 200 ms. Wyszukanie w Consulu ma osobny limit 2 s. Zatem całe wywołanie może trwać dłużej niż 2 s. Circuit breaker w Pythonie: po co najmniej 10 wywołaniach sprawdza ostatnie 10 wyników; co najmniej 5 błędów otwiera obwód na 30 s. Po przerwie przepuszcza jedną próbę half-open. Sukces zamyka obwód, błąd otwiera go ponownie. 404 produktu nie jest awarią i nie podlega ponowieniom.

## Do uzgodnienia przed wspólnym wdrożeniem

- UUID i nazwy pól powyżej; sposób synchronizacji zmiany e-maila z Auth.
- Format ceny Product, pole `available` Inventory i polityka finalnej ceny w Order.
- Order pobiera `/cart` z ID klienta i SERVICE; po opłaceniu woła wewnętrzny DELETE. Obecny kontrakt usuwa cały bieżący koszyk — jeśli podczas zakupu użytkownik dopisze nowe pozycje, też zostaną usunięte. Usunięcie tylko zakupionej migawki wymaga wspólnego rozszerzenia kontraktu (wersji koszyka). Obecna wersja nie obsługuje wersjonowania koszyka.
- Dostępność Consula, etykiety podów, DNS baz, sekrety i egzekwowanie NetworkPolicy przez CNI.
- Gateway kieruje `/api/v1/users/...` i `/api/v1/cart/...` po usunięciu `/api/v1`. Nie wystawia POST `/users` ani DELETE `/cart/{userId}` klientowi. Może udostępnić GET `/users/{id}` tylko ADMIN.
- Consul KV, tracing i metryki są osobnymi rozszerzeniami. Nie wchodzą w zakres bieżącej implementacji.

## Technologia tej implementacji

User i Cart: Python 3.12 + FastAPI. User używa SQLAlchemy, psycopg i migracji Alembic; Cart — asynchronicznego klienta redis. Uzasadnienie wyboru technologii: jeden język dla obu usług, automatyczne OpenAPI i walidacja Pydantic, zachowane kontrakty REST i niezależność baz. Obie usługi wystawiają `/docs` oraz `/openapi.json`.
