# Weryfikacja, Testy inventory-service — 8 listopada 2026

Pola w nawiasach kwadratowych uzupełnij własnymi wynikami. Usuń linię, której nie wykonałaś.

* pytest: 25 testów, wszystkie przeszły, 0 pominiętych .
* Obraz Docker zbudowany z katalogu `services/inventory-service`.
* Lokalne uruchomienie z PostgreSQL: `/health/live` oraz `/health/ready` — odpowiedź 200.
* Rejestracja w Consulu: health check w stanie [passing].
* Kolekcja Postman wykonana przez Newman: 17 żądań i 27 asercji, 0 błędów. 
* Manifesty Kubernetes są poprawnym YAML i wskazują namespace `shop`.

## Testy

Testy uruchamia się z katalogu `services/inventory-service` poleceniem `python -m pytest -q`. Działają na SQLite w pamięci. Klient testowy nie uruchamia startu aplikacji.

`tests/test_api.py` (18 testów):
* stany: odpowiedź 404 w formacie błędu zespołu z `requestId`, odczyt i ustawienie stanu przez ADMIN, stan zero jako brak towaru, odrzucenie wartości ujemnej, zakaz obniżenia stanu poniżej zarezerwowanego,
* role: PUT wymaga uwierzytelnienia i roli ADMIN, rezerwacja i zwolnienie wymagają roli SERVICE,
* rezerwacje: zmniejszenie dostępnej ilości, idempotentne powtórzenie dla tego samego zamówienia, 409 `INSUFFICIENT_STOCK` bez zmiany stanów, rezerwacja produktu bez wpisu, sumowanie powtórzonych pozycji, niepoprawne ciała żądań,
* zwolnienie: przywrócenie stanu, powtórzone zwolnienie, zakaz ponownej rezerwacji zwolnionego zamówienia,
* health: `/health/live`, `/health/ready` oraz 503 przy niedostępnej bazie.

`tests/test_events.py` (7 testów):
* `order.cancelled` zwalnia rezerwację,
* to samo zdarzenie przetworzone dwa razy zmienia stan raz,
* zdarzenie dla nieznanego zamówienia i inne typy zdarzeń nie zmieniają stanu,
* zdarzenia niepoprawne (nie obiekt, brak `eventId`, pusty `orderId`) kończą się wyjątkiem, czyli ponowieniem i kolejką `inventory.dlq`.

