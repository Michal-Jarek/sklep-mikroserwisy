# Weryfikacja inventory-service — 14 listopada 2026 (po poprawkach z przeglądu PR #18)

* pytest: 111 testów, wszystkie przeszły, 0 pominiętych; 0 ostrzeżeń `UnsupportedFieldAttributeWarning` (FastAPI 0.128.0, pydantic 2.14.3).
* Obraz Docker zbudowany z katalogu `services/inventory-service`, uruchomiony z `--read-only --cap-drop ALL`.
* Lokalne uruchomienie z PostgreSQL 17, RabbitMQ 4.3 i Consulem: `/health/live` oraz `/health/ready` — odpowiedź 200, wpis w Consulu `passing` od razu po rejestracji.
* Baza z tabelami poprzedniej wersji (`product_id` liczbowy): usługa zakłada `stock_items` i `stock_reservations`, stare tabele zostają bez zmian, REST i rezerwacje działają.
* Usunięta kolejka `inventory.q`: `warning` w logu po 10–14 s, odbiór wraca 6 s po odtworzeniu kolejki; restart brokera: odbiór wraca 8 s po jego starcie.
* Zawieszona baza (`docker pause`) przy 60 równoległych `GET`: 0 odpowiedzi 500, każda odpowiedź ≤ 2,2 s (503), `/health/live` ≤ 0,15 s; po powrocie bazy od razu 200.
* Rezerwacja przy zablokowanym wierszu (4 s) i przy wstrzymanej bazie (`docker pause`): 503 (po 1,5 s / 2 s), a po powrocie bazy 0 rezerwacji i `reserved` 0; ten sam scenariusz na wersji sprzed poprawki zostawiał rezerwację `ACTIVE` po kompensacji.
* Baza odłączona od sieci (`docker network disconnect`) w trakcie zapytania: błąd połączenia po 5,5 s (bez keepalive i `tcp_user_timeout` — brak błędu przez 60 s); po podłączeniu `/health/ready` od razu 200.
* Niepoprawny format `DATABASE_URL` (3 warianty): start kończy się komunikatem bez adresu, hasło w logu 0 razy.
* Kolekcja Postman wykonana przez Newman dwa razy z rzędu: 21 żądań i 35 asercji, 0 błędów.
* Logi z powyższych przebiegów: 460 linii, 100 % JSON.
* Restart procesu z tym samym ID i adresem po `docker kill` (wpis w Consulu `critical`): nowy proces usuwa stary wpis i rejestruje się od nowa — `passing` po 1 s.
* Compose `sklep`, 3 × `docker kill` i `docker compose up -d --no-deps --force-recreate` (nowy kontener, nowe ID, ten sam IP): nowy proces usuwa osierocony wpis poprzedniego kontenera — dokładnie 1 wpis (`passing`) jeszcze przed stanem `healthy` kontenera.
* Manifesty Kubernetes są poprawnym YAML i wskazują namespace `shop`.

## Testy

Testy uruchamia się z katalogu `services/inventory-service` poleceniem `python -m pytest -q`. Działają na SQLite w pamięci, więc nie potrzebują PostgreSQL, RabbitMQ ani Consula. Klient testowy nie uruchamia startu aplikacji.

`tests/test_api.py` (45 testów):
* stany: odpowiedź 404 w formacie błędu zespołu z `requestId`, odczyt i ustawienie stanu przez ADMIN, stan zero jako brak towaru, odrzucenie wartości ujemnej, zakaz obniżenia stanu poniżej zarezerwowanego,
* identyfikatory: niepoprawny UUID w ścieżce daje 400, wielkie litery w UUID są normalizowane,
* role: PUT wymaga zalogowania (`X-User-Id`) i roli ADMIN, rezerwacja i zwolnienie wymagają roli SERVICE (bez niej 403, także bez nagłówków),
* tożsamość: `X-User-Id` musi być UUID, role są zbiorem z uwzględnieniem wielkości liter (`service`, `XSERVICE`, `CUSTOMER SERVICE` nie są rolą `SERVICE`, a `CUSTOMER,SERVICE` jest), niepoprawny `X-Request-Id` jest zastępowany nowym UUID,
* ścieżka z `/` na końcu daje 404, a `HEAD` działa jak `GET`,
* rezerwacje: zmniejszenie dostępnej ilości, idempotentne powtórzenie dla tego samego zamówienia (także `orderId` wielkimi literami), 409 `INSUFFICIENT_STOCK` bez zmiany stanów, rezerwacja produktu bez wpisu, sumowanie powtórzonych pozycji, niepoprawne ciała żądań (liczba zamiast UUID, `orderId` niebędący UUID, `quantity` jako `true`/`"10"`/`1.5`, nieznane pola),
* zwolnienie: przywrócenie stanu, powtórzone zwolnienie, zakaz ponownej rezerwacji zwolnionego zamówienia, 400 dla `orderId` niebędącego UUID,
* nieznane pole i `quantity` niebędące liczbą całkowitą w treści `PUT` dają 400,
* baza: błąd połączenia i brak wolnego połączenia z puli dają 503 z `X-Request-Id`, baza bez odpowiedzi daje 503 po limicie czasu, praca zakończona po terminie (także gdy wątek ruszył później) nie zapisuje zmian, praca w terminie i sesje bez terminu (odbiorca) zapisują, połączenia PostgreSQL dostają `lock_timeout`, `statement_timeout`, keepalive TCP i `tcp_user_timeout` (SQLite bez tych parametrów), log błędu 500 ma `requestId`, zły format `DATABASE_URL` bez hasła w komunikacie, nowe nazwy tabel,
* health: `/health/live` bez bazy, `/health/ready`, 503 przy niedostępnej i nieodpowiadającej bazie oraz 503 tylko po zakończeniu zadania odbiorcy zdarzeń.

