# Integracja review-service

Wszystkie pliki tej usługi znajdują się w `services/review-service/`. Kolekcja Postman jest w `postman/`, wzór manifestów w `k8s/`, opis kodu w `docs/OPIS-KODU.md`, a opis API w `docs/KONTRAKT.md`.

## Infrastruktura potrzebna usłudze

* Namespace: `shop`; port usługi: 8088; nazwa w Consulu, Kubernetesie i obrazie Docker: `review-service`.
* MongoDB z bazą `review_db` i osobnym użytkownikiem `review_service` (tylko `readWrite` na `review_db`), tworzonym przez `deploy/mongo/init/`. Adres pochodzi ze zmiennej `MONGODB_URL` (w klastrze Secret `review-service-secret`, klucz `MONGODB_URL`). Inne usługi nie czytają tej bazy. Usługa używa kolekcji `product_reviews`; dawnej kolekcji `reviews` nie czyta i nie usuwa.
* Consul pod `http://consul:8500`. Usługa rejestruje się jako `review-service` (ID `INSTANCE_ID` albo `review-service-<hostname>`, adres `SERVICE_ADDRESS` albo własny IP), a health check `/health/ready` sprawdza połączenie z MongoDB. Rejestracja zawiera tylko pola `ID`, `Name`, `Address`, `Port` i `Check` (`HTTP`, `Interval`, `Timeout`, `DeregisterCriticalServiceAfter`, `Status`). Consul służy też do znalezienia Order Service i jako źródło `logLevel` (KV `config/review-service/data`).
* Usługa nie używa RabbitMQ i nie publikuje ani nie odbiera zdarzeń.

## Kto woła Review

* **Klienci przez Gateway:** `GET /reviews?productId=` (lista opinii), `POST /reviews` (dodanie opinii) i `DELETE /reviews/{reviewId}` (usunięcie).
* **Product:** `GET /reviews/summary/{productId}`. Odpowiedź zawiera `averageRating` (może być `null`) oraz `reviewCount`.

## Do kogo woła Review

Review woła wyłącznie Order Service, przy dodawaniu opinii, żeby sprawdzić zakup:

```
GET /orders/purchased?userId=<UUID użytkownika>&productId=<UUID produktu>
```

* Endpoint jest wewnętrzny: Order wpuszcza tylko rolę `SERVICE`. Review przekazuje `X-User-Id` klienta, `X-User-Roles` = role klienta i `SERVICE` (np. `CUSTOMER,SERVICE`) oraz `X-Request-Id`. Token nie jest przekazywany.
* Adres instancji `order-service` pochodzi z Consula (tylko zdrowe instancje, wybór po kolei, lista zapamiętywana na 10 s). Pusta lista z Consula (np. tuż po jego restarcie, zanim checki przejdą) nie jest zapamiętywana; dopóki Consul zwraca pustą listę najwyżej 30 s bez przerwy, Review używa ostatniej niepustej, a awaria Consula tej listy nie postarza. Gdy zapytanie do Consula się nie uda (np. zawieszony Consul), ostatnia lista jest używana przez kolejne 10 s bez ponownego pytania, więc ponowienia wywołania Order nie czekają znowu 2 s na Consula. Przy przerywanych błędach Consula ostatnia lista może działać dłużej niż 30 s: błąd nie zaczyna serii pustych odpowiedzi od nowa, ale po każdym błędzie ostatnia lista wraca na 10 s, także gdy seria przekroczyła już 30 s. Brak instancji (503) dopiero po dłuższej serii pustych odpowiedzi albo gdy żadnej listy nie było. Zmienna `ORDER_SERVICE_URL` jest adresem zapasowym, np. do pracy lokalnej bez Consula.
* Oczekiwana odpowiedź 200: `{"purchased": true}` albo `{"purchased": false}`.
* W Kubernetesie NetworkPolicy musi przepuszczać ruch z `review-service` do `order-service:8086`.

## Odporność na awarię Order Service

Timeout jednej próby wynosi 2 s, a ponowienia (najwyżej dwa, po 200 ms i 400 ms) dotyczą braku połączenia, timeoutu, 502, 503 i 504. Wyłącznik według D2 (`app/circuit_breaker.py`) liczy jako awarie tylko brak połączenia, timeout, 5xx, 408 i 429; przy co najmniej 50 % awarii z ostatnich 10 wywołań na 30 s odrzuca zapytania bez wołania Order. Odpowiedzi 4xx (np. 403) nie otwierają wyłącznika. Gdy zakupu nie da się zweryfikować, opinia nie jest zapisywana i usługa zwraca 503. Brak Consula nie zatrzymuje usługi: używana jest ostatnia znana lista instancji, a gdy jej nie ma, adres `ORDER_SERVICE_URL`. Dopiero brak obu daje 503.

## Tożsamość i role w tej usłudze

Usługa ustala użytkownika i role wyłącznie z nagłówków `X-User-Id` (UUID) i `X-User-Roles`, które ustawia Gateway po sprawdzeniu tokenu. Sama nie sprawdza tokenów i nie ma kluczy JWT. Odczyt listy i podsumowania nie wymaga roli ani logowania. Dodanie opinii wymaga zalogowanego użytkownika z identyfikatorem. Usunąć opinię może jej autor albo rola `ADMIN`.

## Konfiguracja centralna

Przy starcie usługa czyta z Consul KV klucz `config/review-service/data` (YAML, pole `logLevel`). Zmienna `LOG_LEVEL` ma pierwszeństwo, a bez Consula albo bez klucza usługa startuje z wartościami domyślnymi. Pozostała konfiguracja pochodzi ze zmiennych środowiskowych (nazwy w `.env.example`).
