# Postman: scenariusz zakupu i pokazy

Kolekcja `shop-purchase` sprawdza sklep tak, jak używa go przeglądarka: przez wejście `http://127.0.0.1:8090/api/v1` (nginx frontendu → API Gateway → usługi), a w Kubernetes przez `https://shop.localhost/api/v1` (Ingress → API Gateway → usługi, sekcja „Środowisko `k8s`”). Przechodzi rejestrację, e-mail powitalny w Mailpit, logowanie, katalog, stronę produktu, stany magazynowe (ADMIN), koszyk, odmowy dostępu i zamówienia: zakup, odrzuconą płatność, przesyłkę, wysyłkę i doręczenie, anulowanie, opinię po zakupie i wycofany produkt w koszyku. Uruchamia ją newman w kontenerze, a wynik trafia do raportu JSON bez haseł i tokenów.

Do tego dwa skrypty pokazowe: load balancing (`lb-demo.sh`) i odporność (`resilience-demo.sh`) — sekcja „Pokazy”.

Kolekcje pojedynczych usług są w `services/<usługa>/postman/`.

## Wymagania

- Docker (Rancher Desktop z `dockerd`, jak w [deploy/README.md](../deploy/README.md)).
- `deploy/.env` z `bash deploy/create-secrets.sh` — najpierw ten krok, bez niego stos się nie uruchomi (`run.sh` czyta z pliku `ADMIN_PASSWORD` i opcjonalnie `ADMIN_EMAIL`, domyślnie `admin@sklep.local`).
- Działający stos z profilem `full-shop` (pierwsze `--build` trwa kilka minut):
  ```bash
  docker compose -f deploy/compose.yaml --profile full-shop up -d --wait --build
  ```
  Nazwa projektu `sklep` jest w `deploy/compose.yaml`, więc `-p sklep` w niektórych poleceniach niżej można pominąć.
- `jq` — tylko do odczytu raportu JSON (sekcje „Raport JSON” i „Problemy”); skrypty go nie potrzebują.

Node.js na laptopie nie jest potrzebny: newman 6.2.3 jest w obrazie `shop-scenario:dev` budowanym z `postman/Dockerfile`. Runner jest w TypeScript (`runner/*.ts`); Node 22 uruchamia go wprost, bez kompilacji (sekcja „Pliki”). Wymaga to Node 22.18 albo nowszego, dlatego `postman/Dockerfile` ma dokładny obraz `node:22.23-alpine`; na starszym Node runner kończy się błędem `ERR_UNKNOWN_FILE_EXTENSION`.

## Uruchomienie

Z katalogu głównego repozytorium:

```bash
bash postman/run.sh compose            # scenariusz
bash postman/run.sh compose --strict   # każde pominięte sprawdzenie = błąd
```

Skrypt:
1. buduje obraz `shop-scenario:dev` (`docker build -q`, przy kolejnych uruchomieniach z cache);
2. czyta `ADMIN_PASSWORD` i `ADMIN_EMAIL` z `deploy/.env` jako tekst (bez `source`): usuwa znak `\r` (plik zapisany z końcami linii CRLF) i jedną parę cudzysłowów `"…"` albo `'…'` wokół wartości; komentarz albo tekst po wartości (`ADMIN_PASSWORD=abc # uwaga`) kończy skrypt kodem 2 z komunikatem `unsupported .env syntax for ADMIN_PASSWORD …`, bez wypisania wartości;
3. uruchamia kontener (`--network host`, system plików tylko do odczytu, bez uprawnień) z katalogami `runner/`, `collections/` i `environments/` tylko do odczytu oraz `reports/` do zapisu;
4. przekazuje dane admina na standardowe wejście kontenera — hasła nie ma w argumentach poleceń, w zmiennych kontenera (`docker inspect`) ani w plikach i nie jest nigdzie wypisywane, także przy `bash -x postman/run.sh` (skrypt wyłącza śledzenie poleceń).

Kontener z `--network host` widzi porty całego stosu na `127.0.0.1`, także bazy danych, Redis, RabbitMQ i Consul, a także adresy kontenerów w sieciach compose (usługi bezpośrednio, z pominięciem Gateway) — uruchamiaj w nim tylko kolekcje z tego repozytorium.

Drugie środowisko, `k8s`, opisuje sekcja „Środowisko `k8s`”.

Jeden przebieg trwa kilka sekund i loguje się dwa razy (admin i nowy klient). Limit wejścia to 5 logowań i 10 rejestracji na minutę z jednego adresu, wspólny z przeglądarką na tym samym laptopie, więc najwyżej 2 przebiegi na minutę.

## Środowisko `k8s`

Ten sam scenariusz przeciw sklepowi w przestrzeni `shop` klastra Rancher Desktop.