`tests/test_events.py` (45 testów):
* walidacja koperty: poprawne koperty są przyjmowane (UUID zamieniane na małe litery), a zły JSON, `eventId` i `orderId` niebędące UUID, brak lub zły typ `newStatus`, nieznana `version`, brak `payload` i `type` różny od klucza routingu są odrzucane jako `InvalidEvent`; `requestId` spoza wzorca jest zastępowany nowym UUID,
* `order.cancelled`: zwolnienie rezerwacji, idempotencja względem `eventId`, nieznane zamówienie bez skutku,
* `shipment.status_changed` ze statusem `SHIPPED`: wydanie towaru (maleją `quantity` i `reserved`), idempotencja, inne statusy bez zmian, późniejsze `order.cancelled` nie zwalnia wydanej rezerwacji, `SHIPPED` bez aktywnej rezerwacji daje `warning` z `orderId` i `eventId`, duplikat zdarzenia daje tylko jedną linię logu (także przy równoległym przetworzeniu), nieznane zamówienie bez skutku.

`tests/test_consumer.py` (12 testów): sukces w jednej próbie, ponowienia po 5 s i po 30 s (z dodatkiem do +50 %) przy błędach chwilowych, wyjątek po trzeciej nieudanej próbie; `_on_message`: `ack` po przetworzeniu, `nack(requeue=False)` przy złej kopercie (także głęboko zagnieżdżony JSON i podrobiony `type`) i po 3 próbach, `eventId`/`requestId` odrzuconej koperty do logu; sprawdzanie kolejki co 15 s i ponowne połączenie po jej usunięciu, nazwa połączenia = ID instancji.

`tests/test_consul.py` (21 testów): jedna rejestracja i wyrejestrowanie przy zatrzymaniu, ponowna rejestracja po usunięciu wpisu i po zmianie adresu, ponawianie rejestracji przy niedostępnym Consulu oraz treść rejestracji (ID instancji, adres, check `/health/ready`, stan początkowy `passing`/`critical` według bazy), `INSTANCE_ID` jako pełne ID albo `inventory-service-<hostname>`, usunięcie wpisu poprzedniego procesu przy starcie (i brak tego kroku, gdy wpisu nie ma), usunięcie osieroconych wpisów (ten sam adres i port, inne ID) przed rejestracją, pozostawienie wpisów z innym adresem albo portem, ostrzeżenie i rejestracja mimo błędu sprzątania, odmowa usunięcia jednej sieroty (403) nie przerywa usuwania pozostałych (jedno ostrzeżenie z liczbą nieudanych), brak połączenia przy usuwaniu sieroty przerywa próbę, sprzątanie przy pierwszym udanym kontakcie z Consulem i tylko przy starcie.

`tests/test_remote_config.py` (5 testów): odczyt `logLevel` z dokumentu YAML w Consul KV (także wielkie litery i JSON jako poprawny YAML), brak klucza, niepoprawne wartości i brak Consula.

`tests/test_logging.py` (7 testów): pola linii logu (`time`, `level`, `service`, `requestId`, `userId`, `msg`), wyjątek w logu bez jego treści (także ślad wklejony w treść komunikatu), poziom `logLevel` tylko dla loggerów usługi, dziennik dostępu uvicorna wyłączony oraz walidacja UUID.
