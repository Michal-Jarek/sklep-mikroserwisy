# Frontend

Sklep w przeglądarce: aplikacja React (Vite, TypeScript, React Router, TanStack Query, Tailwind CSS i shadcn/ui). Rozmawia tylko z API Gateway pod `/api/v1/…` – ten sam adres co aplikacja, więc bez CORS. Logowanie, rejestracja, odświeżanie sesji i wylogowanie działają na prawdziwym Auth przez Gateway. Usługi, których jeszcze nie ma w Docker Compose, w trybie deweloperskim zastępują atrapy MSW zgodne z kontraktem [`docs/frontend-api.md`](../docs/frontend-api.md).

## Wymagania

- Node.js 22 (wersja w `.nvmrc`), np. przez `nvm`: w folderze `frontend` polecenie `nvm use`.
- Docker z Docker Compose – do pracy z prawdziwym Gateway i Auth oraz do testów E2E. Tryb atrap działa bez Dockera.

Polecenia `npm …` uruchamia się w folderze `frontend/`, polecenia `docker …` – w katalogu głównym repozytorium (z `frontend/`: `cd ..`). Bloki poniżej zaczynają się w katalogu głównym.

## Instalacja

```bash
cd frontend
nvm use
npm ci
```

Komunikat o podatnościach (`npm audit`) po `npm ci` nie przerywa instalacji – dotyczy narzędzi deweloperskich. Nie uruchamiaj `npm audit fix` (zmienia `package-lock.json`).

## Uruchomienie z Gateway i Auth z Docker Compose

1. Z katalogu głównego repozytorium uruchom platformę (Gateway, Auth, frontend w obrazie). Przy pierwszym uruchomieniu najpierw `bash deploy/create-secrets.sh` ([deploy/README.md](../deploy/README.md), „Pierwsze uruchomienie”); po `git pull` dodaj `--build`, żeby przebudować obrazy:

   ```bash
   docker compose -f deploy/compose.yaml --profile platform up -d --wait
   ```

   Gotowy obraz sklepu jest wtedy pod adresem `http://127.0.0.1:8090` (szczegóły: sekcja „Obraz i compose”).
2. Serwer deweloperski z przeładowaniem po zmianie kodu (z katalogu głównego):

   ```bash
   cd frontend
   npm run dev
   ```

   Aplikacja: `http://127.0.0.1:5173`. Serwer Vite przekazuje `/api` do `API_PROXY_TARGET` (domyślnie Gateway `http://127.0.0.1:8080`).

Konto klienta zakłada się przez „Zarejestruj”. Usługi, których nie ma w compose (Product, Cart, User, Order…), odpowiadają przez Gateway `503` – strony pokazują wtedy „Usługa jest chwilowo niedostępna. Spróbuj ponownie za chwilę.”. Wybrane zasoby można zastąpić atrapami, a resztę zostawić Gateway (zmienna `VITE_API_MOCKS`, sekcja „Zmienne”).

## Tryb atrap (bez Dockera)

Z katalogu głównego repozytorium:

```bash
cd frontend
npm run dev:mocks
```

Aplikacja: `http://127.0.0.1:5173`, wszystkie usługi łącznie z Auth to atrapy (`VITE_API_MOCKS=all`). Logowanie np. kontem `klient@sklep.test` z hasłem `Klient-atrapa-1` (hasła działają tylko w atrapach; wszystkie konta i dane startowe: sekcja „Atrapy”).

## Skrypty

| Polecenie | Co robi |
|---|---|
| `npm run dev` | serwer Vite na `127.0.0.1:5173`, `/api` → `API_PROXY_TARGET` |
| `npm run dev:mocks` | to samo z atrapami wszystkich usług (`vite --mode mocks`, działa też na Windows) |
| `npm run build` | sprawdzenie typów i build produkcyjny do `dist/` (bez atrap i bez map źródeł) |
| `npm run preview` | podgląd `dist/` na `127.0.0.1:4173` z tym samym proxy `/api` |
| `npm run typecheck` | `tsc -b` (aplikacja, testy, konfiguracja i E2E) |
| `npm run lint` | ESLint |
| `npm test` | testy Vitest (jsdom) |
| `npm run test:e2e` | testy Playwright (sekcja „Testy E2E”) |