Wymagania:
- klaster uruchomiony według [deploy/k8s/README.md](../deploy/k8s/README.md) (`bash deploy/k8s/up.sh all`), kontekst `kubectl` o nazwie `rancher-desktop`;
- `kubectl` (instaluje go Rancher Desktop) i `mkcert` po `mkcert -install` — ten sam urząd certyfikacji podpisał certyfikat `shop.localhost`;
- `deploy/.env` jak dla compose (skrypt czyta z niego `ADMIN_PASSWORD`; to samo hasło trafia do klastra przez `deploy/k8s/secrets.sh`);
- wolne porty `18025` i `18500` na `127.0.0.1`.

```bash
bash postman/run.sh k8s            # scenariusz
bash postman/run.sh k8s --strict   # każde pominięte sprawdzenie = błąd
```

Różnice wobec `compose`:
1. Adres sklepu to `https://shop.localhost/api/v1`. Publiczny certyfikat urzędu mkcert (`$(mkcert -CAROOT)/rootCA.pem`) jest montowany do kontenera tylko do odczytu i wskazany w `NODE_EXTRA_CA_CERTS`, więc połączenie TLS jest sprawdzane, a nie pomijane. Kontener działa w sieci hosta, jak w compose; w maszynie wirtualnej Rancher Desktop `shop.localhost` wskazuje `127.0.0.1`, gdzie odpowiada Traefik.
2. Mailpit i Consul nie mają wejścia z zewnątrz. Skrypt uruchamia w tle `kubectl --context rancher-desktop -n shop port-forward svc/mailpit 18025:8025` i `svc/consul-server 18500:8500` (serwer Consula; usługa `consul` to pośrednik `consul-guard`, który odrzuca zapytania o katalog), czeka (najwyżej 15 s), aż oba nasłuchują — gdy `kubectl` zakończy się wcześniej (np. brak usługi), przerywa od razu z kodem 2 i ostatnią linią komunikatu `kubectl` — i zamyka je przy każdym zakończeniu, także po Ctrl+C i `kill`. Kontener dochodzi do nich przez `host.docker.internal:18025` i `host.docker.internal:18500` (`127.0.0.1` w sieci hosta kontenera to maszyna wirtualna, nie laptop). Porty różnią się od compose (`8025`, `8500`), więc oba środowiska mogą działać naraz.
3. Sondy folderu `00 setup` czytają katalog usług Consula bez tokenu: w klastrze Consul ma ACL, ale anonimowy token może czytać usługi i węzły.
4. Raport: `postman/reports/<yyyymmddThhmmssZ>-k8s-shop-purchase.json`, pole `environment` = `k8s`.

Limit wejścia: w klastrze wszystkie żądania z laptopa (scenariusz, przeglądarka, testy E2E) przychodzą z jednego adresu, więc 5 logowań i 10 rejestracji na minutę obejmuje je wszystkie razem. Po `hint: rate limit of the shop entrance reached` odczekaj 60 s. Limit logowań liczą dwa miejsca: Gateway w Redisie (`redis-gateway`) i Auth w pamięci procesu. W środowisku testowym zeruje się oba — `FLUSHALL` w Redis Gateway i restart Auth (nowy pod = pusty licznik):
```bash
kubectl --context rancher-desktop -n shop exec deploy/redis-gateway -- sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli FLUSHALL'
kubectl --context rancher-desktop -n shop rollout restart deploy/auth-service && kubectl --context rancher-desktop -n shop rollout status deploy/auth-service
```
Samo `FLUSHALL` nie wystarczy: po nim Auth dalej odpowiada 429 do końca swojego okna 60 s.

Czego oczekiwać:
- **Pełny klaster** (`up.sh all`): wynik jak w compose — 0 nieudanych sprawdzeń, 0 pominięć.
- **Tylko część warstw** (np. `up.sh platform`): `RESULT: FAILED`, kod 1 — sprawdzenia usług, których nie ma w klastrze, nie przechodzą (Gateway odpowiada 503 `SERVICE_UNAVAILABLE`, Consul nie ma Order i Shipping — S03). Braku usługi scenariusz nie ukrywa.

## Wynik

Na wyjściu jest raport newman (żądania i sprawdzenia `✓`/`✗`), a na końcu:

```
RESULT: PASSED — assertions 305, failed 0, skipped checks 0, strict; report: postman/reports/20261114T184048Z-compose-shop-purchase.json
```

- `SKIPPED: <element> — <powód> (<sprawdzenia>)` — po jednej linii na każde pominięcie; od etapu 8 kolekcja niczego nie pomija (sekcja „Pominięcia i `--strict`”).
- `hint: rate limit of the shop entrance reached, wait 60 s and run again` — gdy logowanie albo rejestracja dostały 429 `TOO_MANY_REQUESTS`.
- `RESULT: PASSED|FAILED — …` — ostatnia linia każdego przebiegu z kodem 0 albo 1; z `--strict` dopisane `, strict`.

