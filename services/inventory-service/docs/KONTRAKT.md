# Kontrakt inventory-service

Pola JSON mają nazwy w camelCase. Usługa widzi ścieżki bez prefiksu `/api/v1`. Kontrakty z Product, Cart i Order wymagają potwierdzenia przy implementacji tych usług. Pełna specyfikacja OpenAPI: `/docs` i `/openapi.json`.

## Nagłówki

| Nagłówek | Kierunek | Znaczenie |
|---|---|---|
| `X-User-Id`, `X-User-Roles` | żądanie | Tożsamość i role (role oddzielone przecinkami, np. `SERVICE`). |
| `Authorization: Bearer <JWT>` | żądanie | Token weryfikowany kluczem z JWKS, gdy ustawione jest `JWT_JWKS_URL`. |
| `X-Request-Id` | żądanie i odpowiedź | Jeśli go brak, usługa generuje własny; trafia do logów i do błędów jako `requestId`. |
| `X-Instance-Id` | odpowiedź | Nazwa poda, który obsłużył żądanie. |

## Stan produktu

`GET /inventory/{productId}` — bez roli.

```json
{ "productId": 1001, "quantity": 10, "reserved": 3, "available": 7, "inStock": true }
```

`available = quantity - reserved`, a `inStock` to `available > 0`. Brak wpisu dla produktu: 404 `NOT_FOUND`. `productId` ≤ 0: 400 `VALIDATION_ERROR`.

`PUT /inventory/{productId}` — rola `ADMIN`.

```json
{ "quantity": 10 }
```

`quantity` to liczba całkowita 0–1 000 000. Odpowiedź 200 ma format jak wyżej; wpis jest tworzony, jeśli go nie było. Nowy stan mniejszy niż `reserved`: 409 `CONFLICT`.

## Rezerwacja

`POST /inventory/reservations` — rola `SERVICE`.

```json
{
  "orderId": "ord-123",
  "items": [
    { "productId": 1001, "quantity": 2 },
    { "productId": 1002, "quantity": 1 }
  ]
}
```

| Pole | Reguła |
|---|---|
| `orderId` | tekst, 1–64 znaków |
| `items` | lista 1–100 pozycji |
| `items[].productId` | liczba całkowita > 0 |
| `items[].quantity` | liczba całkowita 1–10 000 |

Odpowiedź 201 (nowa rezerwacja) albo 200 (powtórzone żądanie dla tego samego `orderId`):

```json
{
  "orderId": "ord-123",
  "status": "ACTIVE",
  "items": [
    { "productId": 1001, "quantity": 2 },
    { "productId": 1002, "quantity": 1 }
  ]
}
```

Reguły: powtórzone `productId` w jednym żądaniu są sumowane, a pozycje w odpowiedzi są posortowane rosnąco po `productId`. Rezerwacja jest atomowa, czyli wszystkie pozycje albo żadna. Powtórzone żądanie zwraca istniejącą rezerwację niezależnie od treści ciała. Rezerwacja zamówienia, które zostało już zwolnione, jest odrzucana. Produkt bez wpisu traktowany jest jak dostępny w ilości 0.

`DELETE /inventory/reservations/{orderId}` — rola `SERVICE`. Odpowiedź 204 bez ciała, także gdy zamówienie nie miało rezerwacji lub zostało już zwolnione.

## Zdarzenie order.cancelled

Exchange `shop.events` (topic), routing key `order.cancelled`, kolejka `inventory.q`, kolejka błędów `inventory.dlq`.

```json
{
  "eventId": "9f1c2e0a-0000-0000-0000-000000000001",
  "type": "order.cancelled",
  "occurredAt": "2026-11-08T10:00:00Z",
  "version": 1,
  "payload": { "orderId": "ord-123" }
}
```

Wymagane są `eventId`, `type` równy `order.cancelled` i `payload.orderId`; pozostałe pola (np. `items`) są ignorowane. Zdarzenia innych typów są pomijane. Po przetworzeniu wiadomość jest potwierdzana, a zwolnienie jest idempotentne względem `eventId`. Przy błędzie wiadomość wraca do kolejki z nagłówkiem `x-attempts`, a po trzeciej nieudanej próbie trafia do `inventory.dlq`. Usługa nie publikuje własnych zdarzeń.

## Health checki

| Ścieżka | Odpowiedź |
|---|---|
| `GET /health/live` | 200 `{"status": "UP"}` |
| `GET /health/ready` | 200 `{"status": "UP"}` albo 503, gdy baza nie odpowiada |

## Błędy

```json
{
  "status": 409,
  "error": "INSUFFICIENT_STOCK",
  "message": "Brak wystarczającej ilości towaru: produkt 1002 (dostępne 0, żądane 1)",
  "requestId": "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77"
}
```

| Kod | `error` | Kiedy |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Niepoprawne dane wejściowe lub parametr ścieżki |
| 401 | `UNAUTHORIZED` | Brak uwierzytelnienia lub nieprawidłowy token |
| 403 | `FORBIDDEN` | Brak wymaganej roli |
| 404 | `NOT_FOUND` | Brak stanu produktu (tylko GET) |
| 409 | `INSUFFICIENT_STOCK` | Za mały stan przy rezerwacji |
| 409 | `CONFLICT` | Stan poniżej zarezerwowanego lub rezerwacja zamówienia już zwolnionego |
| 503 | `SERVICE_UNAVAILABLE` | `/health/ready` przy niedostępnej bazie |
| 500 | `INTERNAL_ERROR` | Nieoczekiwany błąd usługi, np. brak połączenia z bazą |