## Testy

W folderze `frontend/`:

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

Testy Vitest leżą obok kodu (`*.test.ts`, `*.test.tsx`), strefa czasowa testów to `Europe/Warsaw`. Klient API i sesja mają testy na podstawionym `fetch`; strony – na atrapach MSW w Node (`setupMockServer()` z `src/mocks/node.ts`, wywołane w pliku testu). `src/test/setup.ts` dodaje to, czego nie ma jsdom: `navigator.locks`, `matchMedia`, `ResizeObserver`. Komunikat `[PLUGIN_TIMINGS]` na końcu buildu to informacja Vite o czasie, nie błąd.

## Testy E2E (Playwright)

Dwa projekty w `playwright.config.ts`:

| Projekt | Testy | Przeciw czemu |
|---|---|---|
| `mocked` | `e2e/mocked/` | serwer Vite w trybie atrap, który Playwright uruchamia sam (`127.0.0.1:5174`) |
| `compose` | `e2e/compose/` | obraz `frontend` z prawdziwym Gateway i Auth (`E2E_BASE_URL`, domyślnie adres sklepu z compose); serwer Vite nie startuje |

Testy uruchamia się w kontenerze z obrazem Playwright (przeglądarki są w obrazie, `node_modules` z macOS nie działają w Linuksie, więc kontener robi własne `npm ci`). Z katalogu głównego repozytorium:

```bash
# projekt mocked (bez Docker Compose)
docker run --rm --ipc=host -v "$PWD/frontend:/src:ro" -v "$PWD/frontend/test-results:/out" \
  mcr.microsoft.com/playwright:v1.64.1-noble \
  bash -c 'mkdir /work && cd /src && tar --exclude=node_modules --exclude=dist -cf - . | tar -xf - -C /work \
    && cd /work && npm ci --no-audit --no-fund && npx playwright test --project=mocked --output /out/mocked'
```

Projekt `compose` wymaga działającej platformy (poprzednia sekcja). Kontener jest w sieci `sklep_edge` i otwiera sklep pod `http://frontend:8080`:

```bash
for f in frontend/e2e/compose/*.spec.ts; do
  docker compose -f deploy/compose.yaml exec -T redis-gateway sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli FLUSHALL'
  docker compose -f deploy/compose.yaml --profile platform restart auth-service; sleep 8
  docker run --rm --ipc=host --network sklep_edge -e E2E_BASE_URL=http://frontend:8080 \
    -v "$PWD/frontend:/src:ro" -v "$PWD/frontend/test-results:/out" mcr.microsoft.com/playwright:v1.64.1-noble \
    bash -c "mkdir /work && cd /src && tar --exclude=node_modules --exclude=dist -cf - . | tar -xf - -C /work \
      && cd /work && npm ci --no-audit --no-fund && npx playwright test e2e/compose/$(basename $f) --project=compose --output /out/compose-$(basename $f .spec.ts)"
done
```

- Plik testu podaje się **przed** `--project=…` (`--project` przyjmuje kilka wartości i zabrałby nazwę pliku).
- Limit logowania to 5 na minutę z jednego adresu IP – w Gateway (Redis) i w Auth (pamięć procesu). Kolejne kontenery często dostają ten sam adres IP, dlatego pętla przed każdym plikiem zeruje liczniki Gateway w Redisie (`FLUSHALL` w `redis-gateway`, hasło rozwija powłoka kontenera) i restartuje Auth (zeruje jego licznik). Każdy plik loguje się najwyżej 4 razy; wyjątek to `auth-errors.spec.ts`, który celowo przekracza limit (6 logowań).
- `http://frontend:8080` nie jest bezpiecznym kontekstem przeglądarki (jest nim tylko `https` albo `localhost`/`127.0.0.1`), a bez niego Chromium odrzuca ciasteczko `Secure` z Auth i nie daje `navigator.locks` ani `crypto.randomUUID`. Projekt `compose` uruchamia więc pełny Chromium (`channel: 'chromium'`) z flagą `--unsafely-treat-insecure-origin-as-secure=<adres>`; domyślny „headless shell” tej flagi nie obsługuje.
- Każdy test `compose` przerywa się przy naruszeniu Content Security Policy na dowolnej stronie (fikstura w `e2e/compose/helpers.ts`).
- Wyniki: `--output <folder>` (zrzuty i ślady nieudanych testów), raport HTML w `<folder>-report`. W poleceniach powyżej trafiają do `frontend/test-results/` (folder poza gitem), np. `frontend/test-results/mocked-report/index.html`; bez zamontowanego folderu znikają razem z kontenerem.
- Ostrzeżenie `npm warn EBADENGINE` w kontenerze (obraz Playwright ma Node 24, projekt wymaga 22) można pominąć.

