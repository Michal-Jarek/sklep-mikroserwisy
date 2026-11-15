# Weryfikacja review-service — 14 listopada 2026

* pytest: 110 testów, wszystkie przeszły, 0 pominiętych (w `python:3.12-slim`, ostrzeżenia `UserWarning` traktowane jak błędy, 0 × `UnsupportedFieldAttributeWarning`).
* Obraz Docker zbudowany z katalogu `services/review-service`; proces działa jako UID 10001 (bez roota), z systemem plików tylko do odczytu.
* Stos testowy z MongoDB 8.0 (użytkownik `review_service` ze skryptu `deploy/mongo/init/`), Consulem 1.21 i atrapą Order Service zarejestrowaną w Consulu jako `order-service`:
  * UUID: `POST` 201 z `id` jako UUID, `GET /reviews?productId=<uuid>` i `GET /reviews/summary/<uuid>` 200 (także UUID wielkimi literami), `DELETE` 204; zły UUID w zapytaniu, ścieżce i treści oraz nieznane pole → 400 `VALIDATION_ERROR`; dokumenty w `product_reviews` z `_id` i `productId` tekstem, stara kolekcja `reviews` nietknięta;
  * atrapa Order dostaje `X-User-Id` klienta, `X-User-Roles` z `SERVICE` (`CUSTOMER,SERVICE`, `ADMIN,SERVICE`) i `X-Request-Id`, bez `Authorization`;
  * 5 × 403 od Order nie otwiera wyłącznika (6. wywołanie dochodzi), 5 awarii 500 w oknie 10 wyników otwiera go (kolejne żądania 503 bez wywołania Order);
  * MongoDB zatrzymany (`docker stop`) i zawieszony (`docker pause`): 10 żądań → 503 `SERVICE_UNAVAILABLE` z `requestId` i nagłówkiem `X-Request-Id`, najdłużej 1,51 s; `/health/live` 200; po powrocie bazy 200 bez restartu;
  * Consul zatrzymany na 15 s, po starcie przez 2,5 s pusta lista `passing` dla `order-service`: 3 rundy po 19 × `POST /reviews` bez 503 (poprzednia wersja: 19 × 503);
  * Consul zawieszony (`docker pause`): pierwsze `POST /reviews` 2,0 s, kolejne ok. 0,005 s (wcześniej każde 2,0 s); Consul i Order zawieszone jednocześnie: 503 po 8,6 s (wcześniej 12,6 s), poniżej 10 s Gateway; log błędu Consula z samą klasą wyjątku;
  * `GET /reviews?page=99999999999999999999` i `page=1000001` → 400 `VALIDATION_ERROR` (wcześniej pierwsze 500), `page=1000000` → 200;
  * `logLevel: debug` z Consul KV ustawia poziom logów, gdy `LOG_LEVEL` nie jest ustawione (wzorcowy `k8s/configmap.yaml` go nie ustawia);
  * wpis w Consulu wyrejestrowany ręcznie wraca po 8,5–14,2 s (3 próby); po `docker kill` i ponownym starcie wpis jest od razu `passing`;
  * 89 linii logu z tych przebiegów, wszystkie JSON z polami `time`, `level`, `service`, `requestId`, `userId`, `msg`; 0 śladów wyjątków, hasło do bazy 0 razy.
* Kolekcja Postman wykonana przez newman dwa razy z rzędu (z atrapą Order Service): 20 żądań i 35 asercji, 0 błędów.
* Manifesty Kubernetes są poprawnym YAML i wskazują namespace `shop`.

## Testy

Testy uruchamia się z katalogu `services/review-service` poleceniem `python -m pytest -q`. Działają na `mongomock`, a Order Service jest zastąpiony atrapą klienta i transportem testowym httpx. Nie potrzebują MongoDB, Consula ani Order Service. Klient testowy nie uruchamia startu aplikacji.

`tests/test_api.py` (28 testów):
* dodawanie: poprawna opinia z `id` jako UUID, `productId` małymi literami, autor z nagłówka, obcięcie spacji w komentarzu, pusty komentarz jako `null`,
* nagłówki do Order Service: `X-User-Id`, role klienta z dopisanym `SERVICE`, `X-Request-Id`, bez `Authorization`,
* walidacja: ocena poza 1–5 albo nie liczba całkowita, `productId` niebędący UUID, brak `productId`, za długi komentarz, nieznane pole, `X-User-Id` niebędący UUID,
* uprawnienia: brak uwierzytelnienia, rola SERVICE bez identyfikatora użytkownika, usuwanie przez autora, ADMIN i obcego użytkownika,
* zasady: tylko kupujący, jedna opinia na użytkownika i produkt, 503 przy niedostępnym Order Service bez zapisu,
* lista i średnia: wymagany `productId`, 400 dla złego UUID i `page` poza 1–1 000 000, kolejność od najnowszych z paginacją, produkt bez opinii, średnia i liczba opinii,
* usuwanie: nieistniejące `reviewId` 404, niepoprawne (także dawny ObjectId) 400, `reviewId` wielkimi literami,
* 503 z `requestId` przy błędach MongoDB, format błędu zespołu, `X-Request-Id` spoza wzorca zamieniany na UUID, health checki.

`tests/test_order_client.py` (25 testów): parametry i nagłówki zapytania, odpowiedź poza kontraktem (bez ponowień), ponowienia tylko dla 502/503/504 i błędów sieci (razem 3 próby), odstępy 200 ms i 400 ms, brak ponowień dla 500, 408, 429 i 4xx, brak instancji bez wywołania, 5 × 403 nie otwiera wyłącznika, otwarcie po awariach i brak ponowień przy otwartym wyłączniku.

`tests/test_circuit_breaker.py` (10 testów): zamknięty poniżej 10 wyników, otwarcie przy 50 % z ostatnich 10, wyniki nieliczone, jedno wywołanie próbne po 30 s (podmieniony zegar) — sukces zamyka, awaria otwiera ponownie, wynik starego wywołania ignorowany, blokada nie jest trzymana na czas wywołania, praca z wielu wątków.

`tests/test_discovery.py` (13 testów): pusta lista z Consula po niepustej → ostatnia znana lista bez zapisu w cache i z jedną linią logu, seria pustych dłuższa niż 30 s albo brak listy → brak instancji, limit liczony od pierwszej pustej odpowiedzi, długa awaria Consula nie postarza listy, niepusta odpowiedź zeruje licznik, powrót do zwykłej pracy; po błędzie Consula ostatnia lista na 10 s od chwili błędu (ponowienia nie czekają znowu na Consula), log z samą klasą wyjątku, błąd bez żadnej listy → brak instancji; linia `info` po powrocie instancji także po wygaśnięciu ostatniej listy i po błędzie Consula w trakcie serii; przerywane błędy Consula (co 20 s, pusta lista co 2 s) nie zaczynają serii od nowa.

`tests/test_k8s_manifests.py` (1 test): wzorcowy `k8s/configmap.yaml` nie ustawia `LOG_LEVEL`.

`tests/test_consul.py` (21 testów), `tests/test_remote_config.py` (5), `tests/test_logging.py` (7): rejestracja i ponowna rejestracja w Consulu, usunięcie wpisu poprzedniego procesu przy starcie, usunięcie osieroconych wpisów (ten sam adres i port, inne ID; błąd sprzątania nie blokuje rejestracji), stan początkowy checku według bazy, ID instancji, odczyt `logLevel` z Consul KV, logi JSON bez treści wyjątków.
