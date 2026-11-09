# Decyzje dla usług sklepu

Ten dokument zbiera zasady wiążące każdą usługę sklepu (D1–D20): co obowiązuje, dlaczego i gdzie są szczegóły. Jak je spełnić krok po kroku (praca z VS Code, przykład w Pythonie, wpis w Docker Compose) — [patterns.md](patterns.md); zdarzenia RabbitMQ — [events.md](events.md).

**Zmiana decyzji.** Decyzję zmienia Michał. Propozycję zmiany opisuje się w opisie PR (z numerem decyzji i powodem) albo zgłasza Michałowi bezpośrednio. Do czasu zmiany obowiązuje treść z tego dokumentu. Numery D1–D9 pochodzą z przeglądów PR #1 i #2 i się nie zmieniają; nowe decyzje dostają kolejne numery.

## Ściągawka

| D | Zasada w jednym zdaniu | Kogo dotyczy |
|---|---|---|
| [D1](#d1--identyfikatory) | Identyfikator encji to UUID zapisany tekstem, małymi literami; niepoprawny UUID → 400 `VALIDATION_ERROR`. | wszystkie usługi |
| [D2](#d2--wyłącznik-i-ponowienia) | Wywołanie innej usługi: timeout 2 s, wyłącznik (≥ 10 wywołań, ≥ 50 % awarii → 30 s), awaria to tylko brak połączenia, timeout, 5xx, 408, 429; ponowienia tylko `GET`/`HEAD`, najwyżej 2. | usługi, które wołają inne (np. Auth, Cart, Order, Review) |
| [D3](#d3--kwoty) | Kwota to tekst z dwoma miejscami po kropce (`"19.99"`) razem z `currency`, nigdy liczba JSON. | Product, Cart, Order, Shipping, zdarzenia |
| [D4](#d4--lekki-odczyt-produktu) | `GET /products/{id}` z rolą `SERVICE` nie woła Review ani Inventory i zwraca co najmniej `id`, `name`, `price`, `currency`. | Product (wołają go Cart i Order) |
| [D5](#d5--budżet-czasu) | Gateway czeka 10 s; usługa odpowiada w < 9 s, a przy kilku wywołaniach po kolei ma wspólny termin 8 s. | wszystkie usługi, zwłaszcza Cart i Order |
| [D6](#d6--konwencje-deploy-i-zmienne-środowiskowe) | Jedna nazwa usługi wszędzie, hosty i bazy jak w `deploy/`, hasła tylko ze zmiennych środowiskowych, `deploy/` zmienia Michał. | wszystkie usługi |
| [D7](#d7--format-i-kody-błędów) | Błąd ma format `{"status", "error", "message", "requestId"}` i kod z listy wspólnej albo z rejestru kodów domenowych. | wszystkie usługi, frontend |
| [D8](#d8--profil-użytkownika-przy-rejestracji) | `POST /users` jest wewnętrzny i idempotentny po `id`: 201, powtórzenie 200, ten sam `id` z innymi danymi 409; formatu `email` User nie sprawdza (robi to Auth). | User, Auth |
| [D9](#d9--własność-kodu-pr-i-dokumenty) | PR do `develop` z akceptacją code ownera; zmiana kontraktu wymaga zgody usług, które wołają. | wszyscy |
| [D10](#d10--endpointy-wewnętrzne) | Endpoint wewnętrzny bez roli `SERVICE` → 403; nowy endpoint wewnętrzny zgłasza się Michałowi. | User, Cart, Inventory, Order i każda nowa usługa z takim endpointem |
| [D11](#d11--tożsamość-i-nagłówki) | Usługa ufa `X-User-Id` i `X-User-Roles` od Gateway, nie sprawdza JWT, sama pilnuje własności danych. | wszystkie usługi |
| [D12](#d12--ścieżki) | Ścieżki bez `/api/v1`, bez `/` na końcu i bez przekierowań; `HEAD` jak `GET`. | wszystkie usługi |
| [D13](#d13--consul-rejestracja-i-wyszukiwanie) | Rejestracja w Consulu z własnym IP, unikalnym ID i checkiem `/health/ready`; start bez Consula, ponowna rejestracja, wyrejestrowanie przy SIGTERM. | wszystkie usługi |
| [D14](#d14--konfiguracja-z-consul-kv) | Konfiguracja z `config/<usługa>/data` (YAML) przy starcie; zmienne środowiskowe > KV > wartości domyślne; w KV nigdy sekretów. | wszystkie usługi |
| [D15](#d15--zdrowie-usługi) | `/health/live` bez zależności, `/health/ready` zależy od własnej bazy, nie od brokera ani innych usług. | wszystkie usługi |
| [D16](#d16--logi) | Logi JSON na stdout z `requestId` i `userId`; nigdy hasła, tokeny ani pełne dane osobowe. | wszystkie usługi |
| [D17](#d17--kontener-i-zamykanie) | Obraz bez roota (numeryczny UID), `.dockerignore` wyklucza `.env` we wszystkich folderach (`**/.env`); po SIGTERM koniec w < 10 s. | wszystkie usługi |
| [D18](#d18--dokumentacja-api) | OpenAPI w każdej usłudze, pod domyślnymi ścieżkami biblioteki, bez dostępu przez Gateway. | wszystkie usługi |
| [D19](#d19--zdarzenia) | Zdarzenia według `docs/events.md`: klucz routingu = `type`, `ack` po zapisie, idempotencja po `eventId`, nigdy `requeue=true`. | Auth, Order, Shipping, Notification, Inventory |
| [D20](#d20--testy-i-postman) | Testy jednostkowe i kolekcja Postman w folderze usługi. | wszystkie usługi |

## D1 — Identyfikatory

**Zasada.** Każdy identyfikator encji to **UUID zapisany tekstem, małymi literami** — w ścieżkach i w JSON. Dotyczy to m.in. `userId` (= `sub` z tokenu), `productId`, `categoryId`, `orderId`, `addressId`, `reservationId`, `shipmentId`, `reviewId`, `notificationId`. Identyfikator tworzy właściciel encji (UUID w wersji 4); wyjątek: profil w User dostaje `id` od Auth (D8). MongoDB: `_id` dokumentu = `str(uuid4())` nadany przy zapisie, nie ObjectId. Kody słownikowe (np. metoda dostawy `COURIER`, statusy) to słowa `UPPER_SNAKE`, nie identyfikatory. Niepoprawny UUID w ścieżce, w query albo w treści żądania → **400 `VALIDATION_ERROR`**.

**Dlaczego.** Usługi przekazują sobie identyfikatory (Cart → Inventory, Order → Product, Review → Order). Gdy jedna usługa ma liczbę, a druga UUID, główny przepływ zakupu nie działa (przegląd PR #1 i #2). UUID może utworzyć każda usługa sama, bez pytania bazy innej usługi.

**Jak sprawdzić / szczegóły.** W FastAPI robi to typ parametru `uuid.UUID` razem z handlerem zamieniającym 422 na 400 — endpoint `GET /example/items/{item_id}` w [przykładzie](patterns.md#2-przykład-w-pythonie-consul-kv-logi-zdrowie). Sprawdzenie: `curl -s http://<usługa>/<zasób>/123` → 400 `VALIDATION_ERROR`, nie 404 ani 500.

## D2 — Wyłącznik i ponowienia

**Zasada.** Opis dotyczy **zachowania**; biblioteka jest dowolna.

- Jeden wyłącznik (circuit breaker) na usługę docelową. Timeout **2 s** na każdą próbę.
- **Awaria** to: brak połączenia, timeout, odpowiedź 5xx, 408, 429.
- **Nie jest awarią** każda inna odpowiedź, w tym 400, 401, 403, 404, 409 — to odpowiedź działającej usługi, nie jej awaria. Odpowiedź 2xx niezgodna z kontraktem (np. brak pola, zły typ) nie jest ponawiana i nie liczy się do wyłącznika: usługa obsługuje ją jak brak danych (fallback) i zapisuje błąd w logu.
- **Otwarcie:** co najmniej **10 wywołań** w oknie (ostatnie 10 wywołań albo ostatnie 60 s) i **≥ 50 % awarii** → wyłącznik otwarty na **30 s**. W tym czasie od razu fallback z tabeli połączeń w dokumencie architektury, bez wywołania; gdy wynik jest niezbędny — **503 `SERVICE_UNAVAILABLE`**. Po 30 s przechodzi **jedno** wywołanie próbne: sukces zamyka wyłącznik, awaria otwiera go na kolejne 30 s.
- Wyłącznik nie trzyma blokady (lock) przez czas wywołania.
- **Ponowienia** tylko dla `GET` i `HEAD`, najwyżej **2**, z rosnącym odstępem (np. 200 ms, potem 400 ms), tylko po braku połączenia, timeoucie, 502, 503, 504. Wyjątek: idempotentny `POST /users` z tym samym `id` (D8).
- Ustawienia bibliotek:
  - Java — Resilience4j: `COUNT_BASED`, okno 10, próg 50 %, otwarcie 30 s, 1 wywołanie w stanie półotwartym, wyjątki dla odpowiedzi 4xx poza 408 i 429 w `ignoreExceptions`.
  - Node.js — opossum (jak Auth). Auth (opossum) otwiera wyłącznik przy ponad połowie awarii, a nie przy co najmniej połowie — różnica bez znaczenia.
  - Python — własna mała klasa według opisu zachowania wyżej. `pybreaker` jest niedozwolony: trzyma blokadę przez czas wywołania, a w kodzie `async` nie liczy błędów.
- Gateway ma inne reguły (awarią są dla niego tylko błędy sieci, 502 i 504). Usługa nie kopiuje zachowania Gateway.

**Dlaczego.** Odpowiedź 4xx wynika z danych żądania. Gdyby liczyła się jako awaria, błędne żądania jednego klienta otwierałyby wyłącznik i odcinały usługę wszystkim na 30 s, a ponowienia potrajałyby ruch do usługi, która odpowiada poprawnie (przegląd PR #1 i #2). Ponowienie `POST` mogłoby utworzyć coś dwa razy.

**Jak sprawdzić / szczegóły.** Kroki i tabela „odpowiedź → awaria? ponowić?”: [patterns.md, sekcja 4](patterns.md#4-wywołanie-innej-usługi). Wzorzec w Node.js: [Auth → User](../services/auth-service/README.md#rejestracja-i-user-service). Reguły Gateway (dla porównania): [circuit breaker Gateway](../services/api-gateway/README.md#circuit-breaker).

## D3 — Kwoty

**Zasada.** Kwota to **tekst z dwoma miejscami po kropce** (`"19.99"`, wzorzec `^[0-9]{1,8}\.[0-9]{2}$`) razem z polem **`currency`** (na razie tylko `"PLN"`). Dotyczy REST i zdarzeń, odpowiedzi i żądań. Nigdy liczba JSON (`19.99`). Obliczenia na typach dziesiętnych: Java `BigDecimal` z `@JsonFormat(shape = JsonFormat.Shape.STRING)`, Python `Decimal` z `quantize(Decimal("0.01"))`.

**Dlaczego.** Liczba zmiennoprzecinkowa nie zapisuje dokładnie groszy (`0.1 + 0.2` ≠ `0.3`), a różne biblioteki zapisują ją różnie (`20`, `20.0`, `2E+1`). Tekst o stałym formacie każda usługa czyta tak samo. Spring Boot domyślnie zapisuje `BigDecimal` jako liczbę, dlatego potrzebna jest adnotacja.

**Jak sprawdzić / szczegóły.** Kwoty w zdarzeniach: [events.md, zdarzenia w wersji 1](events.md#zdarzenia-w-wersji-1). W testach: odpowiedź z kwotą ma `"price": "19.99"` (w cudzysłowie) i `"currency": "PLN"`.

## D4 — Lekki odczyt produktu

**Zasada.** `GET /products/{id}` z rolą `SERVICE` w `X-User-Roles` **nie woła Review ani Inventory** i zwraca co najmniej `id`, `name` (≤ 200 znaków), `price`, `currency`. Pola oceny i dostępności są pominięte albo `null`. Brak produktu (także wycofanego) → 404. Z tego odczytu korzystają Cart i Order.

**Dlaczego.** Pełny odczyt produktu dla klienta pokazuje ocenę (Review) i dostępność (Inventory). Gdyby Cart i Order dostawały ten sam odczyt, awaria Review blokowałaby dodawanie do koszyka i składanie zamówień, a każde wywołanie trwałoby dłużej (D5).

**Jak sprawdzić / szczegóły.** `curl -s -H 'X-User-Roles: SERVICE' http://<product-service>/products/<id>` przy zatrzymanym Review i Inventory → 200 z `id`, `name`, `price`, `currency`. Nagłówki usług: [D11](#d11--tożsamość-i-nagłówki).

## D5 — Budżet czasu

**Zasada.** Gateway czeka na odpowiedź usługi **10 s** (potem odpowiada klientowi 504). Usługa odpowiada w najgorszym przypadku w **< 9 s**. Jedno wywołanie `GET` z ponowieniami (D2) trwa najwyżej ok. 6,6 s (3 próby × 2 s + odstępy); wywołanie innej metody — jedna próba, 2 s. Usługa, która woła kilka usług po kolei, ma **wspólny termin 8 s na całe żądanie**: kolejną próbę zaczyna tylko wtedy, gdy zmieści się w terminie; po terminie fallback albo 503 `SERVICE_UNAVAILABLE`.

**Dlaczego.** Ponowienia sumują się. Przykład: Cart przy dodaniu do koszyka woła `GET` Product i `GET` Inventory — bez wspólnego terminu najgorszy przypadek to ok. 13 s, czyli 504 z Gateway, choć Cart w końcu by odpowiedział.

**Jak sprawdzić / szczegóły.** [patterns.md, sekcja 4](patterns.md#4-wywołanie-innej-usługi); czas oczekiwania Gateway: [przebieg żądania w Gateway](../services/api-gateway/README.md#przebieg-żądania).

## D6 — Konwencje deploy i zmienne środowiskowe

**Zasada.**

- Nazwa usługi = nazwa w Consulu = nazwa w Docker Compose = nazwa obrazu (np. `review-service`, tabela usług w głównym [README](../README.md)).
- Hosty w sieci compose: `consul`, `postgres`, `mongo`, `redis-cart`, `rabbitmq`, `mailpit`. Porty z laptopa: tabela w [deploy/README.md](../deploy/README.md).
- Bazy i użytkownicy:
  - PostgreSQL: baza `<usługa>_db`, użytkownik `<usługa>_service` (user, product, inventory, order, shipping);
  - MongoDB: `review_db` / `review_service`, `notification_db` / `notification_service`, w adresie `authSource` = baza usługi;
  - Redis koszyka: serwer `redis-cart` z hasłem;
  - SMTP: `mailpit:1025`, bez logowania i bez TLS.
- **Zalecane** nazwy zmiennych środowiskowych:

  | Do czego | Zmienne |
  |---|---|
  | Consul | `CONSUL_HOST`, `CONSUL_PORT` |
  | baza (PostgreSQL i MongoDB) | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` |
  | Redis | `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` |
  | SMTP | `SMTP_HOST`, `SMTP_PORT` |
  | RabbitMQ | `RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD` ([events.md](events.md#konta-uprawnienia-i-zmienne)) |
  | rejestracja i logi | `SERVICE_ADDRESS`, `INSTANCE_ID`, `LOG_LEVEL` |

  Usługa może czytać inne nazwy (np. `DATABASE_URL`) — wpis w compose zbuduje wartość z hasła z `deploy/.env`. Adres połączenia z hasłem (np. `DATABASE_URL`, `MONGODB_URL`) usługa przekazuje tylko bibliotece: nie loguje go i nie zwraca w błędach ([D16](#d16--logi)). Zmienne RabbitMQ są ustalone w `events.md` (cztery osobne zmienne, bez adresu z hasłem) i nie zmieniają się.
- **Wymagane:** hasła wyłącznie ze zmiennych środowiskowych — nigdy w pliku w repo ani w obrazie. W repo tylko `.env.example` z samymi nazwami; `.dockerignore` wyklucza `.env` we wszystkich folderach (wzorce `**/.env`, `**/.env.*` — sam `.env` działa tylko w głównym folderze kontekstu budowy).
- Hasła z `deploy/create-secrets.sh` to cyfry i litery `a–f`, więc można je wstawić do adresu `mongodb://` bez kodowania. Hasło ustawione ręcznie ze znakami `@`, `:` albo `/` psuje taki adres.
- Folder `deploy/` i pliki KV zmienia Michał, na prośbę właściciela usługi. Wpis usługi w `deploy/compose.yaml` powstaje przy scaleniu jej PR.
- Migracje bazy: osobny jednorazowy kontener `<usługa>-migrate` (jak `auth-migrate`) albo przy starcie usługi, jeśli są bezpieczne przy kilku instancjach uruchomionych naraz.

**Dlaczego.** Jedna nazwa w Consulu, compose i k8s pozwala Gateway i innym usługom znaleźć usługę bez dodatkowej konfiguracji. Każda usługa ma własną bazę i własne hasło, więc nie czyta cudzych danych. Hasło w pliku w repo albo w obrazie trafia do historii gita i do każdego, kto pobierze obraz.

**Jak sprawdzić / szczegóły.** Praca z VS Code przy infrastrukturze z compose: [patterns.md, sekcja 1](patterns.md#1-usługa-z-vs-code-przy-infrastrukturze-z-compose); wzór wpisu w compose i lista „co podać Michałowi”: [patterns.md, sekcja 5](patterns.md#5-wpis-usługi-w-docker-compose); migracje: [patterns.md, sekcja 6](patterns.md#6-migracje-bazy). Sprawdzenie obrazu: `docker run --rm --entrypoint find <obraz> /app -name '.env*'` (`/app` = katalog aplikacji w obrazie) → wynik pusty.

## D7 — Format i kody błędów

**Zasada.** Każda odpowiedź błędu ma treść:

```json
{"status": 404, "error": "NOT_FOUND", "message": "Product not found", "requestId": "6e0f8a7c-1b2d-4e3f-8a9b-0c1d2e3f4a5b"}
```

`requestId` = otrzymany `X-Request-Id` (D16). Kody wspólne:

| Status | `error` | Kiedy |
|---|---|---|
| 400 | `VALIDATION_ERROR` | błędne dane wejściowe, także błędy walidacji FastAPI — **domyślne 422 FastAPI trzeba zamienić na 400**; w Springu własny handler zamiast domyślnego `/error` |
| 401 | `UNAUTHORIZED` | brak zalogowania, np. endpoint wymaga logowania, a żądanie nie ma `X-User-Id` |
| 403 | `FORBIDDEN` | brak uprawnień (np. cudzy zasób, endpoint wewnętrzny bez `SERVICE`) |
| 404 | `NOT_FOUND` | brak zasobu albo nieznana ścieżka |
| 405 | `METHOD_NOT_ALLOWED` | metoda nieobsługiwana na istniejącej ścieżce |
| 409 | `CONFLICT` albo kod domenowy | konflikt ze stanem danych |
| 413 | `PAYLOAD_TOO_LARGE` | za duża treść żądania |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | nieobsługiwany `Content-Type` |
| 429 | `TOO_MANY_REQUESTS` | limit żądań; z nagłówkiem `Retry-After` |
| 500 | `INTERNAL_ERROR` | nieoczekiwany błąd; bez stack trace w odpowiedzi (szczegóły tylko w logu) |
| 503 | `SERVICE_UNAVAILABLE` | niedostępna zależność, otwarty wyłącznik (D2), usługa niegotowa |

502 i 504 zwraca tylko Gateway. `message` jest dla programisty (język dowolny), bez danych osobowych. Kody domenowe zapisuje się `UPPER_SNAKE`.

### Rejestr kodów domenowych

Kody, które istnieją dziś. Nowy kod domenowy → zgłoszenie Michałowi (dopisuje go tutaj), bo frontend dobiera komunikat dla klienta po kodzie.

| Usługa | Status | `error` | Kiedy |
|---|---|---|---|
| Auth | 401 | `INVALID_CREDENTIALS` | złe hasło albo nieznany e-mail (ta sama odpowiedź w obu przypadkach) |
| Auth | 409 | `EMAIL_TAKEN` | e-mail już zarejestrowany |
| Auth | 429 | `TOO_MANY_ATTEMPTS` | e-mail zablokowany na 15 min po 10 nieudanych logowaniach; z `Retry-After` |
| Inventory | 409 | `INSUFFICIENT_STOCK` | za mało towaru do rezerwacji |

Pełna lista odpowiedzi Auth: [README Auth, sekcja „Endpointy”](../services/auth-service/README.md#endpointy).

**Dlaczego.** Frontend i inne usługi rozpoznają błąd po `error`, nie po tekście `message`. W przeglądach PR #1 i #2 te same błędy miały różne kody (`BAD_REQUEST` i `VALIDATION_ERROR`, `INTERNAL_SERVER_ERROR` i `INTERNAL_ERROR`), a FastAPI domyślnie odpowiada 422 w innym formacie.

**Jak sprawdzić / szczegóły.** Handlery FastAPI (422 → 400, 404 i 405 w formacie zespołu, 500 bez stack trace): [patterns.md, sekcja 2](patterns.md#2-przykład-w-pythonie-consul-kv-logi-zdrowie). Walidacja wejścia (typy pól, filtry MongoDB, SQL z parametrami): [patterns.md, sekcja 10](patterns.md#10-walidacja-wejścia). Kody błędów Gateway: [README Gateway](../services/api-gateway/README.md#kody-błędów).

## D8 — Profil użytkownika przy rejestracji

**Zasada.** `POST /users` jest endpointem wewnętrznym (D10). Treść żądania (tak wysyła Auth): `{"id", "email", "firstName", "lastName"}`, wszystkie pola tekstowe; `id` to UUID nowego konta (D1). Endpoint jest idempotentny po `id`:

| Żądanie | Odpowiedź |
|---|---|
| pierwsze z danym `id` | **201** z profilem |
| powtórzenie z tym samym `id` i tymi samymi danymi | **200** z istniejącym profilem |
| ten sam `id` z innymi danymi | **409 `CONFLICT`** |

User przyjmuje `email` jako tekst do 254 znaków **bez własnej walidacji formatu** — format sprawdza Auth. E-mail **nie** jest unikalny w User (unikalny jest w Auth). Auth woła `POST /users` z `X-User-Id` = nowe `id`, `X-User-Roles: SERVICE`, timeoutem 2 s, jednym ponowieniem po 200 ms z tym samym `id` i wyłącznikiem; przy awarii wycofuje konto i odpowiada klientowi 503. Po scaleniu User do Docker Compose Auth dostaje `USER_SERVICE_ENABLED=true`.

**Dlaczego.** Auth nie wie, czy pierwsza próba doszła do User (np. timeout po zapisie profilu). Ponowienie z tym samym `id` jest bezpieczne tylko wtedy, gdy User traktuje je jako to samo żądanie. Unikalność e-maila w dwóch miejscach dawałaby konflikt przy ponowieniu i rozjazd danych. Auth jest źródłem prawdy o koncie: gdy User odrzuci dane, które Auth już przyjął (np. e-mail w domenie `sklep.local`, której używa konto administratora), Auth wycofuje rejestrację, a klient dostaje 503.

**Jak sprawdzić / szczegóły.** [README Auth, sekcja „Rejestracja i User Service”](../services/auth-service/README.md#rejestracja-i-user-service). Test: dwa razy to samo `POST /users` z `X-User-Roles: SERVICE` → 201, potem 200; trzeci raz z innym `email` → 409; nowe `id` z `email` `anna@sklep.local` → 201, nie 400. W Pydantic pole `email` to `str` z `max_length=254`, nie `EmailStr` (odrzuca m.in. domeny `.local` i `.test`).

## D9 — Własność kodu, PR i dokumenty

**Zasada.** Właściciele usług są w tabeli w głównym [README](../README.md) i w [.github/CODEOWNERS](../.github/CODEOWNERS). PR idzie do `develop` (squash), `develop` → `main` przez merge commit; wymagana jest akceptacja code ownera. Zmiana kontraktu (ścieżki, pola JSON, kody odpowiedzi, zdarzenia) wymaga zgody usług, które ją wołają (tabela połączeń w dokumencie architektury), i opisu w PR (pole „Zmiana kontraktu?” w szablonie PR).

**Dlaczego.** Bez wpisu w `CODEOWNERS` reguły repozytorium nie znajdą osoby, która może zaakceptować PR. Zmiana kontraktu zrobiona po cichu psuje usługę, która z niego korzysta, dopiero po scaleniu.

**Jak sprawdzić / szczegóły.** Szablon PR: [.github/pull_request_template.md](../.github/pull_request_template.md).

## D10 — Endpointy wewnętrzne

**Zasada.** Endpoint wewnętrzny wołają tylko inne usługi. Wymaga roli `SERVICE` w `X-User-Roles`, inaczej **403 `FORBIDDEN`**. Gateway dodatkowo blokuje go z zewnątrz (404, reguła `blocked`). Dziś: `POST /users`, `DELETE /cart/{userId}`, `/inventory/reservations/**`, `GET /orders/purchased`. `GET /users/{id}`: rola `ADMIN` albo `SERVICE`. Nowy endpoint wewnętrzny → zgłoszenie Michałowi przed scaleniem PR (bez reguły w Gateway jest dostępny dla każdego zalogowanego klienta; usługa i tak odpowie 403, ale zgłoszenie jest obowiązkowe).

**Dlaczego.** Dwie warstwy: reguła w Gateway ukrywa endpoint przed klientami, a sprawdzenie roli w usłudze chroni go także wtedy, gdy reguły zabraknie (Gateway nigdy nie przekazuje `SERVICE` od klienta). Rola **nie** chroni przed kimś, kto dociera do usługi z pominięciem Gateway — taki ktoś sam ustawi `X-User-Roles: SERVICE` ([D11](#d11--tożsamość-i-nagłówki)).

**Jak sprawdzić / szczegóły.** Rolę sprawdza się w zależności (w FastAPI `Depends`), a nie w treści funkcji endpointu: wtedy żądanie bez `SERVICE` dostaje 403, zanim usługa sprawdzi pola treści (sprawdzenie w funkcji dałoby najpierw 400 przy błędnej treści). Wzorzec: zależność `service_only` i endpoint `GET /example/internal` w [przykładzie](patterns.md#2-przykład-w-pythonie-consul-kv-logi-zdrowie). Test: `curl -s -X POST http://<user-service>/users` bez `X-User-Roles` → 403; przez Gateway `POST /api/v1/users` → 404. Reguły Gateway: [README Gateway, „Reguły dostępu”](../services/api-gateway/README.md#reguły-dostępu).

## D11 — Tożsamość i nagłówki

**Zasada.**

- Usługa ufa nagłówkom `X-User-Id` (UUID) i `X-User-Roles` (lista po przecinku: `CUSTOMER`, `ADMIN`; `SERVICE` dodaje usługa wołająca). Ustawia je tylko Gateway; nagłówki `X-User-*` od klienta Gateway usuwa.
- Usługa **nie** sprawdza JWT, nie ma kluczy JWT ani biblioteki JWT i nie dostaje nagłówka `Authorization`.
- **Endpoint publiczny działa bez `X-User-*`** (klient anonimowy). Gdy klient wyśle ważny token, nagłówki są i usługa może z nich korzystać. Brak nagłówków nie może dawać 401 na trasie publicznej.
- Endpoint wymagający logowania bez `X-User-Id` → 401 `UNAUTHORIZED`.
- Endpoint wewnętrzny ([D10](#d10--endpointy-wewnętrzne)) nie wymaga `X-User-Id` (praca w tle go nie ma); wystarcza rola `SERVICE`.
- Własność danych: klient widzi i zmienia tylko swoje zasoby (porównanie z `X-User-Id`); `ADMIN` może więcej.
- Wywołanie innej usługi: przekaż `X-User-Id` (gdy działasz w imieniu użytkownika), `X-User-Roles` = otrzymane role + `SERVICE` (np. `CUSTOMER,SERVICE`) i `X-Request-Id`. Praca w tle (np. odbiorca zdarzeń): `X-User-Roles: SERVICE` i `X-User-Id` z danych zdarzenia, jeśli jest. Dotyczy też Review → Order (sprawdzenie zakupu z tożsamością klienta).

**Dlaczego.** Token sprawdza jedno miejsce (Gateway), więc usługi nie potrzebują kluczy i nie mogą sprawdzać go różnie. Gateway nie wie jednak, do kogo należy zamówienie czy adres — to wie tylko usługa. Zaufanie do nagłówków jest bezpieczne **tylko dlatego, że do usługi nie da się dojść z pominięciem Gateway**: w compose usługa nie ma `ports:`, w k8s ma `ClusterIP` i NetworkPolicy, a uruchomiona z VS Code nasłuchuje na `127.0.0.1` ([patterns.md, sekcja 1](patterns.md#1-usługa-z-vs-code-przy-infrastrukturze-z-compose)). Każda inna droga do usługi pozwala każdemu wysłać `X-User-Roles: ADMIN,SERVICE`.

**Jak sprawdzić / szczegóły.** [README Gateway, „Nagłówki, które dostaje usługa”](../services/api-gateway/README.md#nagłówki-które-dostaje-usługa). Wzorzec odczytu tożsamości: zależności `identity` i `logged_in` w [przykładzie](patterns.md#2-przykład-w-pythonie-consul-kv-logi-zdrowie) — role to zbiór elementów nagłówka po `split(",")`, sprawdzany elementami (`"SERVICE" in roles`). Nie szuka się podciągu w nagłówku (przepuści `XSERVICE`) ani nie porównuje całego nagłówka (`== "SERVICE"` odrzuci `CUSTOMER,SERVICE`). Test: `GET` cudzego zasobu z `X-User-Id` innego klienta i `X-User-Roles: CUSTOMER` → 403 albo 404.

## D12 — Ścieżki

**Zasada.** Usługa wystawia ścieżki bez `/api/v1` (Gateway obcina prefiks: `/api/v1/products/12` → `/products/12`). Bez tras z `/` na końcu i bez przekierowań (FastAPI: `redirect_slashes=False`; Gateway odrzuca `/` na końcu jako 400). `HEAD` działa jak `GET` (FastAPI sam tego nie robi — przykład w [patterns.md, sekcja 2](patterns.md#2-przykład-w-pythonie-consul-kv-logi-zdrowie)). Segmenty ścieżki tylko ze znaków `A–Z a–z 0–9 . _ ~ -` (identyfikatory jako UUID, kody jako słowa); tekst wyszukiwania w query. Zalecenie (nie wymóg): wszystkie ścieżki w jednym pliku albo module stałych.

**Dlaczego.** Przekierowanie 307 z `/products/` na `/products` wskazuje adres wewnętrzny usługi, którego klient za Gateway nie osiągnie. Gateway sprawdza reguły dostępu na kanonicznej ścieżce — usługa musi rozumieć ścieżkę tak samo.

**Jak sprawdzić / szczegóły.** `curl -s -o /dev/null -w '%{http_code}' http://<usługa>/<zasób>/` → 404 (nie 307); `curl -I http://<usługa>/<zasób>` → nie 405. Reguły Gateway: [kanoniczna ścieżka](../services/api-gateway/README.md#kanoniczna-ścieżka), [trasy](../services/api-gateway/README.md#trasy).

## D13 — Consul: rejestracja i wyszukiwanie

**Zasada.**

- Rejestracja: nazwa = nazwa usługi; ID instancji unikalne (`<usługa>-<hostname>`); **adres = własny IP instancji**, nie nazwa usługi z compose (przy `--scale` wszystkie instancje miałyby ten sam adres); z VS Code `host.docker.internal`; port z tabeli usług.
- Check HTTP `/health/ready` co 10 s, timeout 2 s, `DeregisterCriticalServiceAfter` 1 min.
- Rejestracja po starcie serwera HTTP. **Start bez Consula**: usługa działa i ponawia rejestrację w tle. **Ponowna rejestracja**: co ok. 15 s usługa sprawdza, czy jej wpis istnieje z aktualnym adresem, i rejestruje się ponownie, gdy go nie ma (np. po restarcie Consula). Wyrejestrowanie przy SIGTERM.
- Każda odpowiedź usługi ma nagłówek **`X-Instance-Id`** = ID instancji.
- Wyszukiwanie innych usług: `/v1/health/service/<nazwa>?passing`, lista trzymana 10 s, instancje po kolei (round robin), przy błędzie Consula ostatnia znana lista, instancja bez połączenia wypada z listy do następnego odświeżenia (jak w Gateway). Adresów innych usług nie wpisuje się na sztywno.

**Dlaczego.** Gateway i inne usługi znajdują instancje tylko przez Consul. Bez ponownej rejestracji usługa znika z Consula po jego restarcie i jest niedostępna do restartu usługi; bez startu bez Consula kolejność startu kontenerów decyduje, czy usługa działa (przegląd PR #1 i #2). ID z nazwy hosta (`<usługa>-<hostname>`) jest takie samo po restarcie procesu w tym samym kontenerze, więc nowa rejestracja nadpisuje własny stary wpis. ID losowe zostawiłoby stary wpis obok nowego: przy nowym adresie do `DeregisterCriticalServiceAfter` (1 min), a przy tym samym adresie — dopóki instancja działa (check starego wpisu trafia do nowego procesu i przechodzi). `X-Instance-Id` pokazuje load balancing na prezentacji.

**Jak sprawdzić / szczegóły.** Działający przykład w Pythonie: [patterns.md, sekcja 2](patterns.md#2-przykład-w-pythonie-consul-kv-logi-zdrowie); pokaz load balancingu: [patterns.md, sekcja 8](patterns.md#8-pokaz-load-balancingu); rejestracja i wyszukiwanie w Gateway: [README Gateway, „Rejestracja w Consulu”](../services/api-gateway/README.md#rejestracja-w-consulu).

## D14 — Konfiguracja z Consul KV

**Zasada.** Klucz KV `config/<usługa>/data` (YAML) usługa czyta przy starcie. Pierwszeństwo: **zmienne środowiskowe > KV > wartości domyślne** w kodzie. Bez klucza albo bez Consula usługa startuje na wartościach domyślnych i zapisuje ostrzeżenie w logu. W KV nigdy sekretów. Po zmianie KV — restart usługi. Plik źródłowy: `deploy/consul/config/<usługa>.yaml` (np. [review-service.yaml](../deploy/consul/config/review-service.yaml)), wgrywany do Consula przy każdym `docker compose … up`; nowe klucze proponuje właściciel usługi, plik zmienia Michał.

**Dlaczego.** Ta sama usługa działa w compose, z VS Code i w k8s z różnymi ustawieniami bez przebudowy obrazu. Zmienna środowiskowa wygrywa, żeby przy pracy lokalnej i w testach dało się nadpisać pojedynczą wartość.

**Jak sprawdzić / szczegóły.** Przykład odczytu KV (`GET /example/config`): [patterns.md, sekcja 2](patterns.md#2-przykład-w-pythonie-consul-kv-logi-zdrowie).

## D15 — Zdrowie usługi

**Zasada.** `GET /health/live` → 200 `{"status":"UP"}`, gdy proces działa (bez sprawdzania zależności). `GET /health/ready` → 200, gdy usługa może obsłużyć ruch (osiągalna własna baza), inaczej 503 w formacie błędu (D7). Broker **nie** jest warunkiem gotowości: `/health/ready` = 503 tylko wtedy, gdy zadanie odbiorcy zdarzeń się zakończyło (decyzja Michała 2026-11-09). Utrata połączenia z brokerem nie kończy zadania — odbiorca ponawia połączenie, a `/health/ready` zostaje 200. Inne usługi też nie są warunkiem.

**Dlaczego.** Consul i k8s kierują ruch tylko do gotowych instancji. Gdyby gotowość zależała od innych usług, awaria jednej wyłączałaby kolejne. Awaria brokera nie może blokować REST usługi — odbiorca sam wznawia połączenie.

**Jak sprawdzić / szczegóły.** [patterns.md, sekcja 2](patterns.md#2-przykład-w-pythonie-consul-kv-logi-zdrowie) (`is_ready()`); odbiorca zdarzeń w FastAPI: [events.md](events.md#odbiorca-w-usłudze-fastapi). Test: zatrzymana baza → `/health/ready` 503, `/health/live` 200.

## D16 — Logi

**Zasada.** Logi w JSON, jedna linia na wpis, na stdout: czas, poziom, usługa, `requestId`, `userId` (gdy jest), komunikat (nazwy pól dowolne). `X-Request-Id`: przyjęty od Gateway, przekazywany dalej do innych usług i do zdarzeń, odsyłany w odpowiedzi; brak → nowy UUID. W logach nigdy haseł, tokenów, ciasteczek ani pełnych danych osobowych (e-mail, adres).

**Dlaczego.** Jedno żądanie przechodzi przez kilka usług. Ten sam `requestId` we wszystkich logach pozwala odtworzyć jego drogę; JSON da się filtrować (np. `jq`) bez parsowania tekstu.

**Jak sprawdzić / szczegóły.** [patterns.md, sekcja 2](patterns.md#2-przykład-w-pythonie-consul-kv-logi-zdrowie). Test: `curl -H 'X-Request-Id: test-1' …`, potem `docker logs <kontener> | grep test-1` → linia JSON z `"requestId": "test-1"`.

## D17 — Kontener i zamykanie

**Zasada.** `Dockerfile` w folderze usługi; obraz bazowy z przypiętą wersją (nie `latest`); użytkownik bez roota z **numerycznym UID**; `EXPOSE` portu z tabeli usług; `.dockerignore` wyklucza `.env`, `.venv`, `node_modules`, `target` i testy we wszystkich folderach — wzorcami z `**/` (np. `**/.env`, `**/.env.*`, `**/.venv`), bo wzorzec bez `**/` działa tylko w głównym folderze kontekstu budowy. Po SIGTERM usługa przestaje przyjmować ruch, kończy bieżące żądania, wyrejestrowuje się z Consula, zamyka połączenia i kończy pracę w **< 10 s** (Docker Compose czeka 10 s, potem zabija proces sygnałem SIGKILL). Proces usługi jako proces nr 1 w kontenerze musi obsłużyć SIGTERM: `CMD` w formie listy (`CMD ["python", "app.py"]`), nie przez `sh -c`.

**Dlaczego.** Kontener z rootem to większe skutki ewentualnego włamania; k8s (`runAsNonRoot`) sprawdza tylko numeryczny UID. `.env` skopiowany do obrazu (także z podfolderu, np. `app/.env`) ujawnia hasła i zmienia konfigurację (przegląd PR #1). Usługa zabita SIGKILL zostaje w Consulu do minuty i przerywa żądania w połowie.

**Jak sprawdzić / szczegóły.** `docker inspect -f '{{.Config.User}}' <obraz>` → liczba różna od 0; `.env` w obrazie: `docker run --rm --entrypoint find <obraz> /app -name '.env*'` → wynik pusty; czas zatrzymania: `time docker stop <kontener>` → mniej niż 10 s. Wzór `Dockerfile` i `.dockerignore`: [patterns.md, sekcja 2](patterns.md#pliki-przykładu).

## D18 — Dokumentacja API

**Zasada.** OpenAPI w każdej usłudze (FastAPI — wbudowane, Java — springdoc, NestJS — `@nestjs/swagger`), pod domyślnymi ścieżkami biblioteki (np. FastAPI `/docs` i `/openapi.json`). Dokumentacja API nie jest dostępna przez Gateway i nie ma portu w compose. Pokaz: usługa uruchomiona z VS Code albo w k8s `kubectl port-forward`.

**Dlaczego.** Z zewnątrz dostępny jest tylko Gateway (model bezpieczeństwa). Dokumentacja pokazuje także endpointy wewnętrzne, więc nie powinna być publiczna.

**Jak sprawdzić / szczegóły.** [patterns.md, sekcja 9](patterns.md#9-swagger-i-dokumentacja-api).

## D19 — Zdarzenia

**Zasada.** Wszystko o zdarzeniach (exchange, koperta, kolejki, konta, wzorzec nadawcy i odbiorcy) jest w [events.md](events.md). Najważniejsze:

- klucz routingu = pole `type` zdarzenia, a odbiorca sprawdza, że `type` w treści jest równy kluczowi;
- odbiorca potwierdza (`ack`) wiadomość dopiero po zapisaniu skutku;
- odbiorca jest idempotentny: przetworzone `eventId` zapisuje w swojej bazie i pomija duplikaty;
- nigdy `nack`/`reject` z `requeue=true`.

**Dlaczego.** Zdarzenie może dojść dwa razy albo w innej kolejności, a wiadomość zwrócona do kolejki z `requeue=true` krąży bez końca. Kontrakt jest wspólny dla nadawców i odbiorców, więc jest w jednym dokumencie.

**Jak sprawdzić / szczegóły.** [events.md, „Jak publikować”](events.md#jak-publikować) i [„Jak odbierać”](events.md#jak-odbierać).

## D20 — Testy i Postman

**Zasada.** Testy jednostkowe w folderze usługi. Kolekcja Postman w `services/<usługa>/postman/` ze środowiskiem lokalnym (zmienna `baseUrl` = adres usługi). Scenariusz zakupu przez Gateway (wiele usług naraz) przygotowuje platforma w głównym folderze `postman/` (etap 6).

**Dlaczego.** To wymagane rezultaty projektu. Kolekcja usługi pozwala sprawdzić ją bez reszty sklepu (np. uruchomioną z VS Code).

**Jak sprawdzić / szczegóły.** Przykłady kolekcji: [README Gateway, „Postman”](../services/api-gateway/README.md#postman), [README Auth, „Postman”](../services/auth-service/README.md#postman).