| Kod wyjścia | Znaczenie |
|---|---|
| `0` | wszystkie sprawdzenia zaliczone, żadne żądanie nie zakończyło się błędem połączenia (z `--strict` także 0 pominięć) |
| `1` | co najmniej jedno sprawdzenie nie przeszło, błąd żądania albo błąd skryptu kolekcji; z `--strict` także pominięcie |
| `2` | błąd przygotowania: zły argument, brak `deploy/.env` albo `ADMIN_PASSWORD`, nieobsługiwana składnia wartości w `deploy/.env`, brak Dockera, w `k8s` brak `kubectl`, kontekstu `rancher-desktop`, `mkcert` albo certyfikatu urzędu mkcert, zajęty port `18025`/`18500` albo nieudany `port-forward`, kontener nie wystartował (`docker run failed (<kod>)`), nie działa wejście sklepu, błąd newman, plik raportu o tej samej nazwie już istnieje (drugi przebieg w tej samej sekundzie); raport nie powstaje |
| `130` albo `143` | przebieg przerwany (Ctrl+C albo `kill`): skrypt przekazuje sygnał kontenerowi (komunikat `interrupted (SIGTERM), no report written` albo `(SIGINT)`), zamyka `port-forward` i kończy się kodem 130 (Ctrl+C) albo 143 (TERM); raport ani linia `RESULT:` nie powstają |

### Raport JSON

Raport leży w `postman/reports/<yyyymmddThhmmssZ>-<środowisko>-shop-purchase.json` (katalog jest w `.gitignore`). Najnowszy: `ls -t postman/reports/*-shop-purchase.json | head -1`.

| Pole | Treść |
|---|---|
| `collection`, `environment` | `shop-purchase`, `compose` albo `k8s` |
| `runId` | identyfikator przebiegu `<yyyymmddhhmmss UTC>-<4 cyfry hex>` |
| `customerEmail` | konto klienta założone w tym przebiegu: `scenario-<runId>@sklep.local` (rejestracja jako `Scenario-<runId>@sklep.local`, Auth zapisuje adres małymi literami) |
| `startedAt`, `durationMs` | początek (UTC) i czas trwania |
| `strict`, `result` | czy było `--strict`; `PASSED` albo `FAILED` |
| `requests`, `assertions` | `{total, failed}` — liczby żądań i sprawdzeń z newman |
| `skipped` | `[{item, reason, checks}]` — pominięcia |
| `failures` | `[{item, assertion, message}]` — nieudane sprawdzenia (`assertion` = `null` przy błędzie żądania albo skryptu) |
| `items` | `[{item, target, method, path, status, timeMs, assertions: [{name, passed}]}]` — jedno żądanie na wpis; `target` = `shop`, `mailpit` albo `consul`; `path` bez adresu i bez parametrów zapytania; `status` = `null`, gdy nie było odpowiedzi |

W raporcie nie ma treści żądań i odpowiedzi, nagłówków, ciasteczek ani zmiennych środowiska — tylko pola z tabeli. Sprawdzenia porównują tokeny i hasła wyłącznie po kształcie (np. trzy części JWT), więc komunikaty błędów ich nie zawierają; `runner/run.ts` dodatkowo zamienia hasło admina i tekst w formacie JWT na `<redacted>`. Surowy wynik newman nie jest zapisywany.

Przykładowe odczyty:

```bash
R=$(ls -t postman/reports/*-shop-purchase.json | head -1)
jq -c '{result, assertions, requests}' "$R"
jq -r '.failures[] | "\(.item): \(.assertion) — \(.message)"' "$R"
jq -r '.skipped[] | "\(.checks | join(",")) \(.reason)"' "$R"
```

## Pominięcia i `--strict`

Od etapu 8 wszystkie usługi sklepu działają, więc kolekcja **niczego nie pomija**: folder `00 setup` sprawdza tylko, czy Inventory i Review przyjmują identyfikatory UUID (S01, S02) i czy Order i Shipping są w Consulu ze zdrowym sprawdzeniem (S03). Gdy któraś sonda nie przechodzi, zależne sprawdzenia wykonują się dalej i też nie przechodzą — awaria nie wygląda jak pominięcie. Test `runner/collection.test.ts` pilnuje, że w kolekcji nie ma żadnego powodu pominięcia (nowy powód to decyzja Michała).

Mechanizm pominięć w runnerze zostaje (zmienna środowiska `skipped`, linie `SKIPPED`, pole `skipped` raportu). `--strict` zamienia każde pominięcie w błąd (kod 1, `RESULT: FAILED — … skipped checks <k>, strict`); przy obecnej kolekcji wynik z `--strict` i bez niego jest ten sam.

## Co sprawdza kolekcja

Każde sprawdzenie ma w nazwie identyfikator `[S<nn>]`; pełna lista to 49 identyfikatorów (pilnuje jej `runner/collection.test.ts`).

