# Order Service

Python 3.12, FastAPI, port 8086. PostgreSQL przechowuje zamówienia, wiadomości do wysłania i potwierdzenia przetworzonych zdarzeń. Przy starcie usługa tworzy brakujące tabele i rejestruje się w Consulu.

## Zakup

Frontend wysyła POST /api/v1/orders przez Gateway. Bezpośrednia ścieżka usługi to POST /orders. Ciało zawiera shippingAddress, shippingMethod oraz payment.cardNumber (12–19 cyfr). Używaj wyłącznie numerów testowych. Order pobiera koszyk klienta z Cart, aktualne ceny z Product i koszt metody z Shipping. Rezerwuje produkty przez Inventory. Karta kończąca się cyfrą 0 powoduje zwolnienie rezerwacji i odpowiedź 201 PAYMENT_FAILED. Pozostałe poprawne numery dają 201 PAID. Usługa zapisuje zdarzenie order.created razem z opłaconym zamówieniem i próbuje opróżnić koszyk. Numer karty nie trafia do bazy, zdarzeń ani logów HTTP.

Klient może podać nagłówek Idempotency-Key z UUID, aby wznowić zakup po przerwanym połączeniu. Przy błędzie czyszczenia koszyka opłacone zamówienie zachowuje ważność. Spóźnione automatyczne usunięcie całego koszyka mogłoby usunąć nowe produkty klienta.

| Metoda i ścieżka | Wynik |
|---|---|
| POST /orders | Szczegóły nowego zamówienia, kwoty jako tekst, waluta PLN. |
| GET /orders?page=1&size=20 | Strona własnych zamówień, najnowsze najpierw. |
| GET /orders/{id} | Szczegóły dla właściciela albo administratora. |
| POST /orders/{id}/cancel | Anulowanie NEW lub PAID. Kolejna próba daje 409 ORDER_NOT_CANCELLABLE. |
| GET /orders/purchased?userId=…&productId=… | Tylko SERVICE. Potwierdzenie zakupu dla Review. |

Anulowanie NEW albo PAID publikuje order.cancelled, aby Inventory mogło zwolnić aktywną rezerwację. Order odbiera shipment.status_changed z order.q. SHIPPED i DELIVERED aktualizują zamówienie. PREPARING i IN_TRANSIT pozostają statusami przesyłki. Przy równoczesnym anulowaniu i nadaniu wynik zależy od dostarczenia zdarzenia. Obie usługi zapisują zdarzenia wychodzące w transakcji ze stanem i publikują z potwierdzeniem brokera.

## Uruchomienie i sprawdzenie

[Instrukcja Rancher Desktop, ograniczenia integracji i test odbiorczy](../../docs/order-shipping.md). [Kontrakt frontendu](../../docs/frontend-api.md#order). [Zdarzenia](../../docs/events.md).

W katalogu usługi: `python -m pip install -r requirements.txt pytest`, potem `python -m pytest -q`. Sam serwer startuje przez `python -m uvicorn app.main:app --port 8086`. Domyślnie wymaga bazy order_db na PostgreSQL, konta order_service i zmiennej ORDER_DB_PASSWORD. RabbitMQ wymaga ORDER_RABBITMQ_PASSWORD. Kolekcja w postman/ używa bezpośredniego adresu usługi. W stosie Compose wejściem dla klienta jest Gateway.

## Wynik próby integracyjnej w Rancher Desktop (14.11.2026)

Zarejestrowany klient zalogował się przez Gateway, pobrał produkt z katalogu i dodał go do koszyka. Lista zamówień zwróciła HTTP 200. Przy POST /orders Order pobrał koszyk, cenę produktu i koszt dostawy, po czym próba rezerwacji zakończyła się HTTP 400 VALIDATION_ERROR z Inventory. Na sprawdzonym develop (4d5e220) model ReservationItem w Inventory wymaga liczbowego productId, a katalog przekazuje UUID. Pełny zakup od koszyka do opłaconego zamówienia wymaga ponownej próby po dostosowaniu Inventory.

Oddzielna próba objęła działające kontenery, PostgreSQL i RabbitMQ. Dla konta testowego przygotowano bezpośrednio w bazie Order dwa zamówienia PAID wraz ze zdarzeniami w tabeli outbox. Proces Order opublikował order.created, a Shipping utworzył przesyłki. W pierwszym przypadku zmiany statusu przez Gateway dotarły przez brokera do Order: SHIPPED po nadaniu, nadal SHIPPED podczas transportu, DELIVERED po doręczeniu. W drugim przypadku anulowanie przez POST /orders/{id}/cancel doprowadziło do CANCELLED również w Shipping. Próba rozpoczęła się po płatności; nie obejmowała rezerwacji ani zwolnienia zapasu w Inventory.

Testy lokalne Order: 8 zaliczonych. Sukces i odrzucenie płatności sprawdzono z symulowanym Inventory. Integracje odbiorców zewnętrznych (Review, Notification i Inventory) nie były częścią próby obiegu przesyłki.
