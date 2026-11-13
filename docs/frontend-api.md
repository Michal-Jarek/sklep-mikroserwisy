# Kontrakt usług dla frontendu (v1)

Ten dokument opisuje wszystkie endpointy, które woła frontend sklepu (`frontend/`): ścieżki, dostęp, dane wejściowe, odpowiedzi, błędy i przykłady JSON. Jest wiążący dla usług, które już istnieją, i dla przyszłych właścicieli usług, których jeszcze nie ma (Product, Order, Shipping) — to **propozycja v1** platformy, tak jak kontrakty zdarzeń w [events.md](events.md).

Frontend w trybie deweloperskim działa na atrapach MSW (`frontend/src/mocks/`), które implementują dokładnie ten dokument. Test `frontend/src/api/contract.test.ts` sprawdza, że tabela [Endpointy używane przez frontend](#endpointy-używane-przez-frontend), lista wywołań klienta (`frontend/src/api/paths.ts`) i atrapy są zgodne. Typy TypeScript treści: `frontend/src/api/types.ts`.

## Spis treści

1. [Stan usług](#stan-usług)
2. [Zasady wspólne](#zasady-wspólne)
3. [Endpointy używane przez frontend](#endpointy-używane-przez-frontend)
4. [Auth](#auth)
5. [User](#user)
6. [Cart](#cart)
7. [Product](#product)
8. [Inventory](#inventory)
9. [Review](#review)
10. [Order](#order)
11. [Shipping](#shipping)
12. [Kody błędów domenowych](#kody-błędów-domenowych)
13. [Zmiana kontraktu](#zmiana-kontraktu)
14. [Otwarte kwestie](#otwarte-kwestie)

## Stan usług

| Usługa | Stan | Źródło kontraktu |
|---|---|---|
| Auth | **istnieje w `develop`**, działa w Docker Compose | [README Auth](../services/auth-service/README.md#endpointy) |
| User | **istnieje w `develop`**, działa w Docker Compose | kod `services/user-service/` |
| Cart | **istnieje w `develop`**, działa w Docker Compose | kod `services/cart-service/` |
| Inventory | **istnieje w `develop`**, działa w Docker Compose; `productId` jeszcze liczbą zamiast UUID ([D1](decisions.md#d1--identyfikatory)) — do poprawki | kod `services/inventory-service/` |
| Review | **istnieje w `develop`**, działa w Docker Compose; `productId` jeszcze liczbą zamiast UUID ([D1](decisions.md#d1--identyfikatory)) — do poprawki | kod `services/review-service/` |
| Product | **istnieje w `develop`** (PR #11), działa w Docker Compose; implementacja kontraktu v1 z tego dokumentu | ten dokument, kod `services/product-service/` |
| Notification | **istnieje w `develop`** (PR #12), działa w Docker Compose | `GET /notifications/me`: kod `services/notification-service/` |
| Order | **propozycja v1** | ten dokument; pola jak `order.created` w [events.md](events.md#ordercreated) |
| Shipping | **propozycja v1** | ten dokument; statusy jak `shipment.status_changed` w [events.md](events.md#shipmentstatus_changed) |

## Zasady wspólne

**Ścieżki.** Frontend woła `/api/v1/<ścieżka>`; Gateway obcina `/api/v1`, więc usługa wystawia ścieżkę bez prefiksu ([D12](decisions.md#d12--ścieżki)). W tym dokumencie wszystkie ścieżki są bez `/api/v1`. Parametry ścieżki zapisane są jako `{productId}`.

**Identyfikatory.** UUID tekstem, małymi literami ([D1](decisions.md#d1--identyfikatory)). Niepoprawny UUID w ścieżce, w query albo w treści → **400 `VALIDATION_ERROR`**.

**Kwoty.** Tekst z dwoma miejscami po kropce (`"19.99"`, wzorzec `^[0-9]{1,8}\.[0-9]{2}$`) razem z `currency` (`"PLN"`) — nigdy liczba JSON ([D3](decisions.md#d3--kwoty)). Sumy liczy się w groszach albo na typie dziesiętnym.

**Daty.** ISO 8601 w UTC, np. `"2026-11-09T08:30:12.457Z"`.

**Treść żądania.** JSON z `Content-Type: application/json`. Nieznane pola → **400 `VALIDATION_ERROR`** (tak działają Auth, User i Cart; propozycje v1 tak samo; Inventory i Review — zob. [Otwarte kwestie](#otwarte-kwestie)). Pola tekstowe są przycinane (spacje na początku i końcu), długości liczone po przycięciu.

**Błędy.** Format [D7](decisions.md#d7--format-i-kody-błędów): `{"status", "error", "message", "requestId"}`. Frontend dobiera komunikat dla klienta po `error`, nigdy po `message`. Kody wspólne (`VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `TOO_MANY_REQUESTS`, `SERVICE_UNAVAILABLE`…) — D7; kody domenowe — sekcja [Kody błędów domenowych](#kody-błędów-domenowych); kody samego Gateway (`BAD_GATEWAY`, `GATEWAY_TIMEOUT`, `REQUEST_TIMEOUT`…) — [README Gateway](../services/api-gateway/README.md#kody-błędów).

```json
{"status": 409, "error": "CART_EMPTY", "message": "Cart is empty", "requestId": "6e0f8a7c-1b2d-4e3f-8a9b-0c1d2e3f4a5b"}
```

> **Uwaga.** Dzisiejszy kod User i Cart (PR #1) zwraca błąd walidacji jako 400 `BAD_REQUEST`, a D7 wymaga `VALIDATION_ERROR`. Do czasu poprawki frontend traktuje oba kody tak samo. Podobnie 500 to tam `INTERNAL_SERVER_ERROR` zamiast `INTERNAL_ERROR`.

**Stronicowanie.** Listy, które mogą być długie, mają parametry `page` (od 1, domyślnie 1) i `size` (1–100, domyślnie 20). Odpowiedź:

```json
{"items": [], "page": 1, "size": 20, "total": 57}
```

`total` to liczba wszystkich elementów (wszystkich stron). Strona poza zakresem → pusta lista `items`, nie błąd. `page` lub `size` spoza zakresu albo nie liczba całkowita → **400 `VALIDATION_ERROR`**.

**Dostęp.** Pilnuje go Gateway według reguł z [`deploy/consul/config/api-gateway.yaml`](../deploy/consul/config/api-gateway.yaml) (bez zmian w tym etapie):

| Poziom w dokumencie | Reguła Gateway | Bez tokenu | Z tokenem bez wymaganej roli |
|---|---|---|---|
| publiczny | `public` | działa (klient anonimowy) | działa |
| zalogowany | brak reguły (domyślnie `authenticated`) | **401 `UNAUTHORIZED`** | — |
| ADMIN | `ADMIN` | **401 `UNAUTHORIZED`** | **403 `FORBIDDEN`** |
| wewnętrzny | `blocked` | **404 `NOT_FOUND`** | **404 `NOT_FOUND`** |

Na trasie publicznej nieważny albo wygasły token nie daje błędu — żądanie idzie dalej jako anonimowe. Na trasie wymagającej logowania wygasły token → 401; frontend wtedy raz odświeża sesję i powtarza żądanie.

**Tożsamość i własność danych.** Usługa dostaje od Gateway `X-User-Id` (= `sub` z tokenu) i `X-User-Roles` (`CUSTOMER` albo `ADMIN`) i sama pilnuje własności ([D11](decisions.md#d11--tożsamość-i-nagłówki)): klient widzi i zmienia tylko swoje zasoby; cudzy zasób → **404 `NOT_FOUND`** (nie zdradza, że istnieje), chyba że opis endpointu mówi inaczej; `ADMIN` może więcej tam, gdzie to opisano.

## Endpointy używane przez frontend

Dokładnie te endpointy woła frontend (`API_ENDPOINTS` w `frontend/src/api/paths.ts`) i dokładnie dla nich są atrapy. Test `frontend/src/api/contract.test.ts` czyta tę tabelę — pierwsza kolumna ma format `` `METODA /ścieżka` ``.

| Endpoint | Usługa | Dostęp | Odpowiedź |
|---|---|---|---|
| `POST /auth/register` | Auth | publiczny | 201 konto, bez tokenów |
| `POST /auth/login` | Auth | publiczny | 200 token + ciasteczko |
| `POST /auth/refresh` | Auth | publiczny (ciasteczko) | 200 token + nowe ciasteczko |
| `POST /auth/logout` | Auth | publiczny (ciasteczko) | 204 |
| `GET /users/me` | User | zalogowany | 200 profil |
| `PUT /users/me` | User | zalogowany | 200 profil |
| `GET /users/me/addresses` | User | zalogowany | 200 lista adresów |
| `POST /users/me/addresses` | User | zalogowany | 201 adres |
| `DELETE /users/me/addresses/{addressId}` | User | zalogowany, właściciel | 204 |
| `GET /cart` | Cart | zalogowany | 200 koszyk |
| `POST /cart/items` | Cart | zalogowany | 200 koszyk + `inventoryChecked` |
| `PATCH /cart/items/{productId}` | Cart | zalogowany | 200 koszyk + `inventoryChecked` |
| `DELETE /cart/items/{productId}` | Cart | zalogowany | 204 |
| `GET /products` | Product | publiczny | 200 strona `ProductSummary` |
| `GET /products/{productId}` | Product | publiczny | 200 `ProductDetail` |
| `GET /categories` | Product | publiczny | 200 lista kategorii |
| `POST /products` | Product | ADMIN | 201 `ProductDetail` |
| `PUT /products/{productId}` | Product | ADMIN | 200 `ProductDetail` |
| `DELETE /products/{productId}` | Product | ADMIN | 204 |
| `GET /inventory/{productId}` | Inventory | publiczny | 200 stan |
| `PUT /inventory/{productId}` | Inventory | ADMIN | 200 stan |
| `GET /reviews` | Review | publiczny | 200 strona opinii |
| `POST /reviews` | Review | zalogowany | 201 opinia |
| `DELETE /reviews/{reviewId}` | Review | zalogowany, autor albo ADMIN | 204 |
| `POST /orders` | Order | zalogowany | 201 `OrderDetail` |
| `GET /orders` | Order | zalogowany | 200 strona `OrderSummary` |
| `GET /orders/{orderId}` | Order | zalogowany, właściciel albo ADMIN | 200 `OrderDetail` |
| `POST /orders/{orderId}/cancel` | Order | zalogowany, właściciel albo ADMIN | 200 `OrderDetail` |
| `GET /shipping/methods` | Shipping | publiczny | 200 lista metod dostawy |
| `GET /shipments` | Shipping | zalogowany | 200 strona `Shipment` |
| `PATCH /shipments/{shipmentId}/status` | Shipping | ADMIN | 200 `Shipment` |

Dwa endpointy z sekcji usług nie są w tabeli, bo frontend ich nie woła: `GET /reviews/summary/{productId}` (woła Product) i `GET /shipping/methods/{code}`.

## Auth

**Stan:** istnieje w `develop`. Pełny opis: [README Auth](../services/auth-service/README.md#endpointy) (walidacja, ciasteczko, limity, blokada konta). Tu tylko to, czego potrzebuje frontend.

### `POST /auth/register` — publiczny

Wejście: `{"email", "password", "firstName", "lastName"}`. `email` ≤ 254 znaki (zamieniany na małe litery), `password` 10–72 **bajty** UTF-8, `firstName` i `lastName` 1–100 znaków bez znaków sterujących.

```json
{"email": "anna@example.com", "password": "Bardzo-tajne-1", "firstName": "Anna", "lastName": "Nowak"}
```

**201** — konto, bez tokenów (rejestracja nie loguje; frontend loguje od razu tymi danymi):

```json
{"id": "0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e", "email": "anna@example.com", "firstName": "Anna", "lastName": "Nowak", "roles": ["CUSTOMER"]}
```

Błędy: 400 `VALIDATION_ERROR`, 409 `EMAIL_TAKEN`, 429 `TOO_MANY_REQUESTS` (limit Gateway 10/min/IP), 503 `SERVICE_UNAVAILABLE` (User nie utworzył profilu).

### `POST /auth/login` — publiczny

Wejście: `{"email", "password"}` (hasło 1–72 bajty). **200** + `Set-Cookie: refresh_token=…; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict`:

```json
{"accessToken": "eyJhbGciOiJSUzI1NiIs…", "tokenType": "Bearer", "expiresIn": 900}
```

Access token (JWT) ma w treści `sub` (UUID konta), `roles` (`["CUSTOMER"]` albo `["ADMIN"]`), `iss` `sklep-auth`, `aud` `sklep-api`, `iat`, `exp`. Frontend czyta `sub` i `roles` tylko do interfejsu; uprawnienia sprawdza Gateway.

Błędy: 400 `VALIDATION_ERROR`, 401 `INVALID_CREDENTIALS`, 429 `TOO_MANY_REQUESTS` (limit IP, 5/min) albo `TOO_MANY_ATTEMPTS` (konto zablokowane na 15 min) — oba z `Retry-After` w sekundach.

### `POST /auth/refresh` — publiczny, ciasteczko

Bez treści; przeglądarka wysyła ciasteczko `refresh_token` sama. **200** jak logowanie + nowe ciasteczko (stare traci ważność). Błąd: **401 `UNAUTHORIZED`** (brak, nieznany, wygasły albo już użyty token) + ciasteczko wyczyszczone. Dwa równoczesne odświeżenia tym samym ciasteczkiem unieważniają całą sesję — frontend odświeża najwyżej raz naraz (także między kartami).

### `POST /auth/logout` — publiczny, ciasteczko

**204** zawsze (także bez ciasteczka); ciasteczko wyczyszczone. Access token działa do końca swoich 15 minut — frontend usuwa go z pamięci. Gdy frontend nie dostanie `204` (odpowiedź Gateway, nginx albo brak sieci), sesja zostaje i użytkownik widzi komunikat — frontend nie może sam usunąć ciasteczka `HttpOnly`.

## User

**Stan:** istnieje w `develop` (PR #1), jeszcze nie w Docker Compose. Profil zakłada Auth przy rejestracji (`POST /users`, wewnętrzny, [D8](decisions.md#d8--profil-użytkownika-przy-rejestracji)). Konto administratora nie ma profilu.

### `GET /users/me` — zalogowany

**200**:

```json
{"id": "0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e", "firstName": "Anna", "lastName": "Nowak", "email": "anna@example.com"}
```

Błędy: 401, **404 `NOT_FOUND`** — brak profilu (np. konto ADMIN).

### `PUT /users/me` — zalogowany

Wejście: `{"firstName", "lastName"}`, oba 1–100 znaków. E-maila nie zmienia się tutaj (należy do Auth). **200** — profil jak w `GET /users/me`. Błędy: 400 `VALIDATION_ERROR`, 401, 404 (brak profilu).

### `GET /users/me/addresses` — zalogowany

**200** — lista (bez stronicowania):

```json
[{"id": "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f", "street": "ul. Prosta 1/2", "city": "Warszawa", "postalCode": "00-001", "countryCode": "PL"}]
```

Błędy: 401, 404 (brak profilu).

### `POST /users/me/addresses` — zalogowany

Wejście: `{"street"` 1–200, `"city"` 1–100, `"postalCode"` 1–20, `"countryCode"` dwie wielkie litery `^[A-Z]{2}$`}:

```json
{"street": "ul. Prosta 1/2", "city": "Warszawa", "postalCode": "00-001", "countryCode": "PL"}
```

**201** — adres z `id`. Błędy: 400 `VALIDATION_ERROR`, 401, 404 (brak profilu).

### `DELETE /users/me/addresses/{addressId}` — zalogowany, właściciel

**204**. Błędy: 400 (`addressId` nie jest UUID), 401, **404** — brak adresu albo adres innego klienta.

## Cart

**Stan:** istnieje w `develop` (PR #1), jeszcze nie w Docker Compose. Koszyk należy do zalogowanego klienta (`X-User-Id`). Cart pobiera nazwę i cenę z Product i dostępność z Inventory przy każdej zmianie.

Koszyk:

```json
{
  "userId": "0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e",
  "currency": "PLN",
  "items": [
    {"productId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "name": "Kubek ceramiczny", "unitPrice": "19.99", "quantity": 2, "subtotal": "39.98"}
  ],
  "total": "39.98"
}
```

`subtotal` = `unitPrice × quantity`, `total` = suma `subtotal`. Pusty koszyk: `"items": []`, `"total": "0.00"`.

### `GET /cart` — zalogowany

**200** — koszyk (pusty, gdy klient nic nie dodał). Błąd: 401.

### `POST /cart/items` — zalogowany

Wejście: `{"productId", "quantity"}`, `quantity` liczba całkowita 1–999. **Dodaje** do ilości, która już jest w koszyku. **200** — koszyk + `inventoryChecked`:

```json
{"userId": "0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e", "currency": "PLN", "items": [ … ], "total": "39.98", "inventoryChecked": true}
```

`inventoryChecked: false` — Inventory był niedostępny; dostępność sprawdzi Order przy zamówieniu. Produkt bez stanu w Inventory (404) ma **0 sztuk** — dodanie kończy się 409 jak przy braku towaru.

Błędy: 400 `VALIDATION_ERROR`, 401, 404 `NOT_FOUND` (nie ma produktu), **409 `CONFLICT`** (za mało sztuk w magazynie — także produkt bez stanu w Inventory — albo razem więcej niż 999), 503 `SERVICE_UNAVAILABLE` (Product niedostępny — bez aktualnej ceny nie da się dodać).

### `PATCH /cart/items/{productId}` — zalogowany

Wejście: `{"quantity"}` 1–999 — **ustawia** ilość. **200** — koszyk + `inventoryChecked`. Błędy jak `POST /cart/items`; 404 także, gdy produktu nie ma w koszyku.

### `DELETE /cart/items/{productId}` — zalogowany

**204**, także gdy produktu nie było w koszyku (idempotentne). Błędy: 400 (nie UUID), 401.

## Product

**Stan:** propozycja v1. Właściciel usługi może ją zmienić przed pierwszą implementacją w porozumieniu z Michałem (sekcja [Zmiana kontraktu](#zmiana-kontraktu)).

**Poza frontendem.** Ta sekcja opisuje tylko to, co woła frontend. Product obsługuje też lekki odczyt produktu dla Cart i Order ([D4](decisions.md#d4--lekki-odczyt-produktu)), a Review woła go przy `GET /reviews/summary/{productId}`. Endpointy wewnętrzne — [D10](decisions.md#d10--endpointy-wewnętrzne).

### `GET /products` — publiczny

Query (wszystkie opcjonalne):

| Parametr | Znaczenie |
|---|---|
| `q` | tekst do 200 znaków; szuka w nazwie i opisie, bez względu na wielkość liter |
| `categoryId` | UUID kategorii; nieznana kategoria → pusta lista |
| `minPrice`, `maxPrice` | kwota tekstem `^\d{1,8}(\.\d{1,2})?$` (np. `10` albo `10.5`), granice włącznie; `minPrice` > `maxPrice` → 400 |
| `sort` | `NAME` (domyślnie, alfabetycznie), `PRICE_ASC`, `PRICE_DESC`, `NEWEST` (najnowsze najpierw) |
| `page`, `size` | stronicowanie (domyślnie 1 i 20) |

**200** — strona `ProductSummary` (bez oceny i dostępności — po nie frontend sięga dopiero na stronie produktu):

```json
{
  "items": [
    {"id": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "name": "Kubek ceramiczny", "price": "19.99", "currency": "PLN", "categoryId": "3f2e1d0c-9b8a-4765-8432-10fedcba9876", "imageUrl": null}
  ],
  "page": 1, "size": 12, "total": 1
}
```

Błędy: 400 `VALIDATION_ERROR` (zły parametr).

### `GET /products/{productId}` — publiczny

**200** — `ProductDetail`:

```json
{
  "id": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  "name": "Kubek ceramiczny",
  "description": "Kubek 300 ml, można myć w zmywarce.",
  "price": "19.99",
  "currency": "PLN",
  "category": {"id": "3f2e1d0c-9b8a-4765-8432-10fedcba9876", "name": "Kuchnia"},
  "imageUrl": "https://img.example.com/kubek.jpg",
  "rating": {"average": 4.5, "count": 12},
  "availability": {"available": 10, "inStock": true},
  "createdAt": "2026-11-01T10:00:00.000Z",
  "updatedAt": "2026-11-05T12:30:00.000Z"
}
```

- `rating` — z Review (`GET /reviews/summary/{productId}`): `average` zaokrąglona do 0,1, `null` przy `count` 0; **`rating: null`** — Review niedostępny (strona działa dalej).
- `availability` — z Inventory: `available` = `quantity − reserved`, `inStock` = `available > 0`. Produkt bez stanu w Inventory (404) ma **0 sztuk**: `{"available": 0, "inStock": false}`. **`availability: null`** — tylko gdy Inventory jest niedostępny.
- Z rolą `SERVICE` (wołają Cart i Order) Product nie woła Review ani Inventory ([D4](decisions.md#d4--lekki-odczyt-produktu)) — `rating` i `availability` są wtedy `null`.

Błędy: 400 (`productId` nie jest UUID), 404 `NOT_FOUND`.

### `GET /categories` — publiczny

**200** — lista alfabetycznie, bez stronicowania:

```json
[{"id": "3f2e1d0c-9b8a-4765-8432-10fedcba9876", "name": "Kuchnia"}]
```

### `POST /products` — ADMIN

Wejście:

| Pole | Reguła |
|---|---|
| `name` | 1–200 znaków |
| `description` | 0–5000 znaków (pusty tekst dozwolony) |
| `price` | kwota D3, co najmniej `"0.01"` |
| `currency` | `"PLN"` |
| `categoryId` | UUID istniejącej kategorii; nieznana → 400 `VALIDATION_ERROR` |
| `imageUrl` | adres `https://…` do 2000 znaków albo `null` |

```json
{"name": "Kubek ceramiczny", "description": "Kubek 300 ml.", "price": "19.99", "currency": "PLN", "categoryId": "3f2e1d0c-9b8a-4765-8432-10fedcba9876", "imageUrl": null}
```

**201** — `ProductDetail` nowego produktu (`rating` `{"average": null, "count": 0}`, `availability` `{"available": 0, "inStock": false}` — stanu jeszcze nie ma, ustawia się go w Inventory). Błędy: 400, 401, 403.

### `PUT /products/{productId}` — ADMIN

Ta sama treść co `POST` (pełna zamiana). **200** — `ProductDetail`. Błędy: 400, 401, 403, 404.

### `DELETE /products/{productId}` — ADMIN

**204**. Błędy: 400, 401, 403, 404. Opinie, stany i pozycje zamówień zostają w swoich usługach (zamówienia mają kopię nazwy i ceny).

## Inventory

**Stan:** w PR #2 (Aleksandra), tu z identyfikatorami UUID zgodnie z D1. Endpointy rezerwacji (`/inventory/reservations/**`) są wewnętrzne (Order) i nie dotyczą frontendu.

### `GET /inventory/{productId}` — publiczny

**200**:

```json
{"productId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "quantity": 12, "reserved": 2, "available": 10, "inStock": true}
```

`available` = `quantity − reserved`, `inStock` = `available > 0`. Błędy: 400 (nie UUID), **404 `NOT_FOUND`** — brak stanu produktu (panel admina: „ustaw ilość”).

### `PUT /inventory/{productId}` — ADMIN

Wejście: `{"quantity"}` — liczba całkowita 0–1 000 000 (stan fizyczny, z rezerwacjami). Tworzy stan, gdy go nie ma. **200** — stan jak wyżej. Błędy: 400, 401, 403, **409 `CONFLICT`** — nowa ilość mniejsza niż `reserved`.

## Review

**Stan:** w PR #2 (Aleksandra), tu z identyfikatorami UUID zgodnie z D1.

Opinia:

```json
{"id": "e1d2c3b4-a596-4877-8a6b-5c4d3e2f1a0b", "productId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "userId": "0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e", "rating": 5, "comment": "Solidny kubek.", "createdAt": "2026-11-08T17:20:00.000Z"}
```

### `GET /reviews` — publiczny

Query: `productId` (UUID, **wymagany**), `page`, `size`. **200** — strona opinii produktu, najnowsze najpierw. Błędy: 400 (brak albo zły `productId`, złe stronicowanie).

### `POST /reviews` — zalogowany

Wejście: `{"productId", "rating"` liczba całkowita 1–5, `"comment"` ≤ 2000 znaków albo `null`}; pusty komentarz (same spacje) zapisywany jako `null`.

```json
{"productId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "rating": 5, "comment": "Solidny kubek."}
```

**201** — opinia. Review sprawdza w Order, czy klient kupił produkt (zamówienie `PAID`, `SHIPPED` albo `DELIVERED` z tym produktem; endpoint wewnętrzny `GET /orders/purchased`).

Błędy: 400, 401, **403 `FORBIDDEN`** — klient nie kupił produktu, **409 `CONFLICT`** — klient już ocenił ten produkt, 503 `SERVICE_UNAVAILABLE` — Order niedostępny.

### `DELETE /reviews/{reviewId}` — zalogowany, autor albo ADMIN

**204**. Błędy: 400 (nie UUID), 401, **403 `FORBIDDEN`** — cudza opinia (opinie są publiczne, więc 403, nie 404), 404.

### `GET /reviews/summary/{productId}` — publiczny, frontend nie używa

Woła Product, żeby zbudować pole `rating`. **200**: `{"productId", "averageRating": 4.5 | null, "reviewCount": 12}` (`averageRating` `null`, gdy brak opinii). Błąd: 400.

## Order

**Stan:** propozycja v1. Pola jak w zdarzeniu `order.created` ([events.md](events.md#ordercreated)).

**Poza frontendem.** Ta sekcja opisuje tylko to, co woła frontend. Order ma też obowiązki wobec innych usług:
- woła Cart (`GET /cart`, `DELETE /cart/{userId}`), Product (lekki odczyt, [D4](decisions.md#d4--lekki-odczyt-produktu)), Inventory (rezerwacje `/inventory/reservations/**`) i Shipping (`GET /shipping/methods/{code}`) — z nagłówkami jak w [D11](decisions.md#d11--tożsamość-i-nagłówki);
- wystawia endpoint wewnętrzny `GET /orders/purchased?userId=<uuid>&productId=<uuid>` dla Review ([D10](decisions.md#d10--endpointy-wewnętrzne); kontrakt v1, decyzja Michała 2026-11-12) → **200** `{"purchased": true|false}` — `true`, gdy klient ma zamówienie `PAID`, `SHIPPED` albo `DELIVERED` z tym produktem. Tylko rola `SERVICE` (inaczej **403 `FORBIDDEN`**), z zewnątrz zablokowany w Gateway (**404**). Identyfikator, który nie jest UUID → **400 `VALIDATION_ERROR`**. Review woła go z `X-User-Id` klienta i rolą `SERVICE` w `X-User-Roles` ([D11](decisions.md#d11--tożsamość-i-nagłówki));
- publikuje `order.created` i `order.cancelled`, odbiera `shipment.status_changed` ([events.md](events.md#zdarzenia-w-wersji-1)).

Statusy zamówienia:

| Status | Znaczenie | Etykieta we frontendzie |
|---|---|---|
| `NEW` | zapisane, przed płatnością | Nowe |
| `PAID` | opłacone; wysłane `order.created` | Opłacone |
| `PAYMENT_FAILED` | płatność odrzucona; rezerwacja zwolniona, koszyk bez zmian | Płatność nieudana |
| `SHIPPED` | przesyłka `SHIPPED` (ze zdarzenia `shipment.status_changed`) | Wysłane |
| `DELIVERED` | przesyłka `DELIVERED` | Dostarczone |
| `CANCELLED` | anulowane; wysłane `order.cancelled` | Anulowane |

`IN_TRANSIT` przesyłki nie zmienia statusu zamówienia.

`OrderDetail`:

```json
{
  "id": "5d7e9f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a",
  "userId": "0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e",
  "status": "PAID",
  "items": [
    {"productId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "name": "Kubek ceramiczny", "unitPrice": "19.99", "quantity": 2, "subtotal": "39.98"}
  ],
  "itemsTotal": "39.98",
  "shippingMethod": "COURIER",
  "shippingCost": "14.99",
  "total": "54.97",
  "currency": "PLN",
  "shippingAddress": {"firstName": "Anna", "lastName": "Nowak", "street": "ul. Prosta 1/2", "postalCode": "00-001", "city": "Warszawa", "countryCode": "PL"},
  "createdAt": "2026-11-09T08:30:12.457Z",
  "updatedAt": "2026-11-09T08:30:12.457Z"
}
```

`itemsTotal` = suma `subtotal`; `total` = `itemsTotal + shippingCost`. Nazwa i cena pozycji to kopia z chwili zamówienia.

### `POST /orders` — zalogowany

Wejście:

| Pole | Reguła |
|---|---|
| `shippingMethod` | kod metody z `GET /shipping/methods`; nieznany → 400 `VALIDATION_ERROR` |
| `shippingAddress.firstName`, `.lastName` | 1–100 znaków |
| `shippingAddress.street` | 1–200 znaków |
| `shippingAddress.city` | 1–100 znaków |
| `shippingAddress.postalCode` | 1–20 znaków |
| `shippingAddress.countryCode` | `^[A-Z]{2}$` |
| `payment.cardNumber` | 12–19 cyfr (frontend usuwa spacje) |

```json
{
  "shippingMethod": "COURIER",
  "shippingAddress": {"firstName": "Anna", "lastName": "Nowak", "street": "ul. Prosta 1/2", "postalCode": "00-001", "city": "Warszawa", "countryCode": "PL"},
  "payment": {"cardNumber": "4111111111111111"}
}
```

Pozycje zamówienia Order bierze z koszyka klienta (woła Cart), ceny z Product, koszt dostawy z Shipping. Przebieg: zapis `NEW` → rezerwacja w Inventory → płatność (atrapa) → `PAID` (koszyk wyczyszczony, zdarzenie `order.created`) albo `PAYMENT_FAILED` (rezerwacja zwolniona, koszyk bez zmian).

**Atrapa płatności:** numer karty kończący się cyfrą `0` → odrzucenie (`PAYMENT_FAILED`), każdy inny → `PAID`. Order nie zapisuje i nie loguje numeru karty (najwyżej 4 ostatnie cyfry).

**201** — `OrderDetail` ze statusem `PAID` albo `PAYMENT_FAILED` (oba to utworzone zamówienie; frontend rozróżnia po `status`).

Błędy: 400 `VALIDATION_ERROR`, 401, **409 `CART_EMPTY`** — pusty koszyk, **409 `INSUFFICIENT_STOCK`** — za mało sztuk któregoś produktu (także produkt bez stanu w Inventory), **409 `PRODUCT_UNAVAILABLE`** — produktu z koszyka nie ma już w sklepie (wycofany przez ADMIN; lekki odczyt Product daje 404), frontend prosi o usunięcie go z koszyka, 503 `SERVICE_UNAVAILABLE` — Cart, Product, Inventory albo Shipping niedostępne.

**Przesyłka powstaje asynchronicznie:** Shipping zakłada ją po zdarzeniu `order.created`, więc przez chwilę po `201` `GET /shipments?orderId=` może zwracać pustą listę („W przygotowaniu”).

### `GET /orders` — zalogowany

Query: `page`, `size`. **200** — strona **własnych** zamówień (także dla ADMIN), najnowsze najpierw:

```json
{
  "items": [
    {"id": "5d7e9f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a", "status": "PAID", "total": "54.97", "currency": "PLN", "itemCount": 1, "createdAt": "2026-11-09T08:30:12.457Z"}
  ],
  "page": 1, "size": 20, "total": 1
}
```

`itemCount` — liczba pozycji (różnych produktów) w zamówieniu. Błędy: 400, 401.

### `GET /orders/{orderId}` — zalogowany, właściciel albo ADMIN

**200** — `OrderDetail`. Błędy: 400 (nie UUID), 401, **404** — brak albo cudze zamówienie (dla klienta).

### `POST /orders/{orderId}/cancel` — zalogowany, właściciel albo ADMIN

Bez treści. Anulować można zamówienie `NEW` albo `PAID`, dopóki przesyłki nie ma albo ma status `PREPARING`. **200** — `OrderDetail` ze statusem `CANCELLED`. Po anulowaniu `PAID` Order wysyła `order.cancelled` (Inventory zwalnia rezerwację, Shipping anuluje przesyłkę `PREPARING`); czy zdarzenie wychodzi także dla `NEW`, jest otwarte ([events.md](events.md#otwarte-kwestie-kontraktu-v1)).

Błędy: 400, 401, 404, **409 `ORDER_NOT_CANCELLABLE`** — inny status (np. `PAYMENT_FAILED`, `SHIPPED`, `CANCELLED`) albo przesyłka już `SHIPPED`.

## Shipping

**Stan:** propozycja v1. Statusy jak w zdarzeniu `shipment.status_changed` ([events.md](events.md#shipmentstatus_changed)).

**Poza frontendem.** Ta sekcja opisuje tylko to, co woła frontend. Order woła `GET /shipping/methods/{code}` (koszt dostawy przy składaniu zamówienia). Shipping odbiera `order.created` i `order.cancelled` i publikuje `shipment.status_changed` ([events.md](events.md#zdarzenia-w-wersji-1)). Endpointy wewnętrzne — [D10](decisions.md#d10--endpointy-wewnętrzne).

Metody dostawy:

| `code` | Etykieta we frontendzie |
|---|---|
| `COURIER` | Kurier |
| `PARCEL_LOCKER` | Paczkomat |
| `PICKUP` | Odbiór osobisty |

Statusy przesyłki: `PREPARING` (W przygotowaniu) → `SHIPPED` (Wysłana) → `IN_TRANSIT` (W drodze) → `DELIVERED` (Dostarczona); `CANCELLED` (Anulowana) — tylko po anulowaniu zamówienia.

`Shipment`:

```json
{
  "id": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
  "orderId": "5d7e9f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a",
  "userId": "0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e",
  "status": "SHIPPED",
  "method": "COURIER",
  "trackingNumber": "PL1234567890",
  "history": [
    {"status": "PREPARING", "at": "2026-11-09T08:30:13.000Z"},
    {"status": "SHIPPED", "at": "2026-11-10T10:15:00.000Z"}
  ],
  "createdAt": "2026-11-09T08:30:13.000Z",
  "updatedAt": "2026-11-10T10:15:00.000Z"
}
```

`history` od najstarszego wpisu, ostatni = bieżący `status`. `trackingNumber` jest `null` tylko przed nadaniem paczki (`PREPARING`); od `SHIPPED` jest zawsze tekstem. To rozstrzygnięcie propozycji v1 dla REST — kwestia w [otwartych kwestiach events.md](events.md#otwarte-kwestie-kontraktu-v1) zostaje otwarta dla właściciela Shipping, a frontend działa w obu wariantach (numer od razu albo dopiero po nadaniu).

### `GET /shipping/methods` — publiczny

**200** — lista (bez stronicowania), kolejność jak w tabeli metod:

```json
[{"code": "COURIER", "name": "Kurier", "price": "14.99", "currency": "PLN", "estimatedDays": 2}]
```

`estimatedDays` — przewidywana liczba dni roboczych do doręczenia.

### `GET /shipping/methods/{code}` — publiczny, frontend nie używa

**200** — jedna metoda jak wyżej (woła ją Order, żeby poznać koszt dostawy). Błąd: **404** — nieznany kod.

### `GET /shipments` — zalogowany

Query: `orderId` (UUID), `status` (status przesyłki), `page`, `size` — wszystkie opcjonalne. **200** — strona `Shipment`, najnowsze najpierw. `CUSTOMER` widzi tylko swoje przesyłki (po `X-User-Id`), `ADMIN` — wszystkie. Cudze `orderId` dla klienta → pusta lista.

Błędy: 400 (zły UUID, nieznany status, złe stronicowanie), 401.

### `PATCH /shipments/{shipmentId}/status` — ADMIN

Wejście: `{"status": "SHIPPED"}`. Dozwolone tylko przejście o jeden krok naprzód: `PREPARING→SHIPPED`, `SHIPPED→IN_TRANSIT`, `IN_TRANSIT→DELIVERED`. Przy `SHIPPED` Shipping nadaje `trackingNumber`. Każda zmiana dopisuje wpis do `history` i publikuje `shipment.status_changed` (Order zmienia status zamówienia, Inventory wydaje towar przy `SHIPPED`).

**200** — `Shipment`. Błędy: 400 (nieznany status), 401, 403, 404, **409 `INVALID_STATUS_TRANSITION`** — każde inne przejście (krok wstecz, przeskok, z `DELIVERED` albo `CANCELLED`, ręczne `CANCELLED`).

## Kody błędów domenowych

Kody z tego dokumentu oprócz wspólnych z D7. Rejestr: [decisions.md, D7](decisions.md#rejestr-kodów-domenowych).

| Usługa | Status | `error` | Kiedy | Stan |
|---|---|---|---|---|
| Auth | 401 | `INVALID_CREDENTIALS` | złe hasło albo nieznany e-mail | istnieje |
| Auth | 409 | `EMAIL_TAKEN` | e-mail już zarejestrowany | istnieje |
| Auth | 429 | `TOO_MANY_ATTEMPTS` | konto zablokowane na 15 min; z `Retry-After` | istnieje |
| Inventory, Order | 409 | `INSUFFICIENT_STOCK` | za mało towaru (rezerwacja przy zamówieniu) | istnieje (Inventory) |
| Order | 409 | `CART_EMPTY` | zamówienie z pustego koszyka | propozycja v1 |
| Order | 409 | `PRODUCT_UNAVAILABLE` | produkt z koszyka wycofany ze sklepu | propozycja v1 |
| Order | 409 | `ORDER_NOT_CANCELLABLE` | anulowanie po wysyłce albo w statusie innym niż `NEW`/`PAID` | propozycja v1 |
| Shipping | 409 | `INVALID_STATUS_TRANSITION` | zmiana statusu przesyłki inna niż o jeden krok naprzód | propozycja v1 |

Cart (za mało sztuk) i Review (opinia drugi raz) zwracają wspólny `CONFLICT`, Review (opinia bez zakupu) — wspólny `FORBIDDEN`; frontend pokazuje dla nich komunikat zależny od miejsca.

## Zmiana kontraktu

- Części oznaczone **propozycja v1** (Product, Order, Shipping) właściciel usługi może zmienić **przed pierwszą implementacją**, w porozumieniu z Michałem — zmiana trafia najpierw do tego dokumentu, razem z atrapami i typami frontendu (test kontraktu pilnuje zgodności).
- Po pierwszej implementacji i dla usług, które już istnieją (Auth, User, Cart, Inventory, Review), zmiana ścieżki, pól JSON albo kodów odpowiedzi wymaga zgody usług i frontendu, które ją wołają ([D9](decisions.md#d9--własność-kodu-pr-i-dokumenty)), i opisu w PR (pole „Zmiana kontraktu?”).
- Dodanie pola do odpowiedzi nie jest zmianą łamiącą (frontend ignoruje nieznane pola). Usunięcie albo zmiana znaczenia pola — jest.
- Nowy kod domenowy → zgłoszenie Michałowi (rejestr w D7), bo frontend dobiera komunikat po kodzie.

## Otwarte kwestie

Do ustalenia z właścicielami usług przed ich implementacją. Do czasu decyzji obowiązuje to, co jest wyżej.

| Kwestia | Stan dziś |
|---|---|
| User i Cart: 400 `BAD_REQUEST` i 500 `INTERNAL_SERVER_ERROR` zamiast `VALIDATION_ERROR` i `INTERNAL_ERROR` (D7) | do poprawki w User i Cart; frontend obsługuje oba |
| Inventory i Review w PR #2 mają identyfikatory liczbowe | ten dokument wymaga UUID ([D1](decisions.md#d1--identyfikatory)) |
| Review w PR #2: `reviewId` i `_id` opinii w MongoDB to ObjectId | ten dokument wymaga UUID także dla opinii ([D1](decisions.md#d1--identyfikatory)) |
| Review w PR #2 woła Order (`GET /orders/purchased`) tylko z `X-Request-Id` | wywołanie między usługami przekazuje `X-User-Id` i dodaje rolę `SERVICE` do `X-User-Roles` ([D11](decisions.md#d11--tożsamość-i-nagłówki)) |
| Inventory i Review w PR #2 weryfikują JWT (tryb z `JWT_JWKS_URL`) | token sprawdza tylko Gateway; usługa ufa `X-User-Id` i `X-User-Roles` ([D11](decisions.md#d11--tożsamość-i-nagłówki)) |
| Inventory i Review w PR #2 ignorują nieznane pola w treści żądania | ten dokument wymaga **400 `VALIDATION_ERROR`** ([Zasady wspólne](#zasady-wspólne), [D7](decisions.md#d7--format-i-kody-błędów)); atrapy frontendu już tak odpowiadają |
| `trackingNumber` przed nadaniem paczki | w REST `null` w `PREPARING`, od `SHIPPED` tekst; w zdarzeniu otwarte ([events.md](events.md#otwarte-kwestie-kontraktu-v1)) — do potwierdzenia przez właściciela Shipping |
| Klucz idempotencji `POST /orders` (dwukrotne kliknięcie) | brak; frontend blokuje przycisk na czas wysyłania |