| Folder | Sprawdzenia |
|---|---|
| `00 setup` | S01 Inventory przyjmuje `productId` jako UUID (200 albo 404), S02 Review przyjmuje UUID (200), S03 Order i Shipping mają w Consulu co najmniej jedną instancję `passing` |
| `01 preparation` | S10 logowanie admina (rola `ADMIN` w tokenie), S11 stany 24 produktów startowych (`Algorytmy` 5, `Bazy danych` 0, pozostałe 25 sztuk dostępnych — przy każdym przebiegu; najpierw odczyt `reserved`, potem `quantity` = cel + `reserved`, więc rezerwacja pozostawiona przez przerwany przebieg nie psuje stanu ani nie kończy się 409), S12 stan `Algorytmy` bez tokenu |
| `02 registration` | S20 rejestracja klienta (adres z wielką literą, w odpowiedzi małymi), S21 ten sam e-mail → 409 `EMAIL_TAKEN`, S22 hasło 5 znaków → 400, S23 jeden e-mail „Witamy w sklepie” w Mailpit (odpytywanie co 1 s, najwyżej 30 s) |
| `03 login` | S30 logowanie klienta (JWT: `sub`, `roles`, `iss`, `aud`; ciasteczko `refresh_token` z `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/api/v1/auth`), S31 własny profil |
| `04 catalog` | S40 lista (24 produkty startowe, ceny tekstem, PLN), S41 wyszukiwanie, S42 kategoria, S43 sortowanie po cenie (wszystkie produkty, najwyżej 100), S44 strony (strona 2 po 5 = pozycje 6–10 z S40), S45 walidacja `page`/`size`, S46 kategorie, S47 strona produktu (S47a dostępność, S47r ocena), S48 nieznany produkt i zły identyfikator |
| `05 admin access` | S50 zmiana stanu jako klient → 403, bez tokenu → 401; S51 dodanie produktu jako klient (także z nagłówkiem `X-User-Roles: ADMIN`) → 403 |
| `06 cart` | S60 pusty koszyk, S61 dodanie (kwoty w groszach, `inventoryChecked: true`), S62 zmiana ilości, S63 więcej niż stan → 409, S64 produkt bez stanu → 409, S65 ilość 1000 i 0 → 400, S66 nieznany produkt → 404, S67 usuwanie (dwa razy 204) |
| `07 access denials` | S70 endpointy wewnętrzne z zewnątrz → 404 (`POST /users`, `DELETE /cart/{userId}`, `POST /inventory/reservations`, `GET /orders/purchased?userId=&productId=` z tokenem klienta, `POST /shipments/cancel` z tokenem klienta i admina), S71 podrobione `X-User-Id`/`X-User-Roles` są zastępowane przez Gateway, S72 brak tokenu i zły token → 401, S73 `GET /users/{id}` jako klient (własny i cudzy identyfikator) → 403 `FORBIDDEN` |
| `08 order` | S80 zakup kartą przyjętą: 201 `PAID`, kwoty, ten sam `Idempotency-Key` → to samo zamówienie, pusty koszyk, `reserved` +2; S81 przesyłka `PREPARING` najpóźniej 10 s po zakupie (odpytywanie co 0,5 s); S82 e-mail „Potwierdzenie zamówienia”; S83 karta kończąca się na `0` → 201 `PAYMENT_FAILED`, rezerwacja zwolniona, koszyk bez zmian; S84 ADMIN `SHIPPED` → zamówienie `SHIPPED`, `quantity` −2, e-mail „Twoja paczka jest w drodze”; S85 anulowanie po wysyłce → 409 `ORDER_NOT_CANCELLABLE`; S86 `IN_TRANSIT`, `DELIVERED` → zamówienie `DELIVERED`, e-mail „Paczka dostarczona”; S87 anulowanie przed wysyłką → 200 `CANCELLED`, przesyłka `CANCELLED`, rezerwacja zwolniona, e-mail „Zamówienie anulowane”; S88 opinia po zakupie → 201, bez zakupu → 403; S89 wycofany produkt w koszyku → 409 `PRODUCT_UNAVAILABLE` |
| cała kolekcja | S90 każda odpowiedź błędu API w formacie `{status, error, message, requestId}`, S91 każda odpowiedź API ma `X-Request-Id` |

Przebieg zakłada najwyżej 2 logowania (bez testu złego hasła — sprawdzają go kolekcje Auth i Gateway). Każdy przebieg zakłada nowe konto klienta i jeden produkt `Scenario <runId>`, który od razu wycofuje (S89; produkt zostaje w bazie Product jako usunięty, ze stanem 1 w Inventory). Każde `POST /orders` ma nowy `Idempotency-Key`. Każde zamówienie przebiegu kończy się doręczeniem albo anulowaniem, więc przebieg nie zostawia rezerwacji. Zamówienia kupują produkty startowe `…0001` (2 sztuki) i `…0002` (1 sztuka); stany wraca S11 następnego przebiegu.

## Test Twojej poprawki

Scenariusz jest testem odbiorczym poprawek usług: po zmianie w swojej usłudze sprawdzasz nim, czy sklep działa w całości. Na swojej gałęzi, z katalogu głównego repozytorium, przy działającym stosie `full-shop`:

1. Przebuduj i uruchom ponownie tylko swoją usługę (inne kontenery zostają bez zmian):
   ```bash
   docker compose -p sklep -f deploy/compose.yaml --profile full-shop up -d --build --no-deps --wait <usługa>
   ```
   np. `inventory-service`. Obraz powstaje z plików bieżącej gałęzi. User i Product mają osobny kontener migracji bazy — podaj go w tym samym poleceniu przed usługą, inaczej nowa migracja z Twojej gałęzi się nie wykona:
   ```bash
   docker compose -p sklep -f deploy/compose.yaml --profile full-shop up -d --build --no-deps --wait user-migrate user-service
   docker compose -p sklep -f deploy/compose.yaml --profile full-shop up -d --build --no-deps --wait product-migrate product-service
   ```
   Kontener migracji kończy pracę (`Exited (0)` w `docker compose … ps -a`) — to poprawne.
2. Uruchom scenariusz: `bash postman/run.sh compose`.
3. Znajdź w wyniku sprawdzenia swojej usługi (tabela niżej): w wyjściu newman (`✓`/`✗` przy nazwie z `[S<nn>]`), w liniach `SKIPPED` i w raporcie JSON (sekcja „Raport JSON”, odczyty `failures` i `skipped`).
4. Poprawka przeszła, gdy raport nie ma żadnych `failures` (`RESULT: PASSED`); kolekcja niczego nie pomija, więc `--strict` daje ten sam wynik.
5. Kolekcję, powody pominięć i pozostałe pliki w `postman/` zmienia tylko Michał. Jeśli uważasz, że kolekcja oczekuje złej odpowiedzi, napisz do niego zamiast zmieniać ją w swoim PR.

| Usługa | Sprawdzenia |
|---|---|
| Auth | S10, S20, S21, S22, S30 |
| User | S31 |
| Notification | S23, S82, S84, S86, S87 |
| Product | S40–S48, S89 |
| Inventory | S01, S11, S12, S47a, S63, S64, S80, S83, S84, S87 |
| Review | S02, S47r, S88 |
| Cart | S60–S67, S71 |
| API Gateway | S50, S51, S70–S73, S90, S91 |
| Order | S03, S70, S80–S89 |
| Shipping | S03, S70, S81, S84, S86, S87 |

S90 (format błędu) i S91 (`X-Request-Id`) dotyczą odpowiedzi każdej usługi: nazwa elementu w `failures` wskazuje, która usługa odpowiedziała.

Po teście przełącz się z powrotem na `develop` i powtórz polecenie z punktu 1, żeby w stosie znów była wersja z `develop`.

## Aplikacja Postman

1. Import → pliki `postman/collections/shop-purchase.postman_collection.json` i `postman/environments/compose.postman_environment.json`.
2. W środowisku `compose` wpisz `adminPassword` (zmienna typu `secret`, w pliku pusta) — wartość `ADMIN_PASSWORD` z `deploy/.env` — tylko w kolumnie bieżącej wartości (Current value), nigdy w wartości początkowej (Initial value). Nie zapisuj jej w pliku środowiska w repozytorium.
3. Wybierz środowisko `compose` i uruchom kolekcję w Collection Runner (całą, w kolejności folderów).

Zmienne środowiska: `baseUrl` (`http://127.0.0.1:8090/api/v1`), `mailpitUrl` (`http://127.0.0.1:8025`), `consulUrl` (`http://127.0.0.1:8500`), `adminEmail`, `adminPassword`. Środowisko `k8s` jest przygotowane dla kontenera (`host.docker.internal`); w aplikacji Postman na laptopie uruchom oba `port-forward` z sekcji „Środowisko `k8s`” ręcznie i w bieżących wartościach wpisz `mailpitUrl` = `http://127.0.0.1:18025`, `consulUrl` = `http://127.0.0.1:18500`. W aplikacji kolekcja sama tworzy nowy e-mail klienta przy każdym uruchomieniu; pominięcia zapisuje w zmiennej środowiska `skipped`. Po uruchomieniu w aplikacji tokeny i hasło klienta testowego zostają w bieżących wartościach zmiennych kolekcji — nie eksportuj ani nie udostępniaj kolekcji i środowiska z bieżącymi wartościami.

Hasło admina w aplikacji Postman:
- wartość początkowa (Initial value) trafia do eksportu i do danych konta Postman, bieżąca (Current value) zostaje na komputerze — dlatego hasło tylko w bieżącej wartości;
- nie zapisuj odpowiedzi (Save response, zapis odpowiedzi w Collection Runner) — odpowiedzi logowania zawierają tokeny;
- treść żądania logowania admina (z hasłem) widać w Postman Console — po pracy wyczyść Console (Clear);
- nie eksportuj środowiska `compose` po wpisaniu hasła i nie udostępniaj go.

