# inventory-service — opis kodu

## Rezerwacja towaru
`api.py` przyjmuje `POST /inventory/reservations`. Pydantic (`schemas.py`) sprawdza dane, a zależność `service_only` z `security.py` wymaga roli `SERVICE` (bez niej 403).
`service.reserve()` blokuje wiersze stanów (`SELECT ... FOR UPDATE`) w kolejności `productId`. Gdy któregoś produktu brakuje, cała rezerwacja jest wycofana i API zwraca 409 `INSUFFICIENT_STOCK`. W przeciwnym razie rośnie `reserved`, a rezerwacja dostaje status `ACTIVE`. Powtórzone żądanie dla tego samego `orderId` zwraca istniejącą rezerwację (200).

## Zwolnienie rezerwacji
`DELETE /inventory/reservations/{orderId}` oraz zdarzenie `order.cancelled` wywołują `service.release()`. Zmniejsza ona `reserved` i ustawia status `RELEASED`. Powtórzone wywołanie niczego nie zmienia. Zdarzenie `shipment.status_changed` ze statusem `SHIPPED` wywołuje `service.issue()`: zmniejsza `quantity` i `reserved` o ilość z rezerwacji i ustawia jej status `ISSUED`.
`consumer.py` odbiera zdarzenia z kolejki `inventory.q` (tylko pasywnie, bez tworzenia kolejek). `events.parse_envelope()` sprawdza kopertę, a błędną odrzuca od razu. `events.handle_event()` je przetwarza. Błąd chwilowy jest ponawiany w procesie (po 5 s, potem po 30 s, z losowym dodatkiem do +50 %), a po trzeciej próbie wiadomość jest odrzucana i broker przenosi ją do `inventory.dlq`. Zapisany `eventId` chroni przed podwójnym przetworzeniem. Co 15 s odbiorca sprawdza pasywnie, czy kolejka istnieje (`consumer.watch_queue()`); gdy jej nie ma, łączy się od nowa co 5 s.

## Pliki
Ścieżki względem `services/inventory-service/`.

| Plik | Odpowiedzialność |
|---|---|
| `app/main.py` | Start i zamknięcie aplikacji, middleware z `X-Request-Id` i `X-Instance-Id`. |
| `app/config.py` | Ustawienia ze zmiennych środowiskowych. |
| `app/api.py` | Endpointy stanów i rezerwacji oraz health checki. |
| `app/schemas.py` | Modele żądań i odpowiedzi z walidacją. |
| `app/service.py` | Logika stanów, rezerwacji i zwolnienia. |
| `app/models.py`, `app/db.py` | Tabele PostgreSQL (`stock_items`, `stock_reservations`, `processed_events`) i połączenie z bazą; `db.run()` wykonuje pracę endpointu w wątku z limitem czasu. |
| `app/events.py`, `app/consumer.py` | Walidacja i obsługa zdarzeń, odbiorca RabbitMQ z ponowieniami. |
| `app/consul_registration.py` | Rejestracja w Consulu z własnym IP (przy starcie usuwa wpis poprzedniego procesu i osierocone wpisy z tym samym adresem i portem), ponowna rejestracja po usunięciu wpisu lub zmianie adresu, wyrejestrowanie przy zatrzymaniu. |
| `app/remote_config.py` | Odczyt `logLevel` (YAML) z Consul KV przy starcie. |
| `app/security.py` | Tożsamość z nagłówków Gateway (zależności `identity`, `logged_in`, `admin_only`, `service_only`), role jako zbiór. |
| `app/errors.py`, `app/logging_config.py`, `app/ids.py` | Jednolity format błędów, logi JSON (poziom `logLevel` tylko dla loggerów usługi, biblioteki od `warning`), walidacja UUID i `requestId`. |
| `tests/` | Testy pytest na SQLite w pamięci. |
| `Dockerfile`, `k8s/`, `postman/` | Obraz, manifesty Kubernetes i kolekcja Postman. |

## Współbieżność
Blokada wiersza w PostgreSQL sprawia, że dwa zamówienia nie zarezerwują tej samej sztuki, także między replikami. Stała kolejka blokad wyklucza zakleszczenia, a ograniczenia CHECK w bazie pilnują, żeby `reserved` nie był ujemny ani większy niż `quantity`.

## Awarie
| Sytuacja | Zachowanie |
|---|---|
| Za mały stan | 409, żadna pozycja nie jest zarezerwowana. |
| PostgreSQL nie działa | Błąd połączenia daje 503 `SERVICE_UNAVAILABLE` z `X-Request-Id`, `/health/ready` zwraca 503 w mniej niż 2 s. |
| PostgreSQL nie odpowiada (zawieszony serwer) | Każda operacja na bazie kończy się najpóźniej po 2 s (503), czekanie na połączenie z puli najwyżej 2 s; `/health/live` odpowiada od razu. Praca, która skończy się po terminie (liczonym od wywołania), nie zatwierdza zmian (`before_commit` → wycofanie), więc np. rezerwacja nie zapisze się po 503. |
| PostgreSQL zniknął z sieci bez zamknięcia połączeń | Keepalive TCP i `tcp_user_timeout` zrywają połączenie po ok. 5 s; pula otwiera nowe po powrocie bazy. |
| Blokada wiersza trzymana przez inną transakcję | PostgreSQL kończy czekanie po 1,5 s (`lock_timeout`), pojedyncze zapytanie po 1,8 s (`statement_timeout`) → 503. |
| `SHIPPED` bez aktywnej rezerwacji (np. po anulowaniu) | Stan bez zmian, `warning` z `orderId` i `eventId`, zdarzenie potwierdzone. |
| RabbitMQ nie działa | REST działa, konsument ponawia połączenie. |
| Kolejka `inventory.q` usunięta | Najpóźniej po 15 s `warning` w logu, ponowne połączenie co 5 s, odbiór wraca po odtworzeniu kolejki. |
| Consul nie działa | Usługa działa, rejestracja jest ponawiana, a start bez Consula i bez konfiguracji z KV jest dozwolony. |
| Consul usunął instancję (np. po awarii bazy) | Co ok. 15 s usługa wykrywa brak wpisu i rejestruje się ponownie. |
