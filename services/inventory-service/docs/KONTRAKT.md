# Kontrakt inventory-service

Pola JSON mają nazwy w camelCase. Usługa widzi ścieżki bez prefiksu `/api/v1`. Kontrakty z Product, Cart i Order wymagają potwierdzenia przy implementacji tych usług. Ścieżka z `/` na końcu daje 404 (bez przekierowania), a `GET /inventory/{productId}` odpowiada też na `HEAD`. Pełna specyfikacja OpenAPI: `/docs` i `/openapi.json`.

## Nagłówki

| Nagłówek | Kierunek | Znaczenie |
|---|---|---|
| `X-User-Id`, `X-User-Roles` | żądanie | Tożsamość ustawiana przez Gateway. `X-User-Id` to UUID (inna wartość daje 400 `VALIDATION_ERROR`). `X-User-Roles` to lista oddzielona przecinkami (np. `CUSTOMER,SERVICE`); role są zbiorem, a wielkość liter ma znaczenie. Wołająca usługa dopisuje do ról `SERVICE`. |
| `X-Request-Id` | żądanie i odpowiedź | Przyjmowany, gdy pasuje do `^[A-Za-z0-9._-]{1,64}$`, w przeciwnym razie usługa generuje UUID. Trafia do logów i do błędów jako `requestId`. Odpowiedź każdego błędu, także 503 i 500, zawiera ten nagłówek. |
| `X-Instance-Id` | odpowiedź | Nazwa poda, który obsłużył żądanie. |

## Stan produktu

`GET /inventory/{productId}` — bez roli.

```json
{ "productId": "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77", "quantity": 10, "reserved": 3, "available": 7, "inStock": true }
```

`available = quantity - reserved`, a `inStock` to `available > 0`. Brak wpisu dla produktu: 404 `NOT_FOUND`. Niepoprawny UUID w ścieżce lub w treści: 400 `VALIDATION_ERROR`. Wielkie litery w UUID są zamieniane na małe.

`PUT /inventory/{productId}` — rola `ADMIN`.

```json
{ "quantity": 10 }
```

`quantity` to liczba całkowita 0–1 000 000; nieznane pola w treści dają 400 `VALIDATION_ERROR`. Odpowiedź 200 ma format jak wyżej; wpis jest tworzony, jeśli go nie było. Nowy stan mniejszy niż `reserved`: 409 `CONFLICT`.

## Rezerwacja

`POST /inventory/reservations` — rola `SERVICE`.

```json
{
  "orderId": "ord-123",
  "items": [
    { "productId": "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77", "quantity": 2 },
    { "productId": "7d2b4c10-1e55-4f0a-8a31-5c6e9b0d2f44", "quantity": 1 }
  ]
}
```

| Pole | Reguła |
|---|---|
| `orderId` | tekst, 1–64 znaków |
| `items` | lista 1–100 pozycji |
| `items[].productId` | UUID zapisany tekstem (liczba jest odrzucana) |
| `items[].quantity` | liczba całkowita 1–10 000 |

Odpowiedź 201 (nowa rezerwacja) albo 200 (powtórzone żądanie dla tego samego `orderId`):

```json
{
  "orderId": "ord-123",
  "status": "ACTIVE",
  "items": [
    { "productId": "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77", "quantity": 2 },
    { "productId": "7d2b4c10-1e55-4f0a-8a31-5c6e9b0d2f44", "quantity": 1 }
  ]
}
```

Reguły: powtórzone `productId` w jednym żądaniu są sumowane, a pozycje w odpowiedzi są posortowane rosnąco po `productId`. Rezerwacja jest atomowa, czyli wszystkie pozycje albo żadna. Powtórzone żądanie zwraca istniejącą rezerwację niezależnie od treści ciała. Rezerwacja zamówienia, które zostało już zwolnione, jest odrzucana. Produkt bez wpisu traktowany jest jak dostępny w ilości 0.

`DELETE /inventory/reservations/{orderId}` — rola `SERVICE`. Odpowiedź 204 bez ciała, także gdy zamówienie nie miało rezerwacji lub zostało już zwolnione.

## Zdarzenia