Kolekcja pokazu odporności (`shop-resilience`) w aplikacji: folder `product down` rejestruje klienta adresem zapamiętanym w zmiennej kolekcji, więc drugie uruchomienie tego folderu w tym samym imporcie kończy się `409` przy rejestracji. W aplikacji uruchamiaj go raz (albo wyczyść bieżącą wartość `customerEmail` w zmiennych kolekcji); `resilience-demo.sh` tego problemu nie ma — adres podaje `run.ts` przy każdym przebiegu.

## Pliki

```
postman/
  run.sh                 uruchomienie scenariusza (kontener)
  lb-demo.sh             pokaz load balancingu (Product ×3, 9 żądań)
  resilience-demo.sh     pokaz odporności (zatrzymany Review i Product, kolekcja shop-resilience)
  Dockerfile, .dockerignore, package.json, package-lock.json
                         obraz shop-scenario:dev: Node 22 i newman 6.2.3 (bez zależności deweloperskich),
                         użytkownik node (UID 1000); "type": "module" — runner to moduły ES
  tsconfig.json          sprawdzanie typów runnera (tsc --noEmit, strict); typescript, @types/node i @types/newman
                         są tylko w devDependencies
  runner/run.ts          newman przez API: dane admina ze stdin, sprawdzenie wejścia, linie SKIPPED/RESULT, raport
  runner/report.ts       budowa i zapis raportu (tylko pola z tabeli, bez nadpisywania pliku), kod wyjścia
  runner/report.test.ts  testy jednostkowe raportu
  runner/collection.test.ts
                         testy kolekcji shop-purchase: żadnego pominięcia, dokładnie 49 identyfikatorów [S<nn>]
  collections/           kolekcje Postman (v2.1)
  environments/          środowiska compose i k8s
  reports/               raporty JSON (poza gitem)
```

Runner jest w TypeScript i Node 22 uruchamia go wprost (usuwa same typy, bez kompilacji) — dlatego kod używa tylko składni, którą da się usunąć (`erasableSyntaxOnly`), a importy mają rozszerzenie `.ts`.

Testy jednostkowe raportu i kolekcji (w obrazie, bez stosu; testy kolekcji czytają `collections/`):

```bash
docker build -q -t shop-scenario:dev postman
docker run --rm -v "$PWD/postman/runner:/opt/scenario/work/runner:ro" \
  -v "$PWD/postman/collections:/opt/scenario/work/collections:ro" --entrypoint sh shop-scenario:dev \
  -c 'node --test /opt/scenario/work/runner/*.test.ts'
```

Sprawdzenie typów (obraz nie ma zależności deweloperskich, więc w czystym kontenerze z `npm ci`; `node_modules` nie trafia do repozytorium):

```bash
docker run --rm -v "$PWD/postman:/src:ro" node:22.23-alpine sh -c \
  'mkdir /w && cd /src && tar --exclude=node_modules --exclude=reports -cf - . | tar -xf - -C /w \
   && cd /w && npm ci --no-audit --no-fund && npx tsc --noEmit -p . && node --test runner/*.test.ts'
```

## Pokazy

Dwa skrypty do prezentacji load balancingu i odporności. Działają na uruchomionym stosie compose z profilem `full-shop` (`docker compose -p sklep -f deploy/compose.yaml --profile full-shop up -d --wait`, patrz `deploy/README.md`). Można je uruchamiać z dowolnego katalogu. Potrzebne są tylko `bash`, `curl` i `docker` (bez `jq`). Hasło admina nie jest używane.

Na początku każdy skrypt sprawdza wejście sklepu: `GET http://127.0.0.1:8090/api/v1/cart` bez tokenu musi zwrócić odpowiedź z nagłówkiem `X-Gateway-Instance-Id`. Jeśli wejście nie działa (zatrzymany frontend albo Gateway), skrypt wypisuje `shop entrance http://127.0.0.1:8090/api/v1 is not reachable (no answer from the API Gateway)`, kończy się kodem 2 i niczego nie zmienia w stosie.

Oba skrypty zostawiają stos w stanie sprzed pokazu: zatrzymują tylko usługi, które działały, i przywracają je z tą samą liczbą kopii (np. Product w 2 kopiach wraca jako 2 kopie, a Review zatrzymany przed pokazem zostaje zatrzymany). Usługi uruchamiają bez zależności (`up -d --no-deps --no-recreate --wait`), więc nie startują ponownie kontenery jednorazowe (`consul-kv-seed`, `product-migrate`).