## Struktura katalogów

```
src/
  main.tsx          start: konfiguracja zod, atrapy (tylko dev), render
  app/              App, router (wszystkie trasy), providers, layout/ (nagłówek), pages/ (błędy, brak dostępu, 404)
  api/              paths.ts (wszystkie ścieżki API), client.ts (jedyne miejsce z fetch), errors.ts (komunikaty błędów),
                    query-client.ts (ponowienia), types.ts (typy kontraktu), <zasób>.ts (hooki TanStack Query)
  auth/             token.ts (token w pamięci), session.ts (start, odświeżanie, logowanie), AuthProvider.tsx, guards.tsx
  components/       wspólne komponenty (Money, ErrorAlert, Pagination, StatusBadge, FormField…), ui/ (shadcn/ui)
  features/         strony: account/, catalog/, product/, cart/, checkout/, orders/, admin/
  lib/              money.ts (kwoty w groszach), labels.ts (etykiety statusów), utils.ts, zod-setup.ts
  mocks/            atrapy MSW (tylko dev i testy)
  styles/           style komponentów shadcn/ui
  test/             konfiguracja i pomocnicze funkcje testów
e2e/
  compose/          E2E na prawdziwym Gateway i Auth
  mocked/           E2E na atrapach
  support/          pomocnicze funkcje E2E atrap
```

## Sesja

- **Access token tylko w pamięci** modułu `src/auth/token.ts` – nie trafia do `localStorage`, `sessionStorage`, ciasteczek, adresu strony ani logów konsoli. Rola i identyfikator użytkownika są odczytywane z treści tokenu tylko na potrzeby interfejsu; uprawnienia sprawdza Gateway.
- **Refresh token** jest w ciasteczku `refresh_token` (`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/api/v1/auth`), które ustawia Auth. Skrypt strony go nie widzi.
- **Start aplikacji:** jedno `POST /auth/refresh` (także przy podwójnym uruchomieniu efektów w `StrictMode`). `200` – zalogowany, każdy błąd – niezalogowany, bez komunikatu.
- **Odświeżanie:** token, który wygasa za mniej niż 30 s, jest odświeżany przed żądaniem. Odpowiedź `401` na żądanie z tokenem (poza `/auth/*`) → jedno odświeżenie wspólne dla wszystkich równoczesnych żądań → jedno powtórzenie żądania. Gdy odświeżenie dostanie `401`, sesja jest czyszczona, a użytkownik trafia na `/login?returnTo=<bieżąca strona>` z komunikatem „Sesja wygasła. Zaloguj się ponownie.”. `returnTo` przyjmuje tylko ścieżki w sklepie. Błąd odświeżenia inny niż `401` (np. `503`, `429`, brak połączenia) nie blokuje żądania: idzie ono z bieżącym tokenem — trasa publiczna działa (Gateway traktuje wygasły token jak brak tokenu), trasa wymagająca logowania dostaje `401` i jeszcze jedno odświeżenie. Czas wygaśnięcia tokenu jest liczony od chwili jego otrzymania (`exp − iat`), więc źle ustawiony zegar komputera nie wymusza odświeżania.
- **Wylogowanie:** `POST /auth/logout` pod tą samą blokadą. Auth zawsze odpowiada `204`; inna odpowiedź (`429`, `502`, `503`, brak połączenia) pochodzi z Gateway, nginx albo sieci — ciasteczko odświeżania jest wtedy nadal ważne, więc sesja zostaje, a nagłówek pokazuje „Nie udało się wylogować. Spróbuj ponownie za chwilę.”.
- **Blokada między kartami:** Auth wymienia refresh token przy każdym odświeżeniu, a ponowne użycie wymienionego tokenu unieważnia całą sesję (log `Refresh token reuse detected`). Karty jednej przeglądarki dzielą ciasteczko, więc odświeżają się po kolei pod blokadą Web Locks `sklep-auth-refresh` – następna karta wysyła już nowe ciasteczko. Logowanie i wylogowanie w jednej karcie trafia do pozostałych przez `BroadcastChannel('sklep-auth')`.
- Web Locks i ciasteczko `Secure` wymagają bezpiecznego kontekstu: `https` albo `http://localhost`/`http://127.0.0.1`.

## Zmienne

Plik `frontend/.env.local` (poza repozytorium), wzór z opisem: [`.env.example`](.env.example). Żadna wartość nie jest tajna.

| Zmienna | Gdzie działa | Znaczenie |
|---|---|---|
| `VITE_API_MOCKS` | `npm run dev` | puste – bez atrap; `all` – wszystkie zasoby łącznie z Auth (to samo co `npm run dev:mocks`); lista zasobów po przecinku (pierwszy segment ścieżki po `/api/v1`: `users,cart,products,categories,inventory,reviews,orders,shipping,shipments`) – atrapy tylko dla nich, reszta do Gateway. W buildzie produkcyjnym zawsze puste. |
| `API_PROXY_TARGET` | `vite.config.ts` (Node, nie trafia do przeglądarki) | cel proxy `/api` serwera Vite, domyślnie `http://127.0.0.1:8080` |

Innych zmiennych `VITE_*` nie ma – wszystko, co zaczyna się od `VITE_`, trafia do kodu w przeglądarce.

## Atrapy

Usługi, których jeszcze nie ma w Docker Compose (User, Cart, Product, Inventory, Review, Order, Shipping), frontend w trybie deweloperskim zastępuje atrapami [MSW](https://mswjs.io) (`src/mocks/`). Atrapy zachowują się zgodnie z kontraktem [docs/frontend-api.md](../docs/frontend-api.md): te same ścieżki, pola, kody błędów, reguły dostępu Gateway (brak tokenu → 401, brak roli ADMIN → 403) i własność danych. Test `src/api/contract.test.ts` pilnuje, że dokument, lista wywołań klienta (`src/api/paths.ts`) i atrapy mają te same endpointy.

Atrapy działają tylko w serwerze deweloperskim Vite i w testach. Build produkcyjny (`npm run build`, obraz Docker) ich nie zawiera — nie ma w nim MSW ani pliku `mockServiceWorker.js` (adres `/mockServiceWorker.js` zwraca wtedy `index.html`, jak każda nieznana ścieżka). Atrapy działają tylko w przeglądarce (service worker): `curl` na `127.0.0.1:5173/api/…` je omija i trafia przez proxy do Gateway.

### Tryby (`VITE_API_MOCKS`)

| Wartość | Polecenie | Co działa na atrapach |
|---|---|---|
| puste (domyślnie) | `npm run dev` | nic — wszystkie żądania `/api/` idą przez proxy Vite do Gateway (`http://127.0.0.1:8080`) |
| `all` | `npm run dev:mocks` | wszystko, także logowanie (atrapa Auth); Docker nie jest potrzebny. Żądanie `/api/`, którego atrapy nie znają, kończy się błędem sieci i ostrzeżeniem w konsoli |
| lista zasobów, np. `users,cart,products,categories,inventory,reviews,orders,shipping,shipments` | `VITE_API_MOCKS=users,cart,products,categories,inventory,reviews,orders,shipping,shipments npm run dev` | tylko podane zasoby (pierwszy segment ścieżki po `/api/v1`); reszta, np. `auth`, idzie do prawdziwego Gateway |

Tryb listy służy do pracy z prawdziwym logowaniem: Auth i Gateway działają w Docker Compose, a brakujące usługi odpowiadają z atrap. Atrapy czytają tożsamość z tokenu w nagłówku `Authorization` bez sprawdzania podpisu (sprawdzają tylko `iss`, `aud` i `exp`; podpis sprawdza Gateway). Prawdziwe konto, którego atrapy nie znają, dostaje przy pierwszym wywołaniu User profil zastępczy („Klient Testowy”), pusty koszyk i pustą historię zamówień. Konto `admin@sklep.local` nie ma profilu (`/account` pokazuje komunikat dla administratora).

Tryb listy działa tylko dla spójnych zestawów: zasób na atrapie nie może być zależnością prawdziwej usługi. Prawdziwa usługa woła swoje zależności bezpośrednio przez Consul, z pominięciem przeglądarki i atrap. Przykład: prawdziwy Cart woła Product, więc Cart bez atrapy przy Product na atrapie odpowie 503 (a atrapa koszyka odrzuca produkty spoza atrap). Kolejność zastępowania atrap prawdziwymi usługami (etap 6b): Product → Inventory, Cart → Shipping → Order → Review.

### Konta atrap

Tylko dla trybu `all`. Hasła są jawne — działają wyłącznie w atrapach, nie w prawdziwym Auth.

| E-mail | Hasło | Rola | Uwagi |
|---|---|---|---|
| `klient@sklep.test` | `Klient-atrapa-1` | CUSTOMER | profil Jan Kowalski, jeden adres, cztery zamówienia |
| `admin@sklep.test` | `Admin-atrapa-1` | ADMIN | bez profilu (`GET /users/me` → 404) |

Rejestracja w trybie `all` zakłada nowe konto w atrapach (z profilem). Token atrapy wygląda jak token Auth (trzy części base64url, `sub`, `roles`, `iss` `sklep-auth`, `aud` `sklep-api`, ważny 15 minut), ale podpis jest fałszywy. Sesja odświeżania („ciasteczko”) jest w stanie atrap: `POST /auth/refresh` wydaje nowy token, `POST /auth/logout` kończy sesję, a odświeżenie bez sesji daje 401.

### Dane startowe

4 kategorie (Elektronika, Książki, Kuchnia, Ogród), 24 produkty, stany magazynowe, opinie, 3 metody dostawy (Kurier 14,99 zł, Paczkomat 9,99 zł, Odbiór osobisty 0,00 zł). Produkty ze szczególnym zachowaniem:

| Produkt | Identyfikator | Zachowanie |
|---|---|---|
| Kubek ceramiczny | `a0000000-0000-4000-8000-000000000001` | zwykły: 50 sztuk, 12 opinii (ocena 4,1), klient już go ocenił (druga opinia → 409) |
| Czajnik elektryczny | `a0000000-0000-4000-8000-000000000002` | `rating: null` — „Ocena chwilowo niedostępna” |
| Deska do krojenia | `a0000000-0000-4000-8000-000000000003` | bez opinii (`count: 0`) — „Brak opinii” |
| Młynek do kawy | `a0000000-0000-4000-8000-000000000004` | `availability: null` — „Dostępność sprawdzimy przy zamówieniu”; koszyk odpowiada `inventoryChecked: false`, zamówienie → 409 `INSUFFICIENT_STOCK` |
| Patelnia żeliwna | `a0000000-0000-4000-8000-000000000005` | brak w magazynie (`inStock: false`) |
| Termos stalowy | `a0000000-0000-4000-8000-000000000006` | kupiony przez klienta, bez jego opinii — opinia zostanie przyjęta |
| Mikroserwisy w praktyce | `a0000000-0000-4000-8000-000000000007` | tylko 2 sztuki — dodanie 3 do koszyka → 409 |

Zamówienia klienta: dostarczone (Kubek ×2, Termos), wysłane (przesyłka `SHIPPED` — nie do anulowania), opłacone (przesyłka `PREPARING` — do anulowania), z płatnością nieudaną. Koszyk klienta na starcie jest pusty.

Płatność testowa: numer karty kończący się cyfrą `0` → `PAYMENT_FAILED` (koszyk zostaje), inny → `PAID` (koszyk pusty). Przesyłka nowego zamówienia pojawia się po około 3 sekundach (tak jak po zdarzeniu `order.created`); do tego czasu strona zamówienia pokazuje „W przygotowaniu”. Każda odpowiedź atrapy przychodzi z opóźnieniem 100–300 ms.

### Stan atrap i czyszczenie

Stan atrap (konta, koszyki, zamówienia, sesja, zaplanowane błędy) jest w `localStorage` przeglądarki pod kluczem `sklep-mocks-v1`, więc przeżywa przeładowanie strony i jest wspólny dla kart. To jedyne miejsce, w którym frontend używa `localStorage`, i tylko w trybie atrap. Powrót do danych startowych:

- w konsoli przeglądarki: `window.__mocks.reset()`, potem przeładowanie strony, albo
- DevTools → Application → Local Storage → usuń `sklep-mocks-v1`.

### `window.__mocks` (konsola i testy E2E)

Dostępne tylko w trybie atrap:

| Wywołanie | Działanie |
|---|---|
| `window.__mocks.reset()` | dane startowe, bez sesji i zaplanowanych błędów (potem przeładuj stronę) |
| `window.__mocks.failNext(resource, status, { error, retryAfter, times })` | następne `times` (domyślnie 1) żądań do zasobu `resource` (pierwszy segment ścieżki: `products`, `auth`, `reviews`…) dostaje błąd `status` w formacie D7; `error` domyślnie wg statusu (429 `TOO_MANY_REQUESTS` z `Retry-After: 30`, 503 `SERVICE_UNAVAILABLE`…) |

Przykłady: `window.__mocks.failNext('reviews', 503, { times: 3 })`, potem wejście na stronę produktu — sekcja opinii pokaże „Usługa jest chwilowo niedostępna”; `window.__mocks.failNext('auth', 429, { error: 'TOO_MANY_ATTEMPTS', retryAfter: 840 })` — logowanie pokaże blokadę konta.

Zaplanowane błędy są w stanie atrap, więc przeżywają przeładowanie strony. Liczy się **każde** żądanie do zasobu, które dotrze do atrap, także to, które strona wysyła sama (np. katalog po przeładowaniu pobiera `/products`). Ile błędów zaplanować, żeby zobaczyć komunikat:

| Sytuacja | `times` | Dlaczego |
|---|---|---|
| zapis (`POST`, `PUT`, `PATCH`, `DELETE`) | 1 | mutacji klient nie ponawia |
| `GET` z 502/503/504 wysłany później (np. przycisk „Spróbuj ponownie”, zmiana strony listy) | 2 | klient ponawia `GET` raz (decyzja 12) |
| `GET` z 502/503/504 przy wejściu na stronę | 3 | w trybie deweloperskim `<StrictMode>` montuje stronę dwa razy: TanStack Query przerywa pierwsze żądanie i wysyła je ponownie, a przerwane żądanie i tak dochodzi do atrap i zużywa jeden błąd (service worker MSW nie przekazuje przerwania do handlera); do tego jedno ponowienie |

Inne statusy (4xx, 429) nie są ponawiane, więc przy wejściu na stronę wystarcza `times: 2`, a później `times: 1`.

W testach E2E (projekt `mocked`) te same funkcje udostępnia `e2e/support/mocks.ts`: `login(page, 'customer' | 'admin')`, `resetMocks(page)`, `failNext(page, resource, status, opts)`. Playwright `page.route` nie widzi żądań obsłużonych przez atrapy (odpowiada service worker), dlatego błędy w trybie `mocked` wymusza się przez `failNext`.

### Atrapy w testach Vitest

Testy nie uruchamiają atrap same. Plik testu, który ich potrzebuje, woła na górze `setupMockServer()` z `src/mocks/node.ts` — po każdym teście stan wraca do danych startowych, a podmienione handlery do oryginałów. Stan jest w pamięci, odpowiedzi bez opóźnienia, przesyłka pojawia się od razu. Jeden handler w jednym teście podmienia `server.use(...)`:

```ts
import { http, HttpResponse } from 'msw'
import { server, setupMockServer } from '@/mocks/node'

setupMockServer()

it('shows a message when Review is unavailable', async () => {
  server.use(http.get('/api/v1/reviews', () => HttpResponse.json(
    { status: 503, error: 'SERVICE_UNAVAILABLE', message: 'down', requestId: 'r1' }, { status: 503 })))
  // ...
})
```

Identyfikatory danych startowych: `SEED_IDS` i konta `MOCK_ACCOUNTS` z `src/mocks/seed.ts`.


## Obraz i compose

W Docker Compose sklep działa pod adresem **http://127.0.0.1:8090**: kontener `frontend` serwuje zbudowaną aplikację i przekazuje żądania `/api/…` do API Gateway, więc aplikacja i API mają jeden adres (bez CORS). Gateway ma dalej własny port `127.0.0.1:8080` dla Postmana i curl.

### Budowa obrazu

Z katalogu głównego repozytorium:

```bash
docker compose -f deploy/compose.yaml --profile platform build frontend
```

Wynik: obraz `frontend:dev`. `Dockerfile` ma dwa etapy:

1. `node:22-alpine`: `npm ci` (dokładne wersje z `package-lock.json`), potem `npm run build` (sprawdzenie typów i build Vite do `dist/`).
2. `nginxinc/nginx-unprivileged:1.30-alpine`: tylko pliki z `dist/` (`/usr/share/nginx/html`) i konfiguracja nginx z `nginx/default.conf.template`. W obrazie nie ma kodu źródłowego, `node_modules`, plików `.env*`, map źródeł ani atrap MSW. nginx działa jako użytkownik `101` (bez roota) na porcie `8080` kontenera.

Pliki pomijane przy budowie (`node_modules`, `dist`, `.env*` poza `.env.example`, wyniki Playwright) są w `.dockerignore`.

Zmienne obrazu (wartości domyślne w `Dockerfile`, compose ustawia je jawnie):

| Zmienna | Domyślnie | Co robi |
|---|---|---|
| `GATEWAY_URL` | `http://api-gateway:8080` | adres Gateway, do którego nginx przekazuje `/api/…`. W Kubernetes pełna nazwa DNS, np. `http://api-gateway.shop.svc.cluster.local:8080`: `resolver` nginx nie używa domen `search` z `/etc/resolv.conf`, więc krótka nazwa `api-gateway` się nie rozwiąże |
| `NGINX_ENTRYPOINT_LOCAL_RESOLVERS` | `1` | serwery DNS dla `resolver` nginx brane z `/etc/resolv.conf` kontenera (DNS Dockera albo klastra) |

Obraz startuje więc także bez zmiennych (`docker run`), jeśli Gateway jest osiągalny pod nazwą `api-gateway` w tej samej sieci Dockera.

### Uruchomienie w compose

Frontend należy do profilu `platform` (razem z API Gateway i Auth Service):

```bash
docker compose -f deploy/compose.yaml --profile platform up -d --wait --build
docker compose -f deploy/compose.yaml --profile platform ps --format '{{.Service}} {{.Status}}'
```

Wynik: przy `frontend` (i przy `api-gateway`, `auth-service`) `Up … (healthy)`. Kontener startuje dopiero, gdy Gateway jest zdrowy, i jest tylko w sieci `sklep_edge` (nie widzi baz ani usług). Sprawdzenie:

```bash
curl -i http://127.0.0.1:8090/health/ready
```

Wynik: `HTTP/1.1 200 OK` i `{"status":"UP"}`. Potem sklep w przeglądarce: adres z początku sekcji (`http://localhost:8090` też działa, chyba że ten port na `[::1]` zajmuje inny program – [deploy/README.md](../deploy/README.md), „Gdy coś nie działa”).

Po zmianach w kodzie frontendu obraz trzeba zbudować od nowa i odtworzyć kontener:

```bash
docker compose -f deploy/compose.yaml --profile platform build frontend
docker compose -f deploy/compose.yaml --profile platform up -d --wait frontend
```

### Co robi nginx

| Ścieżka | Odpowiedź |
|---|---|
| `/api/…` | przekazane do Gateway bez zmian ścieżki i parametrów; odpowiedź Gateway też bez zmian (status, treść, `Set-Cookie`, `Retry-After`, `X-Request-Id`) |
| `/health/live`, `/health/ready` | `200 {"status":"UP"}` (`ready` sprawdza też, że jest `index.html`); bez wpisu w logu |
| `/assets/…` | pliki z nazwą z hashem, `Cache-Control: public, max-age=31536000, immutable`; brak pliku → `404` |
| inne ścieżki | plik, jeśli istnieje, w przeciwnym razie `index.html` ze statusem `200` (adresy aplikacji, np. `/orders/<id>`, działają po odświeżeniu strony); `index.html` z `Cache-Control: no-cache`, więc nowa wersja aplikacji jest widoczna od razu |

Poza `/api/` nginx przyjmuje tylko `GET` i `HEAD` (inne metody → `405`).

Gdy Gateway nie działa albo nie odpowiada albo żądanie jest za duże dla nginx, nginx sam zwraca błąd w formacie zespołu (`application/json`, z `requestId`):

| Sytuacja | Status i `error` |
|---|---|
| Gateway nieosiągalny (kontener zatrzymany, brak połączenia w 2 s) | `502` `BAD_GATEWAY` |
| Gateway przyjął połączenie, ale nie odpowiedział w 35 s | `504` `GATEWAY_TIMEOUT` |
| treść żądania powyżej 2 MiB | `413` `PAYLOAD_TOO_LARGE` (do 2 MiB decyduje Gateway: jego limit to 1 MiB) |
| linia nagłówka powyżej 32 KiB | `431` `REQUEST_HEADER_FIELDS_TOO_LARGE` (do 32 KiB decyduje Gateway: jego limit to 16 KB, też 431) |
| adres (ścieżka z parametrami) powyżej 32 KiB albo żądanie, którego nginx nie umie odczytać | `400` `VALIDATION_ERROR` (nginx odpowiedziałby `414`, format zespołu nie ma na to kodu) |

nginx zawsze nadpisuje `X-Forwarded-For` adresem klienta i usuwa `X-Real-IP`, `Forwarded`, `X-Forwarded-Host`, `X-Forwarded-Proto` oraz `X-Forwarded-Port`. Gateway ufa temu nagłówkowi tylko od kontenera `frontend` (`TRUSTED_PROXIES`), więc limity żądań (np. 5 logowań na minutę) liczą się dla każdego klienta osobno. `X-Request-Id` od klienta przechodzi dalej, jeśli ma 1–64 znaki `A–Z a–z 0–9 . _ -`; inaczej nginx nadaje własny.

### Nagłówki bezpieczeństwa

Odpowiedzi aplikacji (poza `/api/`) mają `Content-Security-Policy` (skrypty, style, czcionki i połączenia tylko z tego samego adresu; style inline dozwolone dla komponentów Radix i sonner; obrazy także `data:` i `https:`; bez osadzania w ramkach), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Permissions-Policy` (bez kamery, mikrofonu, lokalizacji i płatności) i `Cross-Origin-Opener-Policy: same-origin`. `Server` nie podaje wersji nginx. Odpowiedzi `/api/…` mają nagłówki Gateway, nie te.

### Logi

Log dostępu: jedna linia JSON na żądanie na standardowym wyjściu kontenera, pola `time`, `level`, `service` (`frontend`), `requestId`, `method`, `path` (bez parametrów zapytania), `status`, `durationMs`, `upstreamStatus` (status od Gateway; puste dla plików aplikacji). Bez nagłówków, ciasteczek i parametrów zapytania. Błędy samego nginx mają format nginx.

```bash
docker compose -f deploy/compose.yaml logs --no-log-prefix frontend | tail -3
```

`requestId` jest ten sam w logu frontendu, w logu Gateway i w odpowiedzi błędu, więc po „Kodzie zgłoszenia” z komunikatu w aplikacji można znaleźć żądanie w logach.
