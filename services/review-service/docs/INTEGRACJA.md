# Integracja review-service

Wszystkie pliki tej usługi znajdują się w `services/review-service/`. Kolekcja Postman jest w `postman/`, manifesty aplikacji w `k8s/`, opis kodu w `docs/OPIS-KODU.md`, a opis API w `docs/KONTRAKT.md`.

## Infrastruktura potrzebna usłudze

* Namespace: `shop`; port usługi: 8088; nazwa w Consulu, Kubernetesie i obrazie Docker: `review-service`; etykieta podów: `app: review-service`.
* MongoDB z bazą `review_db` i osobnym użytkownikiem. Adres pochodzi z Secret `review-service-secret`, klucz `MONGODB_URL`. Inne usługi nie czytają tej bazy.
* Consul pod `http://consul:8500`. Usługa rejestruje się jako `review-service` z adresem poda, a health check `/health/ready` sprawdza połączenie z MongoDB. Consul służy też do znalezienia Order Service.
* Secret i konto w MongoDB są tworzone poza manifestami w `k8s/`.
* Usługa nie używa RabbitMQ i nie publikuje ani nie odbiera zdarzeń.

## Kto woła Review

* **Klienci przez Gateway:** `GET /reviews?productId=` (lista opinii), `POST /reviews` (dodanie opinii) i `DELETE /reviews/{id}` (usunięcie).
* **Product:** `GET /reviews/summary/{productId}`. Odpowiedź zawiera `averageRating` (może być `null`) oraz `reviewCount`.

Kontrakty z Product i Gatewayem wymagają potwierdzenia przy implementacji tych usług.

## Do kogo woła Review

Review woła wyłącznie Order Service, przy dodawaniu opinii, żeby sprawdzić zakup:

```
GET /orders/purchased?userId=<id użytkownika>&productId=<id produktu>
```

* Adres instancji `order-service` pochodzi z Consula (tylko zdrowe instancje, wybór round robin, lista zapamiętywana na 10 s). Zmienna `ORDER_SERVICE_URL` jest adresem zapasowym, np. do pracy lokalnej bez Consula.
* Oczekiwana odpowiedź 200: `{"purchased": true}` albo `{"purchased": false}` (akceptowana jest też sama wartość `true` lub `false`).
* Do Order przekazywane są nagłówki `Authorization` (jeśli były w żądaniu) i `X-Request-Id`.
* Order musi więc przyjąć to wywołanie z tokenem użytkownika, albo trzeba uzgodnić przejście na token techniczny z rolą `SERVICE`.

## Odporność na awarię Order Service

Timeout wynosi 2 s, a ponowienia (maksymalnie dwa) dotyczą wyłącznie GET i błędów sieci oraz odpowiedzi 5xx. Po pięciu kolejnych błędach circuit breaker na 30 s odrzuca zapytania bez wołania Order. Gdy zakupu nie da się zweryfikować, opinia nie jest zapisywana i usługa zwraca 503. Brak Consula nie zatrzymuje usługi: używana jest ostatnia znana lista instancji, a gdy jej nie ma, adres `ORDER_SERVICE_URL`. Dopiero brak obu daje 503.

## Tożsamość i role w tej usłudze

Usługa ustala użytkownika i role z nagłówków `X-User-Id` i `X-User-Roles`. Gdy ustawione jest `JWT_JWKS_URL`, a żądanie ma nagłówek `Authorization: Bearer`, weryfikuje token RS256 kluczem z JWKS, a identyfikator (`sub`) i role pobiera z tokenu. Odczyt listy i podsumowania nie wymaga roli ani logowania. Dodanie opinii wymaga zalogowanego użytkownika z identyfikatorem. Usunąć opinię może jej autor albo rola `ADMIN`. Adres JWKS, `iss` i `aud` w `k8s/configmap.yaml` wymagają potwierdzenia z Auth Service.

## Konfiguracja centralna

Konfiguracja jest odczytywana ze zmiennych środowiskowych i lokalnego `.env`. Odczyt Consul KV `config/<usługa>/data` nie został zaimplementowany; wymaga wspólnego ustalenia sposobu ładowania konfiguracji.