Przerwanie: po Ctrl+C (INT) albo `kill` (TERM) skrypt wypisuje `interrupted, restoring replicas` (`lb-demo.sh`) albo `interrupted, restoring services` (`resilience-demo.sh`), przywraca stan i kończy się kodem 130 (Ctrl+C) albo 143 (TERM), bez linii `RESULT:`. Samego przywracania nie da się przerwać: kolejne Ctrl+C w tym czasie skrypt tylko odnotowuje, a `docker compose` działa do końca (najwyżej 2 min na usługę). Jeśli przywracanie się nie uda, skrypt wypisuje `could not restore …, run: <polecenie>` (`lb-demo.sh`) albo `could not start …, run: <polecenie>` (`resilience-demo.sh`) i kończy się kodem 1.

### Load balancing — `lb-demo.sh`

```bash
bash postman/lb-demo.sh        # 3 kopie Product
bash postman/lb-demo.sh 2      # liczba kopii 2–5
```

Skrypt skaluje `product-service` do podanej liczby kopii (`--scale` z `--no-deps`, inne usługi nie są ruszane), czeka, aż Consul pokaże wszystkie kopie jako `passing`, potem 11 s (Gateway odświeża listę instancji co 10 s). Następnie wysyła 9 żądań `GET /api/v1/products/{id}` przez wejście sklepu i pokazuje, która kopia Product (`X-Instance-Id`) i która instancja Gateway (`X-Gateway-Instance-Id`) obsłużyła każde z nich. Na końcu przywraca poprzednią liczbę kopii. Czas: ok. 20–30 s.

Przykładowe wyjście (skrócone):

```
scaling product-service from 1 to 3 replica(s)
waiting for 3 passing instances in Consul
waiting 11 s for the API Gateway instance cache
request  status X-Instance-Id                            X-Gateway-Instance-Id
1        200    product-service-0b9ba193567a             api-gateway-a8c00ef214aa
2        200    product-service-11039e9574d8             api-gateway-a8c00ef214aa
3        200    product-service-1a715d35478d             api-gateway-a8c00ef214aa
…
9        200    product-service-1a715d35478d             api-gateway-a8c00ef214aa
summary: 3 instances: product-service-0b9ba193567a=3 product-service-11039e9574d8=3 product-service-1a715d35478d=3
restoring 1 product-service replica(s)
RESULT: PASSED
```

`RESULT: PASSED` (kod 0) oznacza, że wszystkie 9 żądań dostało 200 i odpowiedziały wszystkie kopie: przy 3 kopiach każda co najmniej 2 razy, przy innej liczbie każda co najmniej raz. Liczą się tylko odpowiedzi 200; inny status w którymkolwiek żądaniu daje linię `requests without status 200: <liczba>` i `RESULT: FAILED` (kod 1). Kod 2: zły argument (`usage: …`) albo Product nie działa przed pokazem (`product-service is not running, start the stack first` — skrypt niczego nie zmienia, najpierw uruchom stos).

### Odporność — `resilience-demo.sh`

```bash
bash postman/resilience-demo.sh
```

Skrypt buduje obraz `shop-scenario:dev` (jak `run.sh`) i uruchamia kolekcję `collections/shop-resilience.postman_collection.json` folderami, a między folderami zatrzymuje i uruchamia usługi:

| Krok | Co robi skrypt | Co sprawdza kolekcja |
|---|---|---|
| `STEP 1/3` | zatrzymuje `review-service` | `[R1]` strona produktu: 200, `rating` = `null`, odpowiedź w ≤ 3000 ms; potem Review wraca (`healthy`) |
| `STEP 2/3` | zatrzymuje `product-service` | rejestracja i logowanie nowego klienta, `[R2]` `POST /cart/items` → 503 `SERVICE_UNAVAILABLE` w formacie błędu, w ≤ 5000 ms; potem Product startuje |
| `STEP 3/3` | — | `[R3]` strona produktu znów odpowiada 200 w ≤ 30 s (odpytywanie co 1 s) |

Usługa, która nie działała przed pokazem, nie jest zatrzymywana ani uruchamiana (skrypt wypisuje `<usługa> is not running, it stays stopped`). Krok, który jej potrzebuje, może wtedy dać inny wynik — np. bez działającego Product `[R3]` nie przejdzie. Product startuje między krokami 2 i 3 bez czekania na `healthy`, więc `[R3]` mierzy cały powrót (start usługi i odświeżenie listy instancji w Gateway); na `healthy` skrypt czeka po kroku 3.

Po każdym folderze `run.ts` wypisuje swoją linię `RESULT: … report: postman/reports/…-compose-shop-resilience.json`. Ostatnia linia wyjścia to wynik całego pokazu: `RESULT: PASSED — steps 3/3` (kod 0) albo `RESULT: FAILED — steps <n>/3` (kod 1). Kod 2: brak `docker`/`curl`, błąd budowy obrazu albo niedziałające wejście sklepu. Czas: ok. 15–30 s.

Przykładowe wyjście (skrócone):

