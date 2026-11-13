# Weryfikacja testy review-service — 8 listopada 2026

* pytest: 26 testów, wszystkie przeszły, 0 pominiętych.
* Obraz Docker zbudowany z katalogu `services/review-service`.
* Lokalne uruchomienie z MongoDB 7: `/health/live` oraz `/health/ready` — odpowiedź 200.
* Kolekcja Postman wykonana przez Newman (z atrapą Order Service): 16 żądań i 26 asercji, 0 błędów.
* Manifesty Kubernetes są poprawnym YAML i wskazują namespace `shop`.

## Testy

Testy uruchamia się z katalogu `services/review-service` poleceniem `python -m pytest -q`. Działają na `mongomock`, a Order Service jest zastąpiony atrapą klienta i transportem testowym httpx. Nie potrzebują MongoDB, Consula ani Order Service. Klient testowy nie uruchamia startu aplikacji.

`tests/test_api.py` (19 testów):
* dodawanie: poprawna opinia, autor z tożsamości, przekazanie `X-Request-Id` do Order Service, obcięcie spacji w komentarzu, pusty komentarz jako `null`,
* walidacja: ocena poza zakresem 1–5, `productId` ≤ 0, brak `productId`, za długi komentarz,
* uprawnienia: brak uwierzytelnienia, rola SERVICE bez identyfikatora użytkownika, usuwanie przez autora, ADMIN i obcego użytkownika,
* zasady: tylko kupujący, jedna opinia na użytkownika i produkt, 503 przy niedostępnym Order Service bez zapisu,
* lista i średnia: wymagany `productId`, kolejność od najnowszych z paginacją, produkt bez opinii, średnia i liczba opinii,
* usuwanie: nieistniejące i niepoprawne `id` dają 404,
* format błędu zespołu z `requestId`, nagłówek `X-Instance-Id` oraz health checki.

`tests/test_order_client.py` (7 testów):
* parametry zapytania do Order Service i przekazanie `Authorization`,
* odpowiedź `{"purchased": ...}` oraz samo `true`/`false`,
* dwa ponowienia przy 5xx (razem 3 próby), sukces po chwilowym błędzie,
* brak ponowień przy 4xx, błąd sieci jako niedostępność,
* circuit breaker otwiera się po powtórzonych błędach i przestaje wołać Order.