# Auth Service

Konta użytkowników, logowanie i tokeny JWT. Usługa rejestruje się w Consulu, czyta konfigurację z Consul KV, loguje w JSON i zwraca błędy w formacie zespołu. Jej szkielet (konfiguracja, Consul, logi, błędy, health) jest wzorcem dla pozostałych usług w Node.js.

| | |
|---|---|
| Właściciel | Michał |
| Technologia | Node.js 22 · NestJS 12 na Fastify · Prisma 7 (PostgreSQL) |
| Port | 8081 |
| Nazwa w Consulu, Kubernetesie i obrazie Docker | `auth-service` |
| Baza | `auth_db`, rola `auth_service` |
| Health checki | `/health/live`, `/health/ready` |

## Endpointy

Ścieżki bez `/api/v1` (prefiks obcina Gateway).

| Metoda i ścieżka | Wejście | Sukces | Błędy |
|---|---|---|---|
| `POST /auth/register` | JSON `{"email","password","firstName","lastName"}` | **201** `{"id","email","firstName","lastName","roles":["CUSTOMER"]}` – bez tokenów (rejestracja nie loguje) | **400** `VALIDATION_ERROR`, **409** `EMAIL_TAKEN`, **503** `SERVICE_UNAVAILABLE` |
| `POST /auth/login` | JSON `{"email","password"}` | **200** `{"accessToken":"<jwt>","tokenType":"Bearer","expiresIn":900}` + `Set-Cookie: refresh_token=…` | **400** `VALIDATION_ERROR`, **401** `INVALID_CREDENTIALS`, **429** `TOO_MANY_REQUESTS` (limit IP) / `TOO_MANY_ATTEMPTS` (blokada konta), oba z `Retry-After` |
| `POST /auth/refresh` | ciasteczko `refresh_token`, treść pusta | **200** jak logowanie + nowe `Set-Cookie: refresh_token=…` | **401** `UNAUTHORIZED` (brak, nieznany, wygasły albo unieważniony token) + ciasteczko wyczyszczone |
| `POST /auth/logout` | ciasteczko `refresh_token` (opcjonalne) | **204** + `Set-Cookie: refresh_token=; Max-Age=0; …` | — (zawsze 204) |
| `GET /.well-known/jwks.json` | — | **200** `{"keys":[{"kty":"RSA","n","e","kid","alg":"RS256","use":"sig"}]}` – klucz publiczny do sprawdzania tokenów | — |
| `GET /health/live` | — | **200** `{"status":"UP"}` – proces działa, bez sprawdzania zależności | — |
| `GET /health/ready` | — | **200** `{"status":"UP"}` – baza odpowiada na `SELECT 1`; Consul nie jest warunkiem | **503** `SERVICE_UNAVAILABLE` |
| `GET /docs`, `GET /openapi.json` | — | Swagger UI i dokument OpenAPI | — |
| każda inna ścieżka | — | — | **404** `NOT_FOUND` |

Walidacja wejścia (nieznane pola, np. `roles`, dają **400**):

- `email` – przycięty i zamieniony na małe litery, najwyżej 254 znaki. `Anna@Example.com` i `anna@example.com` to to samo konto.
- `password` – przy rejestracji 10–72 **bajty** UTF-8 (polska litera to 2 bajty; bcrypt pomija wszystko po 72. bajcie, więc dłuższe hasło jest odrzucane). Przy logowaniu 1–72 bajty.
- `firstName`, `lastName` – 1–100 znaków po przycięciu.

Odpowiedzi nigdy nie zawierają hasła, jego hasha ani refresh tokenu w treści (refresh token jest tylko w ciasteczku).

Każda odpowiedź ma nagłówki:

- `X-Request-Id` – wartość od klienta, jeśli pasuje do `^[A-Za-z0-9._-]{1,64}$`, w przeciwnym razie nowy UUID. Ta sama wartość jest w logach i w treści błędu.
- `X-Instance-Id` – ID instancji w Consulu (`auth-service-<hostname>`); przy kilku instancjach widać, która odpowiedziała.

Format błędu (także 404, zły JSON i błędy Fastify):

```json
{"status": 400, "error": "VALIDATION_ERROR", "message": "…", "requestId": "…"}
```

`message` jest po angielsku. Treść błędu nigdy nie zawiera stack trace.

| `error` | Status | Kiedy |
|---|---|---|
| `VALIDATION_ERROR` | 400 | błędne pole, zły JSON, nieznane pole |
| `INVALID_CREDENTIALS` | 401 | złe hasło albo nieznany e-mail (ta sama odpowiedź w obu przypadkach) |
| `UNAUTHORIZED` | 401 | `/auth/refresh`: brak, nieznany, wygasły albo unieważniony refresh token |
| `NOT_FOUND` | 404 | nieznana ścieżka |
| `EMAIL_TAKEN` | 409 | e-mail już zarejestrowany (bez względu na wielkość liter) |
| `PAYLOAD_TOO_LARGE` | 413 | treść żądania większa niż 1 MiB |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | `Content-Type`, którego usługa nie obsługuje (np. `application/xml`) |
| `TOO_MANY_REQUESTS` | 429 | więcej niż 5 żądań `POST /auth/login` w ciągu 60 s z jednego adresu IP |
| `TOO_MANY_ATTEMPTS` | 429 | e-mail zablokowany na 15 min po 10 nieudanych logowaniach |
| `INTERNAL_ERROR` | 500 | nieoczekiwany błąd; szczegóły tylko w logu |
| `SERVICE_UNAVAILABLE` | 503 | baza niedostępna (`/health/ready`) albo User Service nie utworzył profilu przy rejestracji |

Inne błędy 4xx zgłaszane przez Fastify dostają kod z nazwy statusu HTTP w UPPER_SNAKE_CASE (tak powstają `PAYLOAD_TOO_LARGE` i `UNSUPPORTED_MEDIA_TYPE` z tabeli). Za duże nagłówki żądania (431) serwer HTTP odrzuca, zanim żądanie dotrze do kodu usługi, więc ta odpowiedź nie ma formatu zespołu (`{"error","message","statusCode"}`). Zła metoda HTTP na istniejącej ścieżce (np. `DELETE /auth/login`) to **404** `NOT_FOUND`. Odpowiedź 429 ma nagłówek `Retry-After` (sekundy).

## Zmienne środowiskowe

Nazwy są w [.env.example](.env.example) (bez wartości).

| Zmienna | Docker Compose | Lokalnie (VS Code) | Uwagi |
|---|---|---|---|
| `PORT` | `8081` | `8081` | |
| `LOG_LEVEL` | — | — | opcjonalnie; nadpisuje `logLevel` z KV |
| `CONSUL_ENABLED` | — (domyślnie `true`) | `true` | `false` wyłącza rejestrację i odczyt KV |
| `CONSUL_HOST` / `CONSUL_PORT` | `consul` / `8500` | `127.0.0.1` / `8500` | |
| `SERVICE_ADDRESS` | — (pusty → IP kontenera) | `host.docker.internal` | adres zapisany w Consulu |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` | `postgres` / `5432` / `auth_db` / `auth_service` | `127.0.0.1` / `5432` / `auth_db` / `auth_service` | |
| `DB_PASSWORD` | `AUTH_DB_PASSWORD` z `deploy/.env` | wartość `AUTH_DB_PASSWORD` z `deploy/.env` | |
| `DB_SHADOW_NAME` | — | `auth_shadow_db` | tylko dla `npx prisma migrate dev` (sekcja „Migracje bazy”) |
| `JWT_PRIVATE_KEY_FILE` | `/run/secrets/jwt-private.pem` | `../../deploy/secrets/jwt-private.pem` | klucz prywatny RS256 (PKCS#8); brak albo zły plik → usługa nie startuje |
| `JWT_ISSUER` / `JWT_AUDIENCE` | — | — | opcjonalnie; nadpisują KV |
| `ADMIN_EMAIL` | `${ADMIN_EMAIL:-admin@sklep.local}` | puste albo dowolny e-mail | pierwsze konto ADMIN (sekcja „Konto administratora”) |
| `ADMIN_PASSWORD` | `ADMIN_PASSWORD` z `deploy/.env` | puste albo 10–72 bajty | |
| `USER_SERVICE_ENABLED` | `"false"` (do etapu 5) | `false` | domyślnie `true`; `false` → rejestracja bez wywołania User Service |

Połączenie z bazą powstaje tylko ze zmiennych `DB_*` (bez `DATABASE_URL`).

### Konfiguracja z Consul KV

Klucz `config/auth-service/data` (YAML, plik źródłowy [deploy/consul/config/auth-service.yaml](../../deploy/consul/config/auth-service.yaml)): `logLevel`, `jwt.issuer`, `jwt.audience`. Kolejność: zmienna środowiskowa > Consul KV > wartość domyślna w kodzie (`info`, `sklep-auth`, `sklep-api`). KV jest czytane raz przy starcie (timeout 2 s). Gdy Consul jest niedostępny, usługa startuje na wartościach domyślnych i zapisuje ostrzeżenie w logu. Zmiana w KV działa po restarcie usługi.

### Rejestracja w Consulu

Usługa rejestruje się po starcie serwera HTTP: nazwa `auth-service`, ID `auth-service-<hostname>`, adres z `SERVICE_ADDRESS` albo IP kontenera, check HTTP `/health/ready` co 10 s. Co 15 s sprawdza, czy wpis w Consulu nadal istnieje i ma aktualny adres; jeśli nie (np. Consul był wyłączony), rejestruje się ponownie. Przy zatrzymaniu (SIGTERM, Ctrl+C) wyrejestrowuje się.

## Rejestracja i User Service

Rejestracja zapisuje konto (rola `CUSTOMER`, hasło jako hash bcrypt o koszcie 12) i tworzy profil użytkownika w User Service w **jednej transakcji bazy**: konto zostaje zapisane dopiero wtedy, gdy User Service odpowie 200 albo 201. Każda inna sytuacja wycofuje konto i kończy się **503** `SERVICE_UNAVAILABLE`, więc nie powstaje konto bez profilu. Zajęty e-mail daje **409** bez wywołania User Service.

Wywołanie: `POST http://<instancja user-service z Consula>/users`, nagłówki `X-User-Id: <id nowego konta>`, `X-User-Roles: SERVICE`, `X-Request-Id: <bieżący>`, treść `{"id","email","firstName","lastName"}`.

- Instancja: zdrowe instancje `user-service` z Consula (lista trzymana 10 s, na zmianę – round robin). Brak instancji → 503 bez wywołania.
- Timeout 2 s na próbę. Po timeoucie, błędzie sieci albo odpowiedzi 5xx **jedno** ponowienie po 200 ms, z tym samym `id` (User Service traktuje powtórzenie tego samego `id` jako to samo żądanie). Odpowiedź 4xx – bez ponowienia.
- Circuit breaker (`opossum`) obejmuje całe wywołanie razem z ponowieniem: gdy w ciągu 60 s było co najmniej 10 wywołań i ponad połowa z nich zakończyła się błędem, przez 30 s kolejne rejestracje dostają 503 od razu, bez wywołania User Service. Potem jedno wywołanie próbne: sukces zamyka obwód. Odpowiedzi 4xx inne niż 408 i 429 (np. 409) nie liczą się jako awaria User Service.
- Transakcja ma limit 10 s (dwie próby po 2 s, odstęp i zapytanie do Consula).

`USER_SERVICE_ENABLED=false` (w Docker Compose do etapu 5, bo User Service jeszcze tam nie działa): rejestracja zapisuje samo konto bez wywołania User Service, a log dostaje ostrzeżenie `User Service call is disabled …` z `userId` nowego konta.

## Tokeny i JWKS

Logowanie zwraca access token JWT podpisany RS256, ważny 900 s. Nagłówek tokenu ma `kid` (odcisk RFC 7638 klucza publicznego), treść: `sub` (UUID konta), `roles` (`["CUSTOMER"]` albo `["ADMIN"]`), `iss` i `aud` z konfiguracji (`sklep-auth`, `sklep-api`), `iat`, `exp`. Token nie zawiera e-maila. Logowanie nieistniejącego e-maila też wykonuje porównanie bcrypt (z hashem losowej wartości), więc czas i treść odpowiedzi nie zdradzają, czy konto istnieje.

