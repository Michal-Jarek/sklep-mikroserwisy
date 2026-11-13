# inventory-service — opis kodu

## Rezerwacja towaru
`api.py` przyjmuje `POST /inventory/reservations`. Pydantic (`schemas.py`) sprawdza dane, a `security.py` wymaga roli `SERVICE`.
`service.reserve()` blokuje wiersze stanów (`SELECT ... FOR UPDATE`) w kolejności `productId`. Gdy któregoś produktu brakuje, cała rezerwacja jest wycofana i API zwraca 409 `INSUFFICIENT_STOCK`. W przeciwnym razie rośnie `reserved`, a rezerwacja dostaje status `ACTIVE`. Powtórzone żądanie dla tego samego `orderId` zwraca istniejącą rezerwację (200).

## Zwolnienie rezerwacji
`DELETE /inventory/reservations/{orderId}` oraz zdarzenie `order.cancelled` wywołują `service.release()`. Zmniejsza ona `reserved` i ustawia status `RELEASED`. Powtórzone wywołanie niczego nie zmienia.
`consumer.py` odbiera zdarzenie z RabbitMQ, a `events.py` je przetwarza. Wiadomość jest potwierdzana po przetworzeniu, a po trzech nieudanych próbach trafia do `inventory.dlq`. Zapisany `eventId` chroni przed podwójnym przetworzeniem.

## Pliki
Ścieżki względem `services/inventory-service/`.

| Plik | Odpowiedzialność |
|---|---|
| `app/main.py` | Start i zamknięcie aplikacji, middleware z `X-Request-Id` i `X-Instance-Id`. |
| `app/config.py` | Ustawienia ze zmiennych środowiskowych. |
| `app/api.py` | Endpointy stanów i rezerwacji oraz health checki. |
| `app/schemas.py` | Modele żądań i odpowiedzi z walidacją. |
| `app/service.py` | Logika stanów, rezerwacji i zwolnienia. |
| `app/models.py`, `app/db.py` | Tabele PostgreSQL i połączenie z bazą. |
| `app/events.py`, `app/consumer.py` | Obsługa zdarzeń i konsument RabbitMQ. |
| `app/consul_registration.py` | Rejestracja instancji w Consulu. |
| `app/security.py` | Tożsamość z nagłówków Gateway lub JWT, sprawdzanie ról. |
| `app/errors.py`, `app/logging_config.py` | Jednolity format błędów i logi JSON. |
| `tests/` | Testy pytest na SQLite w pamięci. |
| `Dockerfile`, `k8s/`, `postman/` | Obraz, manifesty Kubernetes i kolekcja Postman. |

## Współbieżność
Blokada wiersza w PostgreSQL sprawia, że dwa zamówienia nie zarezerwują tej samej sztuki, także między replikami. Stała kolejka blokad wyklucza zakleszczenia, a ograniczenia CHECK w bazie pilnują, żeby `reserved` nie był ujemny ani większy niż `quantity`.

## Awarie
| Sytuacja | Zachowanie |
|---|---|
| Za mały stan | 409, żadna pozycja nie jest zarezerwowana. |
| PostgreSQL nie działa | Błąd 500, `/health/ready` zwraca 503. |
| RabbitMQ nie działa | REST działa, konsument ponawia połączenie. |
| Consul nie działa | Usługa działa, rejestracja jest ponawiana. |