```
STEP 1/3: review-service stopped - the product page is served without a rating
stopping review-service
…
  ✓  [R1] product page answers 200
  ✓  [R1] rating is null (review-service unavailable)
  ✓  [R1] answered within 3000 ms
RESULT: PASSED — assertions 3, failed 0, skipped checks 0; report: postman/reports/…-compose-shop-resilience.json
starting review-service and waiting until it is healthy
STEP 2/3: product-service stopped - adding to the cart answers 503
…
  ✓  [R2] cart answers 503
  ✓  [R2] error SERVICE_UNAVAILABLE in the shared error format
  ✓  [R2] answered within 5000 ms
…
starting product-service
STEP 3/3: product-service started - the product page answers again
…
  ✓  [R3] product page answers 200 again
  ✓  [R3] product-service back within 30 s
…
starting product-service and waiting until it is healthy
RESULT: PASSED — steps 3/3
```

Pokaz rejestruje jednego klienta i loguje się raz (limit logowania wejścia: 5 na minutę z jednego adresu). Przy `429` w kroku 2 trzeba odczekać minutę i uruchomić pokaz ponownie.

### Gdy pokaz został przerwany twardo

Po `kill -9` albo zamknięciu terminalu skrypt nie zdąży przywrócić stanu (zwykłe Ctrl+C i `kill` przywracają, patrz wyżej). Wtedy (liczbę kopii Product i zestaw zatrzymanych usług dopasuj do stanu sprzed pokazu):

```bash
# jedna kopia Product (po lb-demo.sh)
docker compose -p sklep -f deploy/compose.yaml --profile full-shop up -d --no-deps --no-recreate --scale product-service=1 --wait product-service
# zatrzymane Review albo Product (po resilience-demo.sh)
docker compose -p sklep -f deploy/compose.yaml --profile full-shop up -d --no-deps --no-recreate --wait review-service product-service
# sprawdzenie: wszystkie kontenery healthy, w Consulu jedna kopia Product
docker compose -p sklep -f deploy/compose.yaml --profile full-shop ps --format '{{.Service}} {{.Health}}'
curl -s 'http://127.0.0.1:8500/v1/health/service/product-service?passing=true' | grep -o '"ServiceID":"product-service-' | wc -l
```

## Problemy

| Objaw | Przyczyna i rozwiązanie |
|---|---|
| `hint: rate limit of the shop entrance reached, wait 60 s and run again`, sprawdzenia logowania z 429 | limit 5 logowań / 10 rejestracji na minutę z jednego adresu (wspólny z przeglądarką) — odczekaj 60 s i uruchom ponownie |
| `shop entrance http://127.0.0.1:8090/api/v1 is not reachable (no answer from the API Gateway)`, kod 2 | nie działa frontend (nginx) albo API Gateway — uruchom stos: `docker compose -f deploy/compose.yaml --profile full-shop up -d --wait` |
| `shop entrance https://shop.localhost/api/v1 is not reachable …`, kod 2 | nie działa Ingress albo API Gateway w klastrze (`kubectl --context rancher-desktop -n shop get pods`) albo certyfikat `shop-tls` nie pochodzi z urzędu mkcert na tym laptopie — `bash deploy/k8s/up.sh platform` (deploy/k8s/README.md) |
| `kubectl context rancher-desktop not found …`, `mkcert not found …`, `mkcert CA certificate … not found …`, kod 2 | brak klastra albo mkcert — wymagania w sekcji „Środowisko `k8s`” |
| `port 18025 on 127.0.0.1 is already in use …` (albo `18500`), kod 2 | port zajmuje inny proces, np. `port-forward` uruchomiony ręcznie — `pgrep -fl port-forward`, zakończ go i uruchom ponownie |
| `port-forward of svc/<usługa> to 127.0.0.1:<port> failed: …`, kod 2 | w przestrzeni `shop` nie działa Mailpit albo Consul — `bash deploy/k8s/up.sh infra` |
| `env file …/deploy/.env not found, run deploy/create-secrets.sh`, kod 2 | brak haseł — `bash deploy/create-secrets.sh` |
| `unsupported .env syntax for ADMIN_PASSWORD …`, kod 2 | w `deploy/.env` po wartości jest komentarz albo inny tekst, albo brak zamykającego cudzysłowu — zostaw w linii samo `ADMIN_PASSWORD=<wartość>` (cudzysłowy wokół wartości i końce linii CRLF są obsługiwane) |
| `docker run failed (<kod>)`, kod 2 | kontener scenariusza nie wystartował (kod 125–127: np. błąd demona Dockera albo montowania katalogu) — sprawdź `docker info` i uruchom ponownie |
| `report postman/reports/… already exists (another run in the same second), run again`, kod 2 | dwa przebiegi uruchomione w tej samej sekundzie; raport drugiego nie powstał — uruchom go ponownie |
| `RESULT: FAILED` przy działającym stosie | `jq -r '.failures[]' "$(ls -t postman/reports/*-shop-purchase.json \| head -1)"` pokazuje element, sprawdzenie i komunikat; usługa zatrzymana albo niezdrowa → `docker compose -f deploy/compose.yaml --profile full-shop ps` |
