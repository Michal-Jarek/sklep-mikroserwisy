# review-service — opis kodu

## Dodanie opinii
`api.py` przyjmuje `POST /reviews`. Pydantic (`schemas.py`) sprawdza `productId`, ocenę 1–5 i długość komentarza. `security.py` ustala użytkownika z tożsamości, a nie z treści żądania.
Endpoint sprawdza, czy użytkownik nie dodał już opinii o tym produkcie (409). Potem `order_client.py` pyta Order Service, czy produkt został kupiony. Adres Ordera podaje `discovery.py` na podstawie Consula.
Gdy Order potwierdzi zakup, opinia trafia do MongoDB (201). Brak zakupu daje 403, a niedostępny Order 503 bez zapisu. Unikalny indeks `(productId, userId)` chroni przed duplikatem także przy równoległych żądaniach.

## Średnia ocena i lista
`GET /reviews/summary/{productId}` liczy średnią i liczbę opinii agregacją MongoDB. Produkt bez opinii ma `averageRating: null` i `reviewCount: 0`. `GET /reviews?productId=` zwraca opinie od najnowszych z paginacją. `DELETE /reviews/{id}` może wykonać tylko autor albo `ADMIN`.

## Wywołanie Order Service
Klient wykonuje GET z timeoutem 2 s i maksymalnie dwoma ponowieniami, tylko dla błędów sieci i 5xx. Circuit breaker otwiera obwód na 30 s po pięciu kolejnych błędach, a wtedy usługa od razu zwraca 503.

## Pliki
Ścieżki względem `services/review-service/`.

| Plik | Odpowiedzialność |
|---|---|
| `app/main.py` | Start i zamknięcie aplikacji, middleware z `X-Request-Id` i `X-Instance-Id`. |
| `app/config.py` | Ustawienia ze zmiennych środowiskowych. |
| `app/api.py` | Endpointy opinii i podsumowania oraz health checki. |
| `app/schemas.py` | Modele żądań i odpowiedzi z walidacją. |
| `app/db.py` | Klient MongoDB, kolekcja `reviews` i indeksy. |
| `app/order_client.py` | GET do Order Service, retry i circuit breaker. |
| `app/discovery.py` | Wyszukiwanie instancji Ordera w Consulu, cache 10 s, round robin. |
| `app/consul_registration.py` | Rejestracja instancji w Consulu. |
| `app/security.py` | Tożsamość z nagłówków Gateway lub JWT, sprawdzanie ról. |
| `app/errors.py`, `app/logging_config.py` | Jednolity format błędów i logi JSON. |
| `tests/` | Testy pytest na `mongomock` i atrapie klienta Order oraz atrapa Ordera do ręcznych testów. |
| `Dockerfile`, `k8s/`, `postman/` | Obraz, manifesty Kubernetes i kolekcja Postman. |

## Współbieżność
Dwie równoległe opinie tego samego użytkownika o tym samym produkcie rozstrzyga unikalny indeks w MongoDB. Przegrane żądanie dostaje 409.

## Awarie
| Sytuacja | Zachowanie |
|---|---|
| Order nie działa lub przekracza timeout | Dwa ponowienia, potem 503 bez zapisu opinii. |
| Order potwierdza brak zakupu | 403. |
| Obwód otwarty po pięciu błędach | 503 od razu, bez wołania Ordera przez 30 s. |
| Consul nie działa | Stara lista instancji, a bez niej `ORDER_SERVICE_URL`; gdy brak obu, 503. |
| MongoDB nie działa | Błąd 500, `/health/ready` zwraca 503. |
