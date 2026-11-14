# Weryfikacja inventory-service — 14 listopada 2026

* pytest: 73 testów, wszystkie przeszły, 0 pominiętych.
* Obraz Docker zbudowany z katalogu `services/inventory-service`.
* Lokalne uruchomienie z PostgreSQL: `/health/live` oraz `/health/ready` — odpowiedź 200.
* Kolekcja Postman wykonana przez Newman: 18 żądań i 29 asercji, 0 błędów.
* Manifesty Kubernetes są poprawnym YAML i wskazują namespace `shop`.

## Testy

Testy uruchamia się z katalogu `services/inventory-service` poleceniem `python -m pytest -q`. Działają na SQLite w pamięci, więc nie potrzebują PostgreSQL, RabbitMQ ani Consula. Klient testowy nie uruchamia startu aplikacji.

`tests/test_api.py` (28 testów):
* stany: odpowiedź 404 w formacie błędu zespołu z `requestId`, odczyt i ustawienie stanu przez ADMIN, stan zero jako brak towaru, odrzucenie wartości ujemnej, zakaz obniżenia stanu poniżej zarezerwowanego,
* identyfikatory: niepoprawny UUID w ścieżce daje 400, wielkie litery w UUID są normalizowane,
* role: PUT wymaga zalogowania (`X-User-Id`) i roli ADMIN, rezerwacja i zwolnienie wymagają roli SERVICE (bez niej 403, także bez nagłówków),
* tożsamość: `X-User-Id` musi być UUID, role są zbiorem z uwzględnieniem wielkości liter (`service`, `XSERVICE`, `CUSTOMER SERVICE` nie są rolą `SERVICE`, a `CUSTOMER,SERVICE` jest), niepoprawny `X-Request-Id` jest zastępowany nowym UUID,
* ścieżka z `/` na końcu daje 404, a `HEAD` działa jak `GET`,
* rezerwacje: zmniejszenie dostępnej ilości, idempotentne powtórzenie dla tego samego zamówienia, 409 `INSUFFICIENT_STOCK` bez zmiany stanów, rezerwacja produktu bez wpisu, sumowanie powtórzonych pozycji, niepoprawne ciała żądań (także liczba zamiast UUID),
* zwolnienie: przywrócenie stanu, powtórzone zwolnienie, zakaz ponownej rezerwacji zwolnionego zamówienia,
* nieznane pole w treści `PUT` daje 400,
* błąd połączenia z bazą daje 503 z `X-Request-Id`,
* health: `/health/live`, `/health/ready`, 503 przy niedostępnej bazie oraz 503 tylko po zakończeniu zadania odbiorcy zdarzeń.

`tests/test_events.py` (28 testów):
* walidacja koperty: poprawne koperty są przyjmowane, a zły JSON, brak lub zły typ `eventId`, `orderId`, `newStatus`, `requestId`, nieznana `version`, brak `payload` i `type` różny od klucza routingu są odrzucane jako `InvalidEvent`,
* `order.cancelled`: zwolnienie rezerwacji, idempotencja względem `eventId`, nieznane zamówienie bez skutku,
* `shipment.status_changed` ze statusem `SHIPPED`: wydanie towaru (maleją `quantity` i `reserved`), idempotencja, inne statusy bez zmian, późniejsze `order.cancelled` nie zwalnia wydanej rezerwacji, nieznane zamówienie bez skutku.

`tests/test_consumer.py` (3 testy): sukces w jednej próbie, ponowienia po 5 s i po 30 s przy błędach chwilowych oraz wyjątek po trzeciej nieudanej próbie (podstawa do `nack` bez ponownego kolejkowania).

`tests/test_consul.py` (5 testów): jedna rejestracja i wyrejestrowanie przy zatrzymaniu, ponowna rejestracja po usunięciu wpisu i po zmianie adresu, ponawianie rejestracji przy niedostępnym Consulu oraz treść rejestracji (ID instancji, adres, check `/health/ready`).

`tests/test_remote_config.py` (5 testów): odczyt `logLevel` z dokumentu YAML w Consul KV (także wielkie litery i JSON jako poprawny YAML), brak klucza, niepoprawne wartości i brak Consula.

`tests/test_logging.py` (4 testy): pola linii logu (`time`, `level`, `service`, `requestId`, `userId`, `msg`), wyjątek w logu bez jego treści, poziom `logLevel` tylko dla loggerów usługi i uvicorna oraz walidacja UUID.
