# Shipping Service

Python 3.12, FastAPI, port 8089. Serwis przechowuje przesyłki oraz historię w PostgreSQL. Numer śledzenia jest lokalny, a zmianę statusu wykonuje administrator.

| Metoda i ścieżka | Wynik |
|---|---|
| GET /shipping/methods | Publiczny cennik z estimatedDays. Kurier 14.99 PLN, paczkomat 9.99 PLN, odbiór osobisty 0.00 PLN. |
| GET /shipping/methods/{code} | Szczegóły metody dla Order. Nieznany kod zwraca 404. |
| GET /shipments | Strona przesyłek. Opcjonalne orderId, status, page i size. Administrator widzi wszystkie, klient własne. |
| GET /shipments/{id} | Szczegóły z historią, identyfikatorem zamówienia i numerem śledzenia. |
| PATCH /shipments/{id}/status | Administrator wysyła np. {"status":"SHIPPED"}. Przejście o jeden krok naprzód. |

Po order.created z shipping.q serwis tworzy przesyłkę PREPARING. Każde przejście dopisuje wpis historii i zdarzenie shipment.status_changed. Przy pierwszym zdarzeniu oldStatus jest null. Numer śledzenia pojawia się przy SHIPPED. Następne stany to IN_TRANSIT i DELIVERED. Powtórne polecenie ustawienia tego samego statusu zwraca 409 INVALID_STATUS_TRANSITION. Duplikat zdarzenia RabbitMQ jest potwierdzany bez ponownego skutku.

Order może anulować przesyłkę przed nadaniem przez order.cancelled. Jeśli to zdarzenie przyszło wcześniej niż order.created, Shipping zapamiętuje anulowanie bez tworzenia etykiety. Zmiany stanu i zdarzenia wychodzące są zapisywane w jednej transakcji.

## Uruchomienie i sprawdzenie

[Instrukcja Rancher Desktop, ograniczenia integracji i test odbiorczy](../../docs/order-shipping.md). [Kontrakt frontendu](../../docs/frontend-api.md#shipping). [Zdarzenia](../../docs/events.md).

W katalogu usługi: `python -m pip install -r requirements.txt pytest`, potem `python -m pytest -q`. Sam serwer startuje przez `python -m uvicorn app.main:app --port 8089`. Używa bazy shipping_db, konta shipping_service i zmiennych SHIPPING_DB_PASSWORD oraz SHIPPING_RABBITMQ_PASSWORD. Kolekcja w postman/ służy do testu bezpośredniego. W pełnym stosie klient korzysta z Gateway.

## Wynik próby integracyjnej w Rancher Desktop (14.11.2026)

Gateway zwrócił trzy metody dostawy i listę przesyłek zalogowanego klienta (HTTP 200). W rzeczywistym RabbitMQ kolejka shipping.q miała aktywnego odbiorcę. Dwa opłacone zamówienia przygotowano w bazie Order razem z wpisami outbox, aby sprawdzić przesyłki niezależnie od blokady rezerwacji w Inventory.

| Próba | Zaobserwowany wynik |
|---|---|
| Order publikuje order.created | Shipping utworzył po jednej przesyłce PREPARING dla każdego z dwóch zamówień. Klient odczytał je przez GET /shipments?orderId=… . |
| Administrator ustawia SHIPPED, IN_TRANSIT i DELIVERED przez Gateway | Shipping zwrócił numer śledzenia i dopisał statusy do historii. Po dostarczeniu zdarzeń Order pokazał kolejno SHIPPED, SHIPPED i DELIVERED. |
| Klient anuluje drugie zamówienie przez Order | Shipping odebrał order.cancelled i zmienił przesyłkę z PREPARING na CANCELLED. |

Testy lokalne Shipping: 6 zaliczonych. Próba w Rancherze potwierdza wymianę zdarzeń z Order. Wynik zakupu przez koszyk i ograniczenie Inventory opisano w [README Order](../order-service/README.md).