Klucz prywatny jest w pliku `JWT_PRIVATE_KEY_FILE` (PKCS#8, tworzy go `deploy/create-secrets.sh` jako `deploy/secrets/jwt-private.pem`; w Docker Compose montowany tylko do odczytu jako `/run/secrets/jwt-private.pem`). Usługa wczytuje go przy starcie; brak pliku albo zły format kończy start błędem `Cannot load the JWT private key from <ścieżka>` z przyczyną (bez treści klucza). `GET /.well-known/jwks.json` publikuje tylko część publiczną – z niej Gateway sprawdza podpis, `kid`, `exp`, `iss` i `aud`.

## Sesja: refresh token w ciasteczku

Logowanie zwraca access token w treści, a refresh token (ważny 7 dni) tylko w ciasteczku:

```
Set-Cookie: refresh_token=<43 znaki>; Max-Age=604800; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict
```

- Wartość to 32 losowe bajty (base64url). W bazie (`refresh_tokens.token_hash`) jest tylko jej SHA-256 (hex), więc wyciek bazy nie daje działających tokenów. Ani wartość, ani hash nie trafiają do logów.
- `HttpOnly` – skrypt na stronie nie odczyta tokenu; `SameSite=Strict` – przeglądarka nie wyśle go z cudzej strony; `Secure` – tylko przez HTTPS (wyjątek w przeglądarkach: `localhost`).
- `Path=/api/v1/auth` – przeglądarka widzi Auth przez Gateway, więc wysyła ciasteczko tylko do `/api/v1/auth/*` (refresh, logout), nie do innych usług.

`POST /auth/refresh` (bez treści, z ciasteczkiem) wydaje nowy access token z rolami **z bazy** (zmiana ról działa od następnego odświeżenia) i **wymienia** refresh token: stary dostaje `revoked_at` i `replaced_by_id`, nowy należy do tej samej rodziny (`family_id`, rodzina zaczyna się przy logowaniu). Użycie tokenu, który został już wymieniony, oznacza, że ktoś go skopiował: Auth unieważnia całą rodzinę (także najnowszy token), odpowiada **401** i zapisuje w logu ostrzeżenie `Refresh token reuse detected…` z `userId` i `familyId`. Gdy dwa odświeżenia z tym samym tokenem przyjdą równocześnie (np. dwie karty przeglądarki), tylko jedno może go wymienić, a drugie jest traktowane jak ponowne użycie – użytkownik musi zalogować się ponownie (świadomie, bez okresu łaski).

Każda odpowiedź **401** z `/auth/refresh` czyści ciasteczko (`Max-Age=0`), żeby przeglądarka nie wysyłała martwego tokenu. Inne błędy (np. **500** przy niedostępnej bazie) go nie czyszczą.

`POST /auth/logout` unieważnia rodzinę tokenu z ciasteczka i czyści ciasteczko. Odpowiada **204** zawsze, także bez ciasteczka i z nieznanym tokenem. Access token działa dalej do końca swoich 15 minut.

Usunięcie konta usuwa jego refresh tokeny (`ON DELETE CASCADE`).

**Bez Gateway** (`curl`, Postman, testy) ciasteczko nie zostanie odesłane samo: adres to `http://…/auth/refresh`, a ciasteczko ma `Path=/api/v1/auth` i `Secure`. Wartość trzeba przepisać z nagłówka `Set-Cookie` do nagłówka `Cookie` (przykład w sekcji „Zapytania bez Gateway”). Przez Gateway (od etapu 3) przeglądarka zrobi to sama.

## Limit prób logowania i blokada konta

Kolejność sprawdzeń przy `POST /auth/login`: limit IP → blokada konta → hasło.

**Limit IP:** najwyżej 5 żądań `POST /auth/login` w ciągu 60 s z jednego adresu IP (każde żądanie się liczy, także udane i z błędną treścią). Szóste dostaje **429** `TOO_MANY_REQUESTS` z `Retry-After` (sekundy do końca okna). Licznik jest w pamięci instancji: restart go zeruje, a przy kilku instancjach każda liczy osobno (wspólny limit doda Gateway w etapie 3). Rejestracja, odświeżanie i wylogowanie nie mają limitu.

Adres IP to `request.ip` Fastify z `trustProxy` ograniczonym do sieci prywatnych i pętli (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, plik `src/common/fastify-adapter.ts`). Żądanie z takiego adresu może podać prawdziwy adres klienta w `X-Forwarded-For` (od etapu 3 robi to Gateway); wpisy przed pierwszym adresem spoza tych sieci są pomijane. Skutek: każdy kontener w sieci `sklep_backend` może podać dowolny `X-Forwarded-For` – z tego korzystają testy etapu. Dlatego Auth nie ma portu na laptopie, a Gateway musi nadpisywać ten nagłówek.

**Blokada konta:** nieudane logowania liczone są w tabeli `login_failures` po znormalizowanym e-mailu – także dla e-maili bez konta, więc odpowiedź nie zdradza, czy konto istnieje. Dziesiąta nieudana próba (odpowiedź jeszcze **401**) blokuje e-mail na 15 minut i zeruje licznik. W czasie blokady każde logowanie tym e-mailem (także z dobrym hasłem) dostaje **429** `TOO_MANY_ATTEMPTS` z `Retry-After` (1–900 s) – bez sprawdzania hasła i bez liczenia. Udane logowanie usuwa wiersz (licznik od zera). Licznik zmienia jedno polecenie SQL (`INSERT … ON CONFLICT DO UPDATE`), więc równoczesne próby liczą się poprawnie. Założenie blokady trafia do logu jako ostrzeżenie `Login locked…` z `userId` (gdy konto istnieje), bez e-maila.

Zdjęcie blokady ręcznie (lokalnie, np. po testach):

```bash
docker compose -f deploy/compose.yaml exec -T postgres psql -U postgres -d auth_db \
  -c "delete from login_failures where email = 'anna@example.com'"
```

## Konto administratora

Przy starcie usługa zakłada konto z rolą `ADMIN`, gdy ustawione są obie zmienne `ADMIN_EMAIL` i `ADMIN_PASSWORD`, a konta z tym e-mailem jeszcze nie ma. Istniejące konto zostaje bez zmian – późniejsza zmiana `ADMIN_PASSWORD` **nie zmienia** hasła. Konto administratora nie ma profilu w User Service.

- Obie zmienne puste albo nieustawione → konto nie powstaje (informacja w logu). Tak jest przy pracy z VS Code: admina zakłada kontener `auth-service` w tej samej bazie.
- Tylko jedna z nich, niepoprawny e-mail albo hasło spoza 10–72 bajtów → usługa nie startuje (komunikat w logu bez wartości zmiennych).
- Błąd bazy przy zakładaniu konta → błąd w logu, usługa startuje dalej; konto powstanie przy następnym starcie.

W Docker Compose e-mail to `admin@sklep.local` (zmiana: `ADMIN_EMAIL=…` w `deploy/.env` przed pierwszym startem Auth), hasło – `ADMIN_PASSWORD` z `deploy/.env`. Logowanie jako ADMIN: [deploy/README.md](../../deploy/README.md), sekcja „Logowanie jako ADMIN”.

## Uruchomienie w Docker Compose

Z katalogu głównego repozytorium (wymaga `deploy/.env` i klucza `deploy/secrets/jwt-private.pem`, patrz [deploy/README.md](../../deploy/README.md)). Po aktualizacji repozytorium najpierw `bash deploy/create-secrets.sh` – dopisze brakujące zmienne (np. `ADMIN_PASSWORD`), bez nich Docker Compose się nie uruchomi:

```bash
bash deploy/create-secrets.sh
docker compose -f deploy/compose.yaml --profile platform up -d --wait --build
```

Uruchamiają się dwa kontenery z obrazu `auth-service:dev`:

- `auth-migrate` – jednorazowo stosuje migracje bazy (`prisma migrate deploy`) i kończy się kodem 0,
- `auth-service` – startuje po udanych migracjach.

Usługa nie ma portu na laptopie. Jest dostępna tylko w sieci `sklep_backend` (od etapu 3 przez Gateway).

Kilka instancji (każda rejestruje się w Consulu osobno):

```bash
docker compose -f deploy/compose.yaml --profile platform up -d --wait --scale auth-service=2
```

Limit prób logowania liczy każda instancja osobno. Powrót do jednej instancji – zwykłe polecenie startowe, bez `--scale`:

```bash
docker compose -f deploy/compose.yaml --profile platform up -d --wait
```

Zostaje jeden kontener; może się nazywać `sklep-auth-service-2` (to normalne).

## Uruchomienie z VS Code

Infrastruktura (Consul, PostgreSQL) musi działać w Docker Compose. Kontener `auth-service` może przy tym działać – obie instancje mają różne ID w Consulu.

1. Wersja Node.js z pliku `.nvmrc` (22):

   ```bash
   cd services/auth-service
   nvm use
   ```

   Wymaga [nvm](https://github.com/nvm-sh/nvm) (na Windowsie nvm-windows: `nvm use 22`). Bez nvm wystarczy zainstalowany Node.js 22 (`node -v` → `v22.…`).

2. Zależności (klient Prisma generuje się automatycznie po instalacji):

   ```bash
   npm ci
   ```

3. Plik `.env` z wartościami z kolumny „Lokalnie” (opis każdej zmiennej jest w `.env.example`) i hasłem do bazy prosto z kontenera PostgreSQL. Hasło nie pojawia się na ekranie; nie wklejaj go nigdzie ręcznie:

   ```bash
   printf '%s\n' \
     PORT=8081 \
     CONSUL_ENABLED=true \
     CONSUL_HOST=127.0.0.1 \
     CONSUL_PORT=8500 \
     SERVICE_ADDRESS=host.docker.internal \
     DB_HOST=127.0.0.1 \
     DB_PORT=5432 \
     DB_NAME=auth_db \
     DB_USER=auth_service \
     DB_SHADOW_NAME=auth_shadow_db \
     JWT_PRIVATE_KEY_FILE=../../deploy/secrets/jwt-private.pem \
     USER_SERVICE_ENABLED=false > .env
   printf 'DB_PASSWORD=%s\n' "$(docker compose -f ../../deploy/compose.yaml exec -T postgres printenv AUTH_DB_PASSWORD)" >> .env
   ```

   `USER_SERVICE_ENABLED=false`, bo User Service nie działa jeszcze w Docker Compose. Bez `ADMIN_EMAIL` i `ADMIN_PASSWORD` usługa nie zakłada konta administratora (sekcja „Konto administratora”). Opcjonalne `LOG_LEVEL`, `JWT_ISSUER`, `JWT_AUDIENCE` możesz dopisać według `.env.example`. Plik `.env` jest w `.gitignore` i nie trafia do obrazu.

4. Migracje bazy (Prisma CLI czyta `.env` przez `prisma.config.ts`):

   ```bash
   npx prisma migrate deploy
   ```

5. Start z przeładowaniem po zmianie kodu:

   ```bash
   npm run start:dev
   ```

6. Sprawdzenie:

   ```bash
   curl -i http://localhost:8081/health/ready
   ```

   Rejestracja w Consulu: http://127.0.0.1:8500/ui → Services → `auth-service`. Wpis z adresem `host.docker.internal` to instancja z VS Code; check `/health/ready` wykonuje Consul z kontenera. Jeśli macOS zapyta, czy zezwolić aplikacji `node` na połączenia przychodzące, zezwól – inaczej check w Consulu będzie `critical`.

Zatrzymanie: Ctrl+C w terminalu z `npm run start:dev` (usługa wyrejestruje się z Consula).

## Zapytania bez Gateway

Z laptopa przy pracy z VS Code: `http://localhost:8081`, np.:

```bash
curl -s -i -H 'Content-Type: application/json' \
  -d '{"email":"anna@example.com","password":"Haslo-1234!","firstName":"Anna","lastName":"Nowak"}' \
  http://localhost:8081/auth/register
curl -s -H 'Content-Type: application/json' \
  -d '{"email":"anna@example.com","password":"Haslo-1234!"}' \
  http://localhost:8081/auth/login
curl -s http://localhost:8081/.well-known/jwks.json
```

Przy ponownym uruchomieniu rejestracja zwróci **409** `EMAIL_TAKEN` – to normalne, logowanie działa dalej (albo zmień e-mail). Przykłady w tej sekcji logują się dwa razy; limit to 5 logowań na minutę z jednego adresu (sekcja „Limit prób logowania i blokada konta”).

Odświeżenie i wylogowanie – wartość ciasteczka z logowania w zmiennej `R` (nie wypisuj jej), wysłana ręcznie w nagłówku `Cookie`:

```bash
R=$(curl -s -D - -o /dev/null -H 'Content-Type: application/json' \
  -d '{"email":"anna@example.com","password":"Haslo-1234!"}' http://localhost:8081/auth/login \
  | sed -nE 's/^[Ss]et-[Cc]ookie: refresh_token=([^;]*).*/\1/p')
curl -s -X POST -H "Cookie: refresh_token=$R" http://localhost:8081/auth/refresh   # nowy access token, nowe ciasteczko
curl -s -i -X POST -H "Cookie: refresh_token=$R" http://localhost:8081/auth/logout  # 204
```

Po odświeżeniu stara wartość `R` jest już wymieniona: ponowne `/auth/refresh` z nią da **401** i unieważni rodzinę. Nową wartość daje nagłówek `Set-Cookie` odpowiedzi (`curl -D -`). Wylogowanie z dowolnym tokenem rodziny (także wymienionym) unieważnia całą rodzinę.

Do kontenera w Docker Compose – z jednorazowego kontenera w sieci `sklep_backend` (obraz Consula ma `curl`):

```bash
docker run --rm --network sklep_backend --entrypoint curl hashicorp/consul:1.21 -s -i http://auth-service:8081/health/ready
```

## Testy i lint

```bash
npm test        # testy jednostkowe (Jest), bez bazy i Consula
npm run lint    # ESLint
npm run build   # kompilacja do dist/
```

Testy leżą obok kodu (`*.spec.ts`). Jest działa w trybie ESM, bo pakiety NestJS 12 są tylko ESM; `npm test` ustawia potrzebne flagi.

## Migracje bazy

Schemat: [prisma/schema.prisma](prisma/schema.prisma), migracje: `prisma/migrations/` (w repozytorium, każda w osobnym folderze z plikiem `migration.sql`). W Docker Compose migracje stosuje kontener `auth-migrate`, lokalnie `npx prisma migrate deploy`.

| Tabela | Kolumny |
|---|---|
| `accounts` | `id uuid` (klucz), `email text` (unikalny, małe litery), `password_hash text`, `roles text[]` (domyślnie `{CUSTOMER}`), `created_at timestamptz`, `updated_at timestamptz` |
| `refresh_tokens` | `id uuid` (klucz), `account_id uuid` (→ `accounts`, `ON DELETE CASCADE`), `family_id uuid` (indeks), `token_hash text` (unikalny, SHA-256 hex), `expires_at timestamptz`, `revoked_at timestamptz` (pusty = ważny), `replaced_by_id uuid` (następca po wymianie), `created_at timestamptz` |
| `login_failures` | `email text` (klucz, znormalizowany), `failed_count int`, `locked_until timestamptz` (pusty albo w przeszłości = brak blokady), `updated_at timestamptz` |

Migracje: `…_create_accounts` (tabela `accounts`), `…_refresh_tokens_and_login_failures` (dwie pozostałe). Tabelę `login_failures` zmienia surowe SQL w `src/auth/login-attempts.service.ts` (atomowy licznik), dlatego `updated_at` ustawia tam samo polecenie, a nie Prisma.

Nowa migracja po zmianie `schema.prisma` – z folderu `services/auth-service`, z plikiem `.env` z kroku 3 uruchomienia z VS Code (w nim `DB_SHADOW_NAME=auth_shadow_db`):

```bash
npx prisma migrate dev --name <krotki_opis_po_angielsku>
```

Prisma sprawdza migracje na bazie cieni `auth_shadow_db` (osobna baza w tym samym PostgreSQL, właściciel `auth_service`; rola `auth_service` nie ma prawa tworzenia baz, dlatego baza cieni jest zakładana z góry przez `deploy/postgres/init/01-service-databases.sh`), tworzy folder `prisma/migrations/<data>_<opis>/` z plikiem `migration.sql` i stosuje go w `auth_db`. Z `--create-only` tylko tworzy plik, bez stosowania. Plik migracji trafia do repozytorium; kontener `auth-migrate` zastosuje go przy następnym `up`.

- Przejrzyj SQL przed commitem. Prisma tworzy kolumny tablicowe (`String[]`) bez `NOT NULL` – w tabeli `accounts` dopisano je ręcznie (`"roles" TEXT[] NOT NULL`). Prisma nie traktuje tego jako różnicy względem schematu.
- Gdy Prisma pyta o reset schematu `public` w `auth_db`, odpowiedz `N`: reset kasuje wszystkie dane. Pytanie oznacza zwykle, że baza ma zmiany spoza plików migracji.
- Błąd o braku bazy `auth_shadow_db` (wolumen PostgreSQL utworzony przed etapem 2): [deploy/README.md](../../deploy/README.md), sekcja „Reset od zera” – ponowne uruchomienie skryptu baz, bez utraty danych.

## Postman

Kolekcja: [postman/auth-service.postman_collection.json](postman/auth-service.postman_collection.json), środowisko: [postman/auth-service.local.postman_environment.json](postman/auth-service.local.postman_environment.json) (`baseUrl` = `http://localhost:8081`, usługa uruchomiona z VS Code z `USER_SERVICE_ENABLED=false`). Zawiera: health, 404, JWKS, rejestrację (201, 409, 400), logowanie (200 – token zapisywany w zmiennej kolekcji `accessToken`, 401) i sesję: odświeżenie (200, nowe ciasteczko), ponowne użycie wymienionego tokenu (401), najnowszy token po ponownym użyciu (401), odświeżenie bez ciasteczka (401), ponowne logowanie, wylogowanie (204), odświeżenie po wylogowaniu (401), wylogowanie bez ciasteczka (204). Każde żądanie ma testy (kod odpowiedzi, treść, nagłówki `X-Request-Id` i `X-Instance-Id`, atrybuty `Set-Cookie`). Każdy przebieg rejestruje nowy e-mail (`postman-<czas>-<liczba>@example.com`).

Ciasteczko ma `Path=/api/v1/auth`, więc Postman nie wyśle go sam do `http://localhost:8081/auth/refresh`. Kolekcja przepisuje wartość z nagłówka `Set-Cookie` do zmiennej `refreshToken` i wysyła własny nagłówek `Cookie: refresh_token={{refreshToken}}`.

Jeden przebieg wysyła 3 żądania `POST /auth/login`, a limit to 5 na minutę z jednego adresu IP. **Kolejny przebieg uruchom po co najmniej 60 s od ostatniego logowania** (także z przykładów `curl` w sekcji „Zapytania bez Gateway”) – inaczej logowania dostaną **429** `TOO_MANY_REQUESTS`. Restart usługi też zeruje limit.

Z wiersza poleceń (z katalogu głównego repozytorium):

```bash
npx --yes newman run services/auth-service/postman/auth-service.postman_collection.json \
  -e services/auth-service/postman/auth-service.local.postman_environment.json
```

## Struktura kodu

| Folder | Zawartość |
|---|---|
| `src/main.ts` | start: konfiguracja, logger, Fastify, walidacja, Swagger, rejestracja w Consulu |
| `src/routes.ts` | **wszystkie ścieżki HTTP** w jednym miejscu: własne endpointy (dla dekoratorów `@Controller`/`@Post` i jako pełne ścieżki), ścieżka ciasteczka `/api/v1/auth`, `/users` w User Service, API Consula; kod i testy używają tych stałych, a `routes.spec.ts` sprawdza ich wartości |
| `src/config/` | konfiguracja: zmienne środowiskowe > Consul KV > wartości domyślne |
| `src/consul/` | rejestracja w Consulu i wyszukiwanie instancji innych usług (`ServiceDiscovery.getInstance`) |
| `src/common/` | `X-Request-Id`, `X-Instance-Id`, `trustProxy`, wtyczki Fastify (ciasteczka, limit żądań), logger, filtr błędów, `AppException` |
| `src/health/` | `/health/live`, `/health/ready` |
| `src/prisma/` | klient Prisma, rozpoznawanie błędów Prismy (np. naruszenie unikalności) |
| `src/auth/` | endpointy `/auth/*` i JWKS, DTO z walidacją, hasła (bcrypt), klucz i tokeny (jose), rejestracja i logowanie, refresh tokeny i ciasteczko, blokada konta, konto administratora |
| `src/user-client/` | wywołanie `POST /users` w User Service: Consul, timeout, ponowienie, circuit breaker |
