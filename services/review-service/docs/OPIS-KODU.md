# review-service — opis kodu

## Dodanie opinii
`api.py` przyjmuje `POST /reviews`. Pydantic (`schemas.py`) sprawdza `productId` (UUID, `ids.py`), ocenę 1–5 (tylko liczba całkowita), długość komentarza i odrzuca nieznane pola. `security.py` ustala użytkownika z nagłówków `X-User-Id` i `X-User-Roles`, a nie z treści żądania.
Endpoint sprawdza, czy użytkownik nie dodał już opinii o tym produkcie (409). Potem `order_client.py` pyta Order Service, czy produkt został kupiony, w imieniu klienta: jego `X-User-Id`, jego role z dopisanym `SERVICE` i bieżący `X-Request-Id`. Adres Ordera podaje `discovery.py` na podstawie Consula.
Gdy Order potwierdzi zakup, opinia trafia do kolekcji `product_reviews` z `_id = str(uuid4())` (201). Brak zakupu daje 403, a niedostępny Order 503 bez zapisu. Unikalny indeks `uq_product_user` chroni przed duplikatem także przy równoległych żądaniach.

## Średnia ocena i lista
`GET /reviews/summary/{productId}` liczy średnią i liczbę opinii agregacją MongoDB. Produkt bez opinii ma `averageRating: null` i `reviewCount: 0`. `GET /reviews?productId=` zwraca opinie od najnowszych z paginacją. `DELETE /reviews/{reviewId}` może wykonać tylko autor albo `ADMIN`. Identyfikatory z adresu są sprawdzane przez `uuid_or_400` (400 `VALIDATION_ERROR`).

## Wywołanie Order Service
Jedna próba GET ma timeout 2 s. Po braku połączenia, timeoucie, 502, 503 i 504 są najwyżej dwa ponowienia (200 ms, 400 ms, `tenacity`). Każda próba przechodzi przez wyłącznik (`circuit_breaker.py`): `before()` przed wywołaniem (otwarty wyłącznik → od razu 503) i `after()` z wynikiem — awaria (brak połączenia, timeout, 5xx, 408, 429), sukces (200 i inne 4xx) albo wynik nieliczony (200 niezgodne z kontraktem). Co najmniej 5 awarii z ostatnich 10 wyników otwiera wyłącznik na 30 s, potem przechodzi jedno wywołanie próbne. Endpointy są synchroniczne (pula wątków), więc stan wyłącznika chroni blokada wątków, trzymana tylko na czas zmiany stanu, nie na czas wywołania.

## Pliki
Ścieżki względem `services/review-service/`.

| Plik | Odpowiedzialność |
|---|---|
| `app/main.py` | Start i zamknięcie aplikacji (indeksy, poziom logów z Consul KV, rejestracja w Consulu), middleware z `X-Request-Id`, `X-Instance-Id` i jedną linią logu na żądanie. |
| `app/config.py` | Ustawienia ze zmiennych środowiskowych, ID instancji. |
| `app/api.py` | Endpointy opinii i podsumowania oraz health checki. |
| `app/schemas.py` | Modele żądań i odpowiedzi z walidacją. |
| `app/ids.py` | UUID tekstem (walidacja, małe litery), wzorzec `X-Request-Id`. |
| `app/db.py` | Klient MongoDB z limitami czasu, kolekcja `product_reviews` i indeksy. |
| `app/order_client.py` | GET do Order Service: nagłówki, ponowienia, klasyfikacja odpowiedzi dla wyłącznika. |
| `app/circuit_breaker.py` | Wyłącznik według D2 (okno 10 wyników, 50 %, 30 s, jedno wywołanie próbne). |
| `app/discovery.py` | Wyszukiwanie instancji Ordera w Consulu, cache 10 s, round robin; pusta lista z Consula → ostatnia niepusta przez najwyżej 30 s pustych odpowiedzi. |
| `app/consul_registration.py` | Rejestracja w Consulu (przy starcie usuwa wpis poprzedniego procesu i osierocone wpisy z tym samym adresem i portem), sprawdzanie wpisu co 15 s i ponowna rejestracja, wyrejestrowanie przy zatrzymaniu. |
| `app/remote_config.py` | Odczyt `logLevel` z Consul KV `config/review-service/data`. |
| `app/security.py` | Tożsamość z nagłówków Gateway, wymaganie zalogowania. |
| `app/errors.py`, `app/logging_config.py` | Jednolity format błędów (503 dla błędów MongoDB) i logi JSON. |
| `tests/` | Testy pytest na `mongomock` i atrapach oraz atrapa Ordera do ręcznych testów. |
| `Dockerfile`, `.dockerignore`, `k8s/`, `postman/` | Obraz, wzór manifestów Kubernetes i kolekcja Postman. |

## Współbieżność
Dwie równoległe opinie tego samego użytkownika o tym samym produkcie rozstrzyga unikalny indeks w MongoDB. Przegrane żądanie dostaje 409.

## Awarie
| Sytuacja | Zachowanie |
|---|---|
| Order nie działa lub przekracza timeout | Dwa ponowienia, potem 503 bez zapisu opinii. |
| Order odpowiada 4xx (np. 403) | 503 bez ponowień; wyłącznik się nie otwiera. |
| Order potwierdza brak zakupu | 403. |
| Wyłącznik otwarty (≥ 50 % awarii z 10 wywołań) | 503 od razu, bez wołania Ordera przez 30 s, potem jedno wywołanie próbne. |
| Consul nie działa | Stara lista instancji, a bez niej `ORDER_SERVICE_URL`; gdy brak obu, 503. Rejestracja jest ponawiana, usługa działa dalej. |
| Consul zapomniał instancję | Ponowna rejestracja w ciągu ok. 15 s. |
| MongoDB nie działa albo nie odpowiada | 503 `SERVICE_UNAVAILABLE` z `requestId` najpóźniej po ok. 1,5 s, `/health/ready` 503; po powrocie bazy działa bez restartu. |
| MongoDB niedostępny przy starcie | Proces kończy się błędem (compose/Kubernetes uruchamiają go ponownie). |
