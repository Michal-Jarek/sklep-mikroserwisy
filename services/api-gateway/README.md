# API Gateway

Jedyne wejście do backendu sklepu z zewnątrz. Żądania `/api/v1/<zasób>/…` trafiają do usług zarejestrowanych w Consulu; tabela tras, reguły dostępu i limity żądań są w Consul KV (sekcja „Konfiguracja w Consul KV”). Gateway rejestruje się w Consulu, loguje w JSON i zwraca błędy w formacie zespołu.

| | |
|---|---|
| Właściciel | Michał |
| Technologia | Node.js 22 · NestJS 12 na Fastify |
| Port | 8080 (w Docker Compose `127.0.0.1:8080`) |
| Nazwa w Consulu, Kubernetesie i obrazie Docker | `api-gateway` |
| Health checki | `/health/live`, `/health/ready` |

Szybki start: sekcje [„Uruchomienie w Docker Compose”](#uruchomienie-w-docker-compose) i [„Pierwsze żądania”](#pierwsze-żądania).

## Dla autora usługi za Gateway

- **Nagłówki:** usługa dostaje `X-User-Id` i `X-User-Roles` (`CUSTOMER` albo `ADMIN`, nigdy `SERVICE`) ustawione przez Gateway, `X-Request-Id` i `X-Forwarded-For`; nagłówków `X-User-*` od klienta, nagłówków zmiany metody (`X-HTTP-Method-Override` itp.) ani żadnego nagłówka z `_` w nazwie nigdy nie dostanie – sekcja „Nagłówki, które dostaje usługa”.
- **Błędy usługi a circuit breaker:** odpowiedzi 500 i 503 usługi nie otwierają obwodu w Gateway; otwierają go tylko awarie sieci i odpowiedzi 502 i 504 – sekcja „Circuit breaker”.
- **Czego usługa nie sprawdza:** tokenu JWT (nie ma kluczy JWT) ani roli wymaganej przez regułę – robi to Gateway (sekcja „Reguły dostępu”).
- **Co usługa sprawdza:** własność danych (czy zasób należy do `X-User-Id`; `ADMIN` może więcej) i rolę `SERVICE` na endpointach wewnętrznych (inaczej `403`).
- **Ścieżki:** usługa dostaje ścieżkę bez `/api/v1`; segmenty ścieżki tylko ze znaków `A–Z a–z 0–9 . _ ~ -` (identyfikatory jako UUID) – sekcja „Kanoniczna ścieżka”.
- **Nowy endpoint:** wymagający tylko zalogowania – bez zmian w Gateway; publiczny, tylko dla `ADMIN` albo wewnętrzny – reguła w KV, a nowy zasób – trasa w KV (zgłoś Michałowi; sekcje „Trasy” i „Reguły dostępu”).

## Endpointy Gateway

| Metoda i ścieżka | Odpowiedź | Uwagi |
|---|---|---|
| `GET /health/live` | **200** `{"status":"UP"}` | proces działa; bez sprawdzania zależności |
| `GET /health/ready` | **200** `{"status":"UP"}`, gdy konfiguracja z Consul KV jest wczytana i poprawna; inaczej **503** `SERVICE_UNAVAILABLE` | Redis, Consul (po wczytaniu konfiguracji) i Auth Service nie są warunkiem |
| `/api/v1/**` | odpowiedź usługi albo błąd Gateway | `OPTIONS` tylko jako zapytanie wstępne CORS (sekcja „CORS”), inaczej **405** |
| każda inna ścieżka | **404** `NOT_FOUND` | |

Gateway nie ma Swaggera (`/docs`, `/openapi.json`); dokumentację API mają usługi.

Każda odpowiedź Gateway ma nagłówki:

- `X-Request-Id` – wartość od klienta, jeśli pasuje do `^[A-Za-z0-9._-]{1,64}$`, w przeciwnym razie nowy UUID. Ta sama wartość jest w logach i w treści błędu.
- `X-Gateway-Instance-Id` – ID instancji Gateway w Consulu (`api-gateway-<hostname>`). Gateway nie ustawia `X-Instance-Id` – ten nagłówek pochodzi od usługi i pokazuje jej instancję.
- nagłówki bezpieczeństwa (`@fastify/helmet`): `Content-Security-Policy: default-src 'none';frame-ancestors 'none'` (API nie zwraca HTML), `X-Content-Type-Options: nosniff`, `X-Frame-Options`, `Referrer-Policy` i pozostałe domyślne nagłówki helmet. Bez `X-Powered-By` i `Server`.

Format błędu:

```json
{"status": 404, "error": "NOT_FOUND", "message": "Not found", "requestId": "…"}
```

`message` jest po angielsku, treść błędu nigdy nie zawiera stack trace. Treść żądania może mieć najwyżej 1 MiB (1 048 576 bajtów) – większa daje **413** `PAYLOAD_TOO_LARGE`. Nagłówki żądania większe niż 16 KB dają **431** `REQUEST_HEADER_FIELDS_TOO_LARGE`, żądanie, którego serwer HTTP nie umie odczytać – **400** `VALIDATION_ERROR` (`Bad request`), a żądanie, którego klient nie wyśle w całości (nagłówki i treść) w 30 s – **408** `REQUEST_TIMEOUT` (`Request was not received in time`); te odpowiedzi też mają format zespołu i nagłówek `X-Request-Id`, po nich połączenie jest zamykane.

## Przebieg żądania

Każde żądanie `/api/v1/**` przechodzi kroki w tej kolejności. Kolejność jest częścią kontraktu: np. `POST /api/v1/payments` bez tokenu daje 404 (trasa jest sprawdzana przed dostępem), a `POST /api/v1/products` z tokenem klienta – 403, nawet gdy usługa nie działa (dostęp jest sprawdzany przed wyborem instancji).

1. Nagłówki `X-Request-Id`, `X-Gateway-Instance-Id` i nagłówki helmet – na każdej odpowiedzi, także z błędem.
2. Konfiguracja z Consul KV niewczytana → **503** `SERVICE_UNAVAILABLE`.
3. Limity żądań (globalny, potem limit trasy) → **429** `TOO_MANY_REQUESTS` – sekcja „Limity żądań i circuit breaker”.
4. Metoda spoza `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` (np. `PROPFIND`, `TRACE`; `OPTIONS`, które nie jest zapytaniem wstępnym CORS ze źródła z listy `cors.allowedOrigins` – sekcja „CORS”) → **405** `METHOD_NOT_ALLOWED`.
5. Ścieżka niekanoniczna → **400** `VALIDATION_ERROR` (sekcja „Kanoniczna ścieżka”).
6. Trasa po pierwszym segmencie ścieżki; brak → **404** `NOT_FOUND` (sekcja „Trasy”).
7. Reguła dostępu i token (sekcja „Reguły dostępu”): `blocked` → **404**, brak albo nieważny token na trasie wymagającej logowania → **401**, brak roli → **403**, brak kluczy z Auth Service → **503**.
8. Circuit breaker usługi otwarty → **503** – sekcja „Limity żądań i circuit breaker”.
9. Zdrowa instancja usługi z Consula (round robin, lista trzymana 10 s, pusta – 2 s); brak → **503**.
10. Przekazanie żądania do instancji: ścieżka kanoniczna bez `/api/v1`, query bez zmian, treść bajt w bajt z oryginalnym `Content-Type` (treść bez `Content-Type` idzie jako `application/octet-stream`), nagłówki z sekcji „Nagłówki, które dostaje usługa”. Na połączenie Gateway czeka 2 s, na odpowiedź `proxy.timeoutSeconds` (10 s; zegar ma dokładność ok. 0,5 s). Żądanie, którego nie da się przekazać usłudze (np. nieobsługiwany nagłówek albo znaki w adresie), dostaje **400** `VALIDATION_ERROR` (`Bad request`) bez wywołania usługi; nie liczy się do circuit breakera i nie jest ponawiane. Gdy klient rozłączył się przed tym krokiem, usługa nie dostaje żądania.

Odpowiedź usługi, także 4xx i 5xx, wraca do klienta bez zmian: status, treść i nagłówki (`Set-Cookie`, `Retry-After`, `X-Instance-Id` itd.). Gateway usuwa z niej tylko `Server`, `X-Powered-By`, nagłówki CORS `Access-Control-*` (sekcja „CORS”) i nagłówki dotyczące jednego połączenia (`Connection`, `Keep-Alive`, `Transfer-Encoding` i nagłówki wymienione w `Connection`). Gdy usługa zwróci nagłówek, który Gateway już ustawił (`X-Request-Id`, `X-Gateway-Instance-Id`, nagłówki helmet), zostaje wartość Gateway. Wyjątek to `Vary`: wartość usługi jest dołączana do `Vary: Origin` Gateway (sekcja „CORS”).

Gdy usługa nie odpowiada:

| Sytuacja | Odpowiedź Gateway | Ponowienie |
|---|---|---|
| brak połączenia z instancją (`ECONNREFUSED`, `EHOSTUNREACH`, `ECONNRESET` przed odpowiedzią, brak połączenia w 2 s) | **502** `BAD_GATEWAY`; instancja wypada z listy do następnego odświeżenia z Consula (do 10 s; gdy była ostatnia na liście – odświeżenie po 2 s) | `GET` i `HEAD`: jedno, od razu, do innej instancji (jeśli jest); inne metody nigdy |
| brak odpowiedzi w `proxy.timeoutSeconds` | **504** `GATEWAY_TIMEOUT` | nie |
| inny błąd sieci przed odpowiedzią | **502** `BAD_GATEWAY` | nie |
| odpowiedź 5xx usługi | odpowiedź usługi bez zmian | nie |

Do circuit breakera usługi liczą się jako awarie tylko awarie sieci: brak połączenia, brak odpowiedzi w czasie, inny błąd sieci oraz odpowiedzi usługi 502 i 504 (sekcja „Limity żądań i circuit breaker”). Odpowiedzi 500 i 503 usługi nie są awarią. Żądanie odrzucone przed wysłaniem (400 z kroku 10) nie liczy się.

Każda nieudana próba to linia logu `warn` „Request to the service failed” z polami `targetService`, `upstream` (`ip:port` instancji) i `reason` (kod błędu). Linia zakończenia żądania („request completed”) ma `requestId`, `targetService`, `upstream` (ostatnia próba), `userId` (gdy użytkownik jest zalogowany), `res.statusCode` i `responseTime`. Treści żądań, tokeny i ciasteczka nie trafiają do logów.

## Trasy

Pierwszy segment ścieżki po `/api/v1` wskazuje usługę w Consulu (klucz `routes` w KV):

| Zasób (`/api/v1/<zasób>/…`) | Usługa w Consulu |
|---|---|
| `auth` | `auth-service` |
| `users` | `user-service` |
| `products`, `categories` | `product-service` |
| `inventory` | `inventory-service` |
| `cart` | `cart-service` |
| `orders` | `order-service` |
| `notifications` | `notification-service` |
| `reviews` | `review-service` |
| `shipping`, `shipments` | `shipping-service` |

Dopasowanie jest dokładne i rozróżnia wielkość liter (`/api/v1/Products` → 404). Nieznany zasób i samo `/api/v1` → **404** `NOT_FOUND`. Usługa dostaje ścieżkę bez `/api/v1`: `GET /api/v1/products/12?sort=price` → `GET /products/12?sort=price`. Endpointy dokumentacji i zdrowia usług (`/docs`, `/openapi.json`, `/health/*`) nie są dostępne przez Gateway – żaden zasób nie ma takiej nazwy.

**Dodanie trasy** (przykład: usługa `payment-service` pod `/api/v1/payments`):

Autor usługi zgłasza Michałowi nazwę zasobu i usługi (np. `payments` → `payment-service`) oraz endpointy, które mają być publiczne, tylko dla ADMIN-a albo wewnętrzne. Plik `deploy/consul/config/api-gateway.yaml` należy do Michała – on dopisuje trasę i reguły. Kroki (dla Michała):

1. W pliku `deploy/consul/config/api-gateway.yaml` dopisz w `routes` linię `payments: payment-service` (nazwy: małe litery, cyfry i `-`, na początku litera).
2. Jeśli któryś endpoint ma być publiczny, tylko dla ADMIN-a albo wewnętrzny, dopisz reguły w `access` (sekcja „Reguły dostępu”). Endpoint bez pasującej reguły wymaga zalogowania.
3. Z katalogu głównego repozytorium wgraj plik do KV i zrestartuj Gateway:

   ```bash
   docker compose -f deploy/compose.yaml --profile platform up -d --wait   # seed wgrywa plik do KV
   docker compose -f deploy/compose.yaml --profile platform restart api-gateway
   ```

   `restart` nie czeka na gotowość: przez kilka sekund Gateway może nie przyjmować połączeń (`curl` pokazuje błąd połączenia) albo odpowiadać `503`. Gotowy jest, gdy `docker compose -f deploy/compose.yaml --profile platform ps api-gateway` pokazuje `(healthy)`.

Usługa musi rejestrować się w Consulu pod nazwą z tabeli i mieć check w stanie `passing` – bez zdrowej instancji Gateway odpowiada 503.

## Kanoniczna ścieżka

Przed wyborem trasy Gateway sprawdza ścieżkę (bez query). Dzieli ją na segmenty po `/`, w każdym segmencie dekoduje kodowanie procentowe (`%41` → `A`) i wymaga, żeby każdy zdekodowany segment:

- składał się tylko ze znaków `A–Z`, `a–z`, `0–9`, `.`, `_`, `~`, `-`,
- nie był `.` ani `..`.

W przeciwnym razie odpowiada **400** `VALIDATION_ERROR` (`Invalid request path`) i nic nie trafia do usługi. Przykłady ścieżek z odpowiedzią 400:

| Ścieżka | Powód |
|---|---|
| `/api/v1/products/../users/me`, `/api/v1/products/%2e%2e`, `/api/v1/products/.` | segment `.` albo `..` |
| `/api/v1/products//a`, `/api/v1/products/`, `/api/v1/` | pusty segment (`//`, `/` na końcu) |
| `/api/v1/orders/purchased;x` | `;` |
| `/api/v1/products/a%2Fb`, `/api/v1/products/a%5Cb` | zakodowany `/` albo `\` |
| `/api/v1/products/a%00b`, `/api/v1/products/a%20b` | bajt zerowy, spacja |
| `/api/v1/products/%C4%85` | znak spoza ASCII |
| `/api/v1/products/%zz` | błędne kodowanie |

Usługa dostaje dokładnie tę ścieżkę, którą sprawdził Gateway: zdekodowane segmenty złączone `/`, bez `/api/v1` (`/api/v1/%70roducts/abc` → `/products/abc`). Dzięki temu reguły dostępu i usługa widzą tę samą ścieżkę – np. `/api/v1/orders/purchase%64` jest sprawdzane jako `/orders/purchased` i nie omija blokady. Query przechodzi bez zmian (np. `q=a%20b`). Identyfikatory w ścieżkach to UUID, a kody i nazwy zasobów to słowa, więc mieszczą się w dozwolonych znakach; inne wartości (np. tekst wyszukiwania) przekazuje się w query.

## Reguły dostępu

Gateway sprawdza dostęp do każdego żądania `/api/v1/**` po wyborze trasy, a przed wywołaniem usługi. Reguły są w kluczu `access` pliku [deploy/consul/config/api-gateway.yaml](../../deploy/consul/config/api-gateway.yaml) (Consul KV `config/api-gateway/data`). Jedna reguła:

```yaml
- { methods: [GET, HEAD], path: /products/**, access: public }
```

- `path` – ścieżka bez `/api/v1`, porównywana segment po segmencie (segment to część między `/`) z kanoniczną ścieżką żądania, czyli po zdekodowaniu `%xx`. `*` pasuje do dokładnie jednego segmentu. `**` może stać tylko na końcu i pasuje do zera lub więcej segmentów: `/products/**` obejmuje `/products`, `/products/p1` i `/products/p1/x`. Wielkość liter ma znaczenie, query (`?…`) nie jest brane pod uwagę.
- `methods` – lista z `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` albo `[ANY]`. Reguła z `GET` obejmuje też `HEAD` (usługi obsługują `HEAD` tak jak `GET`); `HEAD` można też wpisać na listę osobno.
- `access` – poziom dostępu:

| Poziom | Kto przechodzi | Odpowiedź Gateway dla pozostałych |
|---|---|---|
| `public` | każdy, token nie jest wymagany | – |
| `authenticated` | ważny token z rolą `CUSTOMER` albo `ADMIN` | **401** |
| `ADMIN` | ważny token z rolą `ADMIN` | **401** bez ważnego tokenu, **403** z tokenem bez roli `ADMIN` |
| `blocked` | nikt, także `ADMIN` | **404** |

Kolejność sprawdzania:

1. Reguły są sprawdzane od góry i **wygrywa pierwsza pasująca**. Gdy żadna nie pasuje, obowiązuje `authenticated`.
2. `blocked` → **404** `NOT_FOUND` z tą samą treścią co nieistniejąca trasa, więc z zewnątrz nie widać, że endpoint istnieje. Tak są zamknięte endpointy wewnętrzne (rola `SERVICE`).
3. Trasa wymagająca logowania: brak nagłówka `Authorization`, inny schemat niż `Bearer`, nieważny albo wygasły token → **401** `UNAUTHORIZED` z nagłówkiem `WWW-Authenticate: Bearer`. Wyjątek: dopóki Gateway nie ma żadnego klucza z Auth Service (np. Auth nie działał od startu Gateway), poprawnie zbudowany token daje **503** `SERVICE_UNAVAILABLE`.
4. Trasa `ADMIN` i token bez roli `ADMIN` → **403** `FORBIDDEN`.
5. Trasa `public` z tokenem: ważny token → usługa dostaje `X-User-Id` i `X-User-Roles` tak jak na trasie `authenticated`. Nieważny albo wygasły token → żądanie idzie dalej jako anonimowe, bez 401. Dlatego `/auth/**` (rejestracja, logowanie, odświeżenie, wylogowanie) działa także z wygasłym tokenem w nagłówku.

**Ważny token** to access token z Auth Service, który:
- jest podpisany `RS256` kluczem z JWKS Auth Service i ma w nagłówku `kid`;
- ma `iss` = `jwt.issuer` (`sklep-auth`) i `aud` = `jwt.audience` (`sklep-api`);
- ma `exp`, `iat` i `sub` (UUID); `exp` jest sprawdzany bez tolerancji zegara;
- ma `roles` jako listę tekstów z co najmniej jedną z ról `CUSTOMER`, `ADMIN`. Inne role, także `SERVICE`, Gateway pomija i nie przekazuje usłudze.

**Klucze.** Gateway pobiera JWKS (`/.well-known/jwks.json`) z instancji `auth-service` znalezionej w Consulu, z timeoutem 2 s:
- przy starcie, w tle;
- gdy token ma nieznany `kid` – żądanie czeka na pobranie;
- gdy klucze mają ponad 10 minut – w tle.

Gateway pobiera klucze najwyżej raz na 10 s. Gdy Auth Service nie odpowiada, zostaje przy dotychczasowych kluczach, więc zalogowani użytkownicy dalej mają dostęp. W logu jest jedno ostrzeżenie na zmianę stanu (brak kluczy albo nieudane odświeżenie) i jedna linia `info`, gdy klucze znów się wczytają. Odrzucone tokeny są logowane tylko na poziomie `debug`, z samym powodem (bez tokenu).

Obecne reguły:

| # | Metody | Ścieżka | Poziom | Uwagi |
|---|---|---|---|---|
| 1 | `ANY` | `/auth/**` | `public` | rejestracja, logowanie, odświeżenie, wylogowanie |
| 2 | `POST` | `/users` | `blocked` | wewnętrzny: tworzenie profilu przy rejestracji (woła Auth Service) |
| 3 | `DELETE` | `/cart/*` | `blocked` | wewnętrzny: czyszczenie koszyka `DELETE /cart/{userId}`; nie obejmuje `DELETE /cart/items/{productId}` (trzy segmenty) |
| 4 | `ANY` | `/inventory/reservations/**` | `blocked` | wewnętrzny: rezerwacje |
| 5 | `ANY` | `/orders/purchased/**` | `blocked` | wewnętrzny: sprawdzenie zakupu; obejmuje też samo `/orders/purchased?…` |
| 6 | `GET`, `HEAD` | `/users/me/**` | `authenticated` | własny profil i adresy; stoi przed regułą 7, więc `GET /users/me` nie wymaga roli `ADMIN` |
| 7 | `GET`, `HEAD` | `/users/*` | `ADMIN` | profil dowolnego użytkownika |
| 8 | `GET`, `HEAD` | `/products/**` | `public` | katalog |
| 9 | `POST`, `PUT`, `PATCH`, `DELETE` | `/products/**` | `ADMIN` | zarządzanie katalogiem |
| 10 | `GET`, `HEAD` | `/categories/**` | `public` | |
| 11 | `POST`, `PUT`, `PATCH`, `DELETE` | `/categories/**` | `ADMIN` | |
| 12 | `GET`, `HEAD` | `/reviews/**` | `public` | odczyt opinii |
| 13 | `GET`, `HEAD` | `/shipping/methods/**` | `public` | metody dostawy |
| 14 | `GET`, `HEAD` | `/inventory/*` | `public` | odczyt stanu magazynu `GET /inventory/{productId}`; stoi za regułą 4, więc `/inventory/reservations` zostaje zablokowane |
| 15 | `PUT` | `/inventory/*` | `ADMIN` | zmiana stanu magazynu |
| 16 | `PATCH` | `/shipments/*/status` | `ADMIN` | zmiana statusu przesyłki |

Pozostałe endpointy (koszyk, zamówienia, `PUT /users/me`, `POST /reviews`, `DELETE /reviews/{id}`, `GET /shipments`, `GET /notifications/me` …) nie pasują do żadnej reguły, więc wymagają logowania (`authenticated`). Gateway sprawdza tylko, czy klient jest zalogowany i jaką ma rolę. Własność danych (czy `X-User-Id` jest właścicielem zasobu) sprawdza usługa.

**Reguła dla nowego endpointu:**

- Wystarczy zalogowany użytkownik (`CUSTOMER` albo `ADMIN`): reguła nie jest potrzebna. Sprawdź tylko, czy endpoint nie pasuje do wcześniejszej reguły. Na przykład nowy `GET /products/{id}/stats` byłby publiczny przez regułę 8.
- Endpoint publiczny, tylko dla `ADMIN` albo wewnętrzny (wołany tylko przez inne usługi): zgłoś Michałowi metodę, ścieżkę i poziom dostępu – plik `deploy/consul/config/api-gateway.yaml` należy do niego, on dopisze regułę w `access`.

Kroki (dla Michała):

- Reguły szczegółowe stawiaj **przed** ogólnymi, bo wygrywa pierwsza pasująca. Przykład: `- { methods: [POST], path: /orders/*/refund, access: ADMIN }`.
- Po zmianie pliku wgraj go do KV i zrestartuj Gateway (polecenia w sekcji „Konfiguracja w Consul KV”). Błąd w regule, np. literówka w `access`, odrzuca całą konfigurację: `/health/ready` odpowiada 503, a w logu jest błąd z nazwą pola.

## Nagłówki, które dostaje usługa

Gateway przekazuje żądanie do usługi bez prefiksu `/api/v1` (np. `/api/v1/products/12?x=1` → `/products/12?x=1`), z treścią i `Content-Type` bez zmian. Nagłówki ustawiane przez Gateway:

| Nagłówek | Wartość | Kiedy |
|---|---|---|
| `X-User-Id` | `sub` z tokenu (UUID użytkownika) | klient zalogowany, także na trasie publicznej, jeśli wysłał ważny token |
| `X-User-Roles` | `CUSTOMER` albo `ADMIN` (kilka po przecinku, w kolejności z tokenu); nigdy `SERVICE` | jak wyżej |
| `X-Request-Id` | wartość od klienta, gdy pasuje do `^[A-Za-z0-9._-]{1,64}$`, w przeciwnym razie nowy UUID | zawsze |
| `X-Forwarded-For` | jeden adres: IP klienta widziane przez Gateway (wartość od klienta jest nadpisywana) | zawsze |

Z żądania klienta Gateway zawsze usuwa: `Authorization`, każdy nagłówek zaczynający się od `X-User-` (bez względu na wielkość liter), `Forwarded`, `X-Real-IP`, pozostałe `X-Forwarded-*`, `Expect` (na `Expect: 100-continue` Gateway sam odpowiada `100 Continue` i czyta treść), nagłówki zmiany metody `X-HTTP-Method-Override`, `X-HTTP-Method` i `X-Method-Override`, **każdy nagłówek z `_` w nazwie** (np. `X_User_Roles`, `Some_Header`; jak nginx z `underscores_in_headers off` – serwery WSGI czytają `X_User_Roles` tak samo jak `X-User-Roles`) i nagłówki hop-by-hop. Klient nie może więc sam podać `X-User-Id` ani `X-User-Roles` ani zmienić metody żądania za plecami reguł dostępu. Usługa nie dostanie żadnego nagłówka z `_` w nazwie, więc nie może na takim polegać. Pozostałe nagłówki (np. `Cookie`, `Content-Type`, `Accept`) przechodzą bez zmian.

Co to znaczy dla usługi:

- Usługa **nie weryfikuje JWT** i nie ma kluczy JWT. Token do niej nie dociera; ufa `X-User-Id` i `X-User-Roles` od Gateway.
- Na trasie publicznej `X-User-*` może nie być (klient anonimowy albo z nieważnym tokenem). Endpoint publiczny nie może wymagać tych nagłówków; gdy są, może z nich korzystać.
- Na trasach `authenticated` i `ADMIN` nagłówki są zawsze. Rolę sprawdził już Gateway, ale własność danych (np. czy zamówienie należy do `X-User-Id`) sprawdza usługa.
- Endpointy wewnętrzne są z zewnątrz zablokowane (404). Inna usługa woła je bezpośrednio w sieci wewnętrznej, z `SERVICE` w `X-User-Roles` (np. `CUSTOMER,SERVICE`), a usługa wewnętrzna bez roli `SERVICE` odpowiada 403.
- `X-Request-Id` przekazuj dalej w wywołaniach do innych usług i w zdarzeniach, dopisuj go też do logów.

## Limity żądań i circuit breaker

### Limity żądań

Gateway liczy żądania `/api/v1/**` na adres IP klienta (adres połączenia; `X-Forwarded-For` od klienta nie ma znaczenia). Liczy je wtyczka `@fastify/rate-limit` (11.x) z magazynem w Redisie `redis-gateway`, więc wszystkie instancje Gateway dzielą te same limity. Wtyczka nie dodaje limitów do tras sama: Gateway wywołuje limit globalny i limit trasy w kroku 3 obsługi żądania. Okno jest stałe: zaczyna się przy pierwszym żądaniu i po `timeWindowSeconds` licznik znika.

| Limit | Wartość | Dotyczy |
|---|---|---|
| globalny (`rateLimit.global`) | 300 żądań na 60 s | każde żądanie `/api/v1/**`, także z błędem 400/404/405 |
| logowanie (`rateLimit.routes`) | 5 żądań na 60 s | `POST /api/v1/auth/login` |
| rejestracja (`rateLimit.routes`) | 10 żądań na 60 s | `POST /api/v1/auth/register` |

- Limit trasy liczy się **dodatkowo** do globalnego, z osobnym licznikiem (klucze w Redisie: `rate-limit:global:<IP>`, `rate-limit:POST:/auth/login:<IP>`). Wyczerpany limit logowania nie blokuje innych endpointów.
- Limit trasy obowiązuje, gdy metoda i ścieżka kanoniczna (po zdekodowaniu `%xx`, bez `/api/v1`) pasują dokładnie. Żądanie ze ścieżką niekanoniczną liczy się tylko do limitu globalnego.
- Limity są sprawdzane przed metodą, ścieżką i tokenem (krok 3 w „Przebieg żądania”). `/health/*` nie ma limitu.
- Po przekroczeniu: **429** `TOO_MANY_REQUESTS` z nagłówkiem `Retry-After` (sekundy do końca okna, 1–60). To odpowiedź Gateway, więc nie ma `X-Instance-Id`. Limity Gateway nie dodają nagłówków `X-RateLimit-*` (ani do 429, ani do innych odpowiedzi); takie nagłówki w odpowiedzi usługi pochodzą od niej, np. od limitu logowania Auth Service.
- Auth Service ma własny limit logowania (5 prób na minutę z jednego IP w każdej instancji) i blokadę konta. Limit w Gateway działa przed nim i wspólnie dla wszystkich instancji.

**Redis niedostępny.** Żądania przechodzą bez limitu (błąd Redisa jest pomijany, opcja `skipOnError` wtyczki). Gdy Redis jest wyłączony (brak połączenia), Gateway nie czeka – nie kolejkuje poleceń do Redisa. Gdy Redis jest zawieszony (połączenie jest, odpowiedzi nie ma), żądanie czeka na niego najwyżej raz, ok. 2 s: bez odpowiedzi przy limicie globalnym Gateway nie sprawdza już limitu trasy. W logu jest jedno ostrzeżenie „Redis for rate limits is unavailable, requests pass without a limit”, a po powrocie Redisa jedna linia `info` „Redis for rate limits is available again, limits apply”. Gateway sam łączy się ponownie. `/health/ready` nie zależy od Redisa.

**Zmiana limitów:** wartości `max` i `timeWindowSeconds` w `rateLimit` w pliku `deploy/consul/config/api-gateway.yaml`, potem wgranie do KV i restart Gateway (sekcja „Konfiguracja w Consul KV”). Nowy limit endpointu to wpis w `rateLimit.routes`, np. `- { method: POST, path: /orders, max: 20, timeWindowSeconds: 60 }`. Liczniki w Redisie można wyzerować przy testach:

```bash
docker compose -f deploy/compose.yaml exec -T redis-gateway sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli FLUSHALL'
```

Wynik: `OK`. Polecenie zeruje liczniki wszystkich klientów na tym lokalnym zestawie (także innych osób testujących przez ten sam Gateway).

### Circuit breaker

Gateway ma osobny obwód (`opossum`) dla każdej usługi docelowej, np. `product-service` obsługuje `/products` i `/categories`, więc oba zasoby mają jeden obwód.

| Parametr | Wartość |
|---|---|
| otwarcie | ponad 50% awarii, gdy w ostatnich 60 s było co najmniej 10 żądań do usługi |
| czas otwarcia | 30 s, potem jedno żądanie próbne (stan półotwarty) |
| własny timeout | brak; czas pilnuje proxy (2 s na połączenie, `proxy.timeoutSeconds` na odpowiedź) |

- **Awaria (tylko sieć):** brak połączenia (po ewentualnym ponowieniu `GET`/`HEAD`), brak odpowiedzi w czasie, inny błąd sieci, odpowiedź usługi 502 albo 504. Odpowiedź usługi i tak trafia do klienta bez zmian.
- **Sukces:** każda inna odpowiedź usługi, także 4xx (np. 404, 409), 500 i 503. Usługa, która odpowiada 500 albo 503, odpowiada szybko i nie zajmuje zasobów Gateway, a błąd 500 wywołany żądaniem jednego klienta nie może wyłączać usługi pozostałym (np. 503 Auth Service przy awarii User Service nie blokuje logowania).
- **Nie liczy się:** brak zdrowej instancji w Consulu (503 z kroku 9), żądanie odrzucone przed wysłaniem do usługi (400 `Bad request` z kroku 10) i żądanie, którego klient rozłączył się przed odpowiedzią usługi (liczone jak sukces).
- **Obwód otwarty:** od razu **503** `SERVICE_UNAVAILABLE`, bez pytania Consula i usługi. Inne usługi działają normalnie.
- **Stan półotwarty:** przechodzi jedno żądanie próbne, pozostałe dostają 503. Udane zamyka obwód, nieudane otwiera go na kolejne 30 s.
- Każda zmiana stanu to linia logu z polami `targetService` i `state`: `warn` „Circuit breaker opened”, `info` „Circuit breaker half-open”, `info` „Circuit breaker closed”.

Liczniki obwodów są w pamięci instancji Gateway i zerują się przy restarcie.

## CORS

Domyślnie lista `cors.allowedOrigins` w KV jest pusta: Gateway nie wysyła nagłówków CORS, a `OPTIONS` dostaje **405**. Frontend i API mają być pod jednym adresem (nginx w etapie 6, Ingress w etapie 7), więc CORS nie jest potrzebny.

Gdy frontend działa pod innym adresem (np. serwer Vite `http://localhost:5173`), dodaj jego źródło do pliku `deploy/consul/config/api-gateway.yaml`:

```yaml
cors:
  allowedOrigins: [http://localhost:5173]
```

i wgraj konfigurację do KV z restartem Gateway (sekcja „Konfiguracja w Consul KV”). Wtedy dla źródła z listy (porównanie dokładne: schemat, host i port):

- odpowiedzi mają `Access-Control-Allow-Origin: <źródło>`, `Access-Control-Allow-Credentials: true` i `Access-Control-Expose-Headers: X-Request-Id, X-Instance-Id, X-Gateway-Instance-Id, Retry-After`;
- zapytanie wstępne (`OPTIONS` z `Origin` i `Access-Control-Request-Method`) dostaje **204** z `Access-Control-Allow-Methods: GET, HEAD, POST, PUT, PATCH, DELETE`, `Access-Control-Allow-Headers: Content-Type, Authorization, X-Request-Id` i `Access-Control-Max-Age: 600`. Zapytanie wstępne nie dochodzi do usługi i nie liczy się do limitów.

Źródło spoza listy nie dostaje nagłówków CORS, a jego `OPTIONS` dostaje 405. Każda odpowiedź Gateway, także przy pustej liście, ma `Vary: Origin` (ustawia go `@fastify/cors`, bo lista źródeł jest czytana przy każdym żądaniu); jeśli usługa zwróci własny `Vary`, wartości są łączone (np. `Vary: Origin, Accept-Encoding`).

CORS ustawia tylko Gateway: nagłówki `Access-Control-*` z odpowiedzi usługi są usuwane, więc usługa nie otworzy CORS sama.

## Kody błędów

Treść zawsze `{"status","error","message","requestId"}`.

| Status / `error` | Kiedy | `message` |
|---|---|---|
| 400 `VALIDATION_ERROR` | ścieżka niekanoniczna; żądanie HTTP, którego nie da się odczytać albo przekazać usłudze (nieobsługiwany nagłówek, znaki w adresie – bez wywołania usługi i bez wpływu na circuit breaker) | `Invalid request path` / `Bad request` |
| 401 `UNAUTHORIZED` + `WWW-Authenticate: Bearer` | brak tokenu, zły schemat albo nieważny token na trasie wymagającej logowania | `Missing or invalid access token` |
| 403 `FORBIDDEN` | brak roli ADMIN | `Insufficient role` |
| 404 `NOT_FOUND` | brak trasy, reguła `blocked`, ścieżka spoza `/api/v1` i `/health` | `Not found` |
| 405 `METHOD_NOT_ALLOWED` | metoda spoza `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` | `Method not allowed` |
| 408 `REQUEST_TIMEOUT` | klient nie wysłał żądania (nagłówków i treści) w 30 s; połączenie jest zamykane | `Request was not received in time` |
| 413 `PAYLOAD_TOO_LARGE` | treść większa niż 1 048 576 bajtów | `Request body is too large` |
| 429 `TOO_MANY_REQUESTS` + `Retry-After` | przekroczony limit globalny albo limit trasy | `Too many requests, try again later` |
| 431 `REQUEST_HEADER_FIELDS_TOO_LARGE` | nagłówki większe niż 16 KB | `Request headers are too large` |
| 500 `INTERNAL_ERROR` | błąd samego Gateway | `Internal server error` |
| 502 `BAD_GATEWAY` | brak połączenia z instancją usługi albo inny błąd sieci przed odpowiedzią | `Service is not reachable` |
| 503 `SERVICE_UNAVAILABLE` | konfiguracja niewczytana, brak zdrowej instancji, obwód otwarty, brak kluczy z Auth Service | `Service is unavailable, try again later` |
| 504 `GATEWAY_TIMEOUT` | brak odpowiedzi usługi w `proxy.timeoutSeconds` | `Service did not respond in time` |

Błąd zwrócony przez usługę (np. jej 404 albo 409) przechodzi bez zmian i nie jest błędem Gateway. Odpowiedź usługi ma zwykle nagłówek `X-Instance-Id`, błąd Gateway nigdy go nie ma. Komunikat 404 dla braku trasy i dla reguły `blocked` jest ten sam, więc z zewnątrz nie widać, czy endpoint wewnętrzny istnieje.

## Konfiguracja w Consul KV

Klucz `config/api-gateway/data` (YAML). Źródłem jest plik [deploy/consul/config/api-gateway.yaml](../../deploy/consul/config/api-gateway.yaml) – kontener `consul-kv-seed` wgrywa go do Consula przy każdym `docker compose … up`.

| Klucz | Znaczenie | Gdy brak |
|---|---|---|
| `logLevel` | poziom logów: `fatal`, `error`, `warn`, `info`, `debug`, `trace` | `info` |
| `jwt.issuer`, `jwt.audience` | oczekiwane `iss` i `aud` w tokenach z Auth Service | `sklep-auth`, `sklep-api` |
| `proxy.timeoutSeconds` | czas oczekiwania na odpowiedź usługi | `10` |
| `routes` | **wymagany**: pierwszy segment ścieżki po `/api/v1` → nazwa usługi w Consulu | błąd |
| `access` | **wymagany**: reguły dostępu (lista sprawdzana po kolei, pierwsza pasująca wygrywa) | błąd |
| `rateLimit.global` | limit żądań na adres IP: `max` w oknie `timeWindowSeconds` | `300` na `60` s |
| `rateLimit.routes` | **wymagany**: dodatkowe limity dla pojedynczych endpointów | błąd |
| `cors.allowedOrigins` | źródła przeglądarki, które mogą wołać API z innego adresu | pusta lista (bez CORS) |

Kolejność: zmienna środowiskowa (`LOG_LEVEL`, `JWT_ISSUER`, `JWT_AUDIENCE`) > Consul KV > wartość domyślna w kodzie. Wartości domyślne są tylko dla pól z pojedynczą wartością; trasy, reguły i limity tras są wyłącznie w KV. Klucze `routes`, `access` i `rateLimit.routes` mogą być puste, ale muszą istnieć – literówka w nazwie klucza nie zgubi po cichu reguł.

**Walidacja.** Gateway sprawdza cały dokument przy wczytaniu. Odrzuca go w całości, gdy któraś wartość ma zły typ, `access` jest spoza `public | authenticated | ADMIN | blocked`, metoda jest spoza `GET, HEAD, POST, PUT, PATCH, DELETE, ANY` (w `rateLimit.routes` bez `ANY`), `**` nie jest ostatnim segmentem wzorca, ścieżka nie zaczyna się od `/`, segment ścieżki ma inne znaki niż `A–Z a–z 0–9 . _ ~ -` (we wzorcach reguł dozwolone też `*` i `**`, w limitach tras tylko dokładna ścieżka), nazwa zasobu albo usługi w `routes` nie pasuje do `^[a-z][a-z0-9-]*$`, `max`, `timeWindowSeconds` (liczby całkowite) albo `timeoutSeconds` nie są większe od zera albo `logLevel` jest nieznany. Nieznane klucze są pomijane. Błąd trafia do logu jako jedna linia z nazwą pola, bez treści dokumentu, np.:

```
Invalid gateway configuration: access[0].access must be one of public, authenticated, ADMIN, blocked
```

**Gotowość.** Gateway zaczyna przyjmować połączenia od razu po starcie, a konfigurację czyta w tle (timeout 2 s). Dopóki jej nie wczyta (Consul niedostępny, brak klucza, zły YAML, błąd walidacji), `/health/ready` odpowiada **503**, a Gateway próbuje ponownie co 15 s. Każdy rodzaj problemu trafia do logu raz (ostrzeżenie albo błąd), a nie przy każdej próbie. W Consulu instancja jest wtedy `critical`, a w Docker Compose kontener nie jest `healthy`. Po wczytaniu konfiguracja nie zmienia się do restartu.

**Zmiana konfiguracji:** edycja pliku `deploy/consul/config/api-gateway.yaml`, potem z katalogu głównego repozytorium:

```bash
docker compose -f deploy/compose.yaml --profile platform up -d --wait   # seed wgrywa plik do KV
docker compose -f deploy/compose.yaml --profile platform restart api-gateway
```

`restart` nie czeka na gotowość: przez kilka sekund Gateway może nie przyjmować połączeń (`curl` pokazuje błąd połączenia) albo odpowiadać `503`. Gotowy jest, gdy `docker compose -f deploy/compose.yaml --profile platform ps api-gateway` pokazuje `(healthy)`.

### Rejestracja w Consulu

Gateway rejestruje się po starcie serwera HTTP: nazwa `api-gateway`, ID `api-gateway-<hostname>`, port `PORT`, check HTTP `/health/ready` co 10 s (timeout 2 s, wpis znika po minucie w stanie `critical`). Stan początkowy checku to bieżąca gotowość. Adres to `SERVICE_ADDRESS`, a gdy jest pusty – lokalny adres, przez który kontener łączy się z Consulem. Gateway jest w dwóch sieciach (`backend` i `edge`), a Consul widzi tylko adres z `backend`, dlatego nie jest brany pierwszy adres kontenera. Gdy nazwy `CONSUL_HOST` nie da się rozwiązać (np. kontener `consul` jest zatrzymany), Gateway startuje i ustala adres przy następnej próbie. Co 15 s sprawdza, czy wpis w Consulu istnieje i ma aktualny adres i port; jeśli nie, rejestruje się ponownie. Przy zatrzymaniu (SIGTERM, Ctrl+C) wyrejestrowuje się.

Zdrowe instancje usług Gateway bierze z Consula (`/v1/health/service/<usługa>?passing`). Lista jest trzymana 10 s, instancje są używane po kolei (round robin). Pusta lista (usługa nie ma jeszcze zdrowej instancji) jest trzymana tylko 2 s, więc usługa uruchomiona po Gateway jest dostępna po kilku sekundach. Instancja bez połączenia (502) wypada z listy; gdy zostają inne, lista czeka do zwykłego odświeżenia (10 s), a gdy wypadła ostatnia, Gateway pyta Consula ponownie po 2 s. Gdy Consul nie odpowiada, Gateway używa ostatniej znanej listy i pyta ponownie po 10 s.

## Zmienne środowiskowe

Nazwy są w [.env.example](.env.example) (bez wartości).

| Zmienna | Docker Compose | Lokalnie (VS Code) | Uwagi |
|---|---|---|---|
| `PORT` | `8080` | `8080` (albo `18080`, gdy działa Gateway z Docker Compose) | |
| `LOG_LEVEL` | — | — | opcjonalnie; nadpisuje `logLevel` z KV |
| `CONSUL_HOST` / `CONSUL_PORT` | `consul` / `8500` | `127.0.0.1` / `8500` | Gateway zawsze używa Consula |
| `SERVICE_ADDRESS` | — (pusty → adres trasy do Consula) | `host.docker.internal` | adres zapisany w Consulu; lokalnie wymagany |
| `REDIS_HOST` / `REDIS_PORT` | `redis-gateway` / `6379` | `127.0.0.1` / `6379` | Redis na liczniki limitów żądań; niedostępny → ruch bez limitu (sekcja „Limity żądań i circuit breaker”) |
| `REDIS_PASSWORD` | `REDIS_GATEWAY_PASSWORD` z `deploy/.env` | wartość `REDIS_GATEWAY_PASSWORD` z `deploy/.env` | wymagana; brak → Gateway nie startuje |
| `JWT_ISSUER` / `JWT_AUDIENCE` | — | — | opcjonalnie; nadpisują KV |

Brak wymaganej zmiennej, zły numer portu albo nieznany `LOG_LEVEL` kończą start jedną linią logu z nazwą zmiennej (bez jej wartości).

## Uruchomienie w Docker Compose

Z katalogu głównego repozytorium (wymaga `deploy/.env`, patrz [deploy/README.md](../../deploy/README.md)):

```bash
docker compose -f deploy/compose.yaml --profile platform up -d --wait --build
```

Gateway działa pod adresem `http://localhost:8080` (port tylko na `127.0.0.1`, niedostępny z sieci lokalnej):

```bash
curl -i http://localhost:8080/health/ready
```

Wynik: `HTTP/1.1 200 OK` i `{"status":"UP"}`. Inny wynik albo błąd połączenia – sekcja „Gdy coś nie działa” w [deploy/README.md](../../deploy/README.md).

Kontener `api-gateway` jest w sieciach `backend` (Consul, Redis, usługi) i `edge` (wejście z zewnątrz). Nie zależy od `auth-service` – startuje także bez niego.

## Pierwsze żądania

Z działającym zestawem `platform` (sekcja wyżej). Założenie konta (przykładowe dane, jak w [deploy/README.md](../../deploy/README.md)):

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Content-Type: application/json' \
  -d '{"email":"anna@example.com","password":"Haslo-1234!","firstName":"Anna","lastName":"Nowak"}' \
  http://localhost:8080/api/v1/auth/register
```

Wynik: `201`, przy kolejnym uruchomieniu `409` (e-mail zajęty) – konto już jest, można się logować.

Logowanie: `accessToken` z odpowiedzi trafia do zmiennej `T` i nie pojawia się na ekranie (token traktuj jak hasło; jest ważny 15 minut). Potem żądanie bez tokenu i z tokenem:

```bash
T=$(curl -s -H 'Content-Type: application/json' -d '{"email":"anna@example.com","password":"Haslo-1234!"}' \
  http://localhost:8080/api/v1/auth/login | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
curl -s -w ' %{http_code}\n' http://localhost:8080/api/v1/users/me
curl -s -w ' %{http_code}\n' -H "Authorization: Bearer $T" http://localhost:8080/api/v1/users/me
curl -s -w ' %{http_code}\n' -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d '{}' \
  http://localhost:8080/api/v1/products
unset T
```

Wynik (treść błędu w formacie zespołu, na końcu kod):

| Żądanie | Kod | Dlaczego |
|---|---|---|
| `GET /api/v1/users/me` bez tokenu | `401` `UNAUTHORIZED` | trasa wymaga logowania |
| `GET /api/v1/users/me` z tokenem | `503` `SERVICE_UNAVAILABLE` | token przeszedł, ale User Service nie działa w zestawie `platform` |
| `POST /api/v1/products` z tokenem klienta | `403` `FORBIDDEN` | zarządzanie katalogiem wymaga roli `ADMIN` |

Gdy logowanie się nie uda (np. `429` po więcej niż 5 logowaniach w minucie), `T` jest puste i oba żądania z tokenem dostają `401`. Po 15 minutach token wygasa – wtedy też `401`, trzeba zalogować się ponownie.

## Uruchomienie z VS Code

Infrastruktura musi działać w Docker Compose: Consul (`127.0.0.1:8500`) i Redis `redis-gateway` (`127.0.0.1:6379`, liczniki limitów żądań). Gateway z VS Code liczy limity w tym samym Redisie co Gateway z Docker Compose.

1. Wersja Node.js z pliku `.nvmrc` (22) i zależności:

   ```bash
   cd services/api-gateway
   nvm use
   npm ci
   ```

   Wymaga [nvm](https://github.com/nvm-sh/nvm) (na Windowsie nvm-windows: `nvm use 22`). Bez nvm wystarczy zainstalowany Node.js 22 (`node -v` → `v22.…`).

   Na końcu `npm ci` pokazuje ostrzeżenie `npm audit` o podatnościach – dotyczy narzędzi deweloperskich (Jest, Nest CLI), nie kodu w obrazie, i nie przerywa instalacji. Nie uruchamiaj `npm audit fix`: zmienia `package.json` i `package-lock.json` w repozytorium.

2. Port 8080 zajmuje Gateway z Docker Compose. Zatrzymaj go:

   ```bash
   docker compose -f ../../deploy/compose.yaml --profile platform stop api-gateway
   ```

   albo uruchom Gateway z VS Code na innym porcie: w poleceniu z kroku 3 zamień `PORT=8080` na `PORT=18080`.

3. Start z przeładowaniem po zmianie kodu (przy Gateway z Docker Compose działającym dalej – `PORT=18080` zamiast `PORT=8080`, krok 2). Zmienne z kolumny „Lokalnie”; hasło do Redisa trafia prosto ze zmiennej kontenera `redis-gateway` do zmiennej procesu – nie pojawia się na ekranie ani w pliku:

   ```bash
   PORT=8080 CONSUL_HOST=127.0.0.1 CONSUL_PORT=8500 SERVICE_ADDRESS=host.docker.internal \
   REDIS_HOST=127.0.0.1 REDIS_PORT=6379 \
   REDIS_PASSWORD="$(docker compose -f ../../deploy/compose.yaml exec -T redis-gateway printenv REDIS_PASSWORD)" \
   npm run start:dev
   ```

   Bez `SERVICE_ADDRESS` Gateway nie wystartuje: trasa do Consula pod `127.0.0.1` prowadzi przez adres pętli zwrotnej, którego Consul w kontenerze nie osiągnie (komunikat w logu prosi o `SERVICE_ADDRESS`).

   **Ograniczenie:** usługi z Docker Compose rejestrują w Consulu adresy z sieci `backend`, niedostępne z laptopa. Gateway uruchomiony z VS Code przekaże więc żądania tylko do usług uruchomionych też lokalnie (rejestrujących się z `host.docker.internal`, np. Auth Service z VS Code). Gdy Auth działa w Docker Compose, w logu Gateway pojawi się ostrzeżenie `No JWKS keys from Auth Service…`, a `/api/v1/auth/…` odpowie `502` na zmianę z `503` (po `502` niedostępna instancja wypada z listy, a po serii awarii otwiera się circuit breaker) – to oczekiwane.

4. Sprawdzenie:

   ```bash
   curl -i http://localhost:8080/health/ready
   ```

   Przy `PORT=18080` (krok 2 i 3) sprawdź `http://localhost:18080/health/ready` – pod `8080` odpowiada Gateway z Docker Compose.

   Rejestracja w Consulu: http://127.0.0.1:8500/ui → Services → `api-gateway`. Wpis z adresem `host.docker.internal` to instancja z VS Code. Jeśli macOS zapyta, czy zezwolić aplikacji `node` na połączenia przychodzące, zezwól – inaczej check w Consulu będzie `critical`.

Zatrzymanie: Ctrl+C (Gateway wyrejestruje się z Consula). Potem ewentualnie `docker compose -f ../../deploy/compose.yaml --profile platform start api-gateway`.


## Testy i lint

W folderze `services/api-gateway`, po `npm ci` (sekcja „Uruchomienie z VS Code”, krok 1):

```bash
npm test        # testy jednostkowe (Jest), bez Consula i Redisa
npm run lint    # ESLint
npm run build   # kompilacja do dist/
```

Testy leżą obok kodu (`*.spec.ts`). Jest działa w trybie ESM, bo pakiety NestJS 12 są tylko ESM; `npm test` ustawia potrzebne flagi. Testy warstwy HTTP (`src/setup-app.spec.ts`, `src/proxy/proxy.spec.ts`) uruchamiają prawdziwy serwer na losowym porcie; testy proxy dodatkowo testową usługę HTTP i zamknięty port (brak połączenia). Limity są testowane na prawdziwej wtyczce `@fastify/rate-limit` z atrapą Redisa w pamięci, która wykonuje polecenia definiowane przez magazyn Redis wtyczki (`src/limits/rate-limiter.service.spec.ts`: osobne klucze, kolejność limitów, 429 z `Retry-After`, brak `X-RateLimit-*`, Redis niedostępny i zawieszony), circuit breaker na sztucznym zegarze (`src/proxy/circuit-breakers.service.spec.ts`).

## Postman

Kolekcja: [postman/api-gateway.postman_collection.json](postman/api-gateway.postman_collection.json), środowisko: [postman/api-gateway.local.postman_environment.json](postman/api-gateway.local.postman_environment.json) (`baseUrl` = `http://localhost:8080`, Gateway z Docker Compose). Działa na zestawie `platform` (Gateway, Auth Service, infrastruktura) bez innych usług. Żądania po kolei:

| Żądanie | Oczekiwane |
|---|---|
| `GET /health/live`, `GET /health/ready` | 200 `{"status":"UP"}`, bez `X-Instance-Id` |
| `POST /api/v1/auth/register` (unikalny e-mail generowany w skrypcie) | 201 |
| `POST /api/v1/auth/login` | 200, `accessToken` zapisany w zmiennej kolekcji, ciasteczko `refresh_token` z `Path=/api/v1/auth` |
| `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout` | 200, 204 (ciasteczko przez Gateway) |
| `POST /api/v1/auth/refresh` po wylogowaniu | 401 |
| `GET /api/v1/users/me` bez tokenu / z tokenem | 401 `UNAUTHORIZED` / 503 `SERVICE_UNAVAILABLE` (User Service nie działa w Docker Compose) |
| `POST /api/v1/users` | 404 (endpoint wewnętrzny) |
| `POST /api/v1/products` z tokenem klienta | 403 `FORBIDDEN` |
| `GET /api/v1/products/%2e%2e/users` | 400 `VALIDATION_ERROR` |
| `GET /api/v1/nie-ma` | 404 `NOT_FOUND` |

Każde żądanie sprawdza kod, nagłówki `X-Request-Id` i `X-Gateway-Instance-Id`, a błędy Gateway – format `{"status","error","message","requestId"}`. Kolekcja zapisuje wartość ciasteczka `refresh_token` po logowaniu i odświeżeniu i wysyła ją sama w nagłówku `Cookie` (w tych żądaniach słoik ciasteczek jest wyłączony). Dzięki temu wynik nie zależy od tego, czy klient odsyła ciasteczko `Secure` po `http://localhost`.

Z wiersza poleceń (z katalogu głównego repozytorium):

```bash
npx --yes newman run services/api-gateway/postman/api-gateway.postman_collection.json \
  -e services/api-gateway/postman/api-gateway.local.postman_environment.json
```

**Limity:** jeden przebieg to jedna rejestracja i jedno logowanie (limit 10 i 5 na minutę z jednego IP w Gateway, logowanie także 5 na minutę w Auth Service). Przy kilku przebiegach w ciągu minuty kolejne mogą dostać 429 – odczekaj minutę albo wyzeruj liczniki Gateway (polecenie w sekcji „Limity żądań i circuit breaker”).

## Pokaz load balancingu

Z katalogu głównego repozytorium, przy działającym zestawie `platform`. Druga instancja Auth Service:

```bash
docker compose -f deploy/compose.yaml --profile platform up -d --wait --scale auth-service=2
sleep 12   # Gateway odświeża listę instancji z Consula co 10 s
```

Osiem żądań przez Gateway i nagłówek `X-Instance-Id` z odpowiedzi (`POST /api/v1/auth/logout` bez ciasteczka odpowiada 204 i niczego nie zmienia):

```bash
for i in $(seq 1 8); do
  curl -s -D - -o /dev/null -X POST http://localhost:8080/api/v1/auth/logout | grep -i '^x-instance-id' | tr -d '\r'
done | sort | uniq -c
```

Wynik: dwie różne wartości `x-instance-id: auth-service-<hostname>`, każda po 4 razy (round robin). `X-Gateway-Instance-Id` jest w każdej odpowiedzi ten sam – działa jedna instancja Gateway.

Powrót do jednej instancji:

```bash
docker compose -f deploy/compose.yaml --profile platform up -d --wait --scale auth-service=1
sleep 12   # Gateway odświeża listę instancji z Consula co 10 s
```

Usunięta instancja wyrejestrowuje się z Consula, ale Gateway może ją mieć na liście jeszcze do 10 s. Żądanie, które w tym czasie do niej trafi, czeka na połączenie najwyżej 2 s: `GET` i `HEAD` są wtedy ponawiane do drugiej instancji, inne metody dostają **502**.