Odbiór z kolejki `inventory.q`. Kolejki, `inventory.dlq` i bindingi tworzy wspólna konfiguracja, a usługa tylko czyta. Koperta jest wspólna:

```json
{
  "eventId": "9f1c2e0a-0000-0000-0000-000000000001",
  "type": "order.cancelled",
  "occurredAt": "2026-11-08T10:00:00Z",
  "version": 1,
  "requestId": "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77",
  "payload": { "orderId": "ord-123" }
}
```

| `type` (= klucz routingu) | Wymagane w `payload` | Skutek |
|---|---|---|
| `order.cancelled` | `orderId` | Zwolnienie rezerwacji `ACTIVE` tego zamówienia |
| `shipment.status_changed` | `orderId`, `newStatus` | Przy `SHIPPED`: dla rezerwacji `ACTIVE` maleją `quantity` i `reserved`, rezerwacja dostaje status `ISSUED`; inne statusy bez zmian |

Walidacja koperty: `eventId`, `type`, `orderId` i `newStatus` muszą być niepustym tekstem, `version` równa 1, `payload` obiektem, a `type` musi być równy kluczowi routingu. Każda niezgodność (także zły JSON) powoduje natychmiastowe odrzucenie bez ponowień. Przetwarzanie jest idempotentne względem `eventId`. Błąd chwilowy jest ponawiany w procesie (po 5 s, potem po 30 s); po trzeciej nieudanej próbie wiadomość jest odrzucana (`nack` bez ponownego kolejkowania), a broker przenosi ją do `inventory.dlq`. Rezerwacja wydana przy wysyłce nie jest zwalniana przez późniejsze `order.cancelled`. Usługa nie publikuje własnych zdarzeń, a w logach nie zapisuje danych z `payload`.

## Health checki

| Ścieżka | Odpowiedź |
|---|---|
| `GET /health/live` | 200 `{"status": "UP"}` |
| `GET /health/ready` | 200 `{"status": "UP"}` albo 503, gdy baza nie odpowiada lub zakończyło pracę zadanie odbiorcy zdarzeń. Utrata połączenia z RabbitMQ nie zmienia gotowości. |

## Błędy

```json
{
  "status": 409,
  "error": "INSUFFICIENT_STOCK",
  "message": "Brak wystarczającej ilości towaru: produkt 7d2b4c10-1e55-4f0a-8a31-5c6e9b0d2f44 (dostępne 0, żądane 1)",
  "requestId": "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77"
}
```

| Kod | `error` | Kiedy |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Niepoprawne dane wejściowe, parametr ścieżki lub `X-User-Id` niebędący UUID |
| 401 | `UNAUTHORIZED` | Brak `X-User-Id` w endpoincie wymagającym logowania (`PUT`) |
| 403 | `FORBIDDEN` | Brak wymaganej roli: `ADMIN` dla `PUT`, `SERVICE` dla rezerwacji i zwolnienia (w endpointach wewnętrznych także bez nagłówków) |
| 404 | `NOT_FOUND` | Brak stanu produktu (tylko GET) |
| 409 | `INSUFFICIENT_STOCK` | Za mały stan przy rezerwacji |
| 409 | `CONFLICT` | Stan poniżej zarezerwowanego lub rezerwacja zamówienia już zwolnionego |
| 503 | `SERVICE_UNAVAILABLE` | Błąd połączenia z bazą w dowolnym endpoincie, `/health/ready` przy niedostępnej bazie lub zakończonym odbiorcy zdarzeń |
| 500 | `INTERNAL_ERROR` | Nieoczekiwany błąd usługi |

## Do potwierdzenia z zespołem

* `productId` jest UUID zapisanym tekstem, a `orderId` tekstem do 64 znaków.
* Order używa tokenu technicznego z rolą `SERVICE`; token klienta z rolą CUSTOMER dostanie 403.
* Product i Cart zakładają 404 dla produktu bez wpisu.
* Zdarzenie `shipment.status_changed` ma w `payload` pola `orderId` i `newStatus` (wartość `SHIPPED` oznacza wydanie towaru); koperta zawiera `version: 1`.
