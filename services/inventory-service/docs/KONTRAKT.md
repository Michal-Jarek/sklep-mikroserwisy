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

`quantity` to liczba całkowita 0–1 000 000 (`true`, `"10"` i `1.5` dają 400); nieznane pola w treści dają 400 `VALIDATION_ERROR`. Odpowiedź 200 ma format jak wyżej; wpis jest tworzony, jeśli go nie było. Nowy stan mniejszy niż `reserved`: 409 `CONFLICT`.

## Rezerwacja

`POST /inventory/reservations` — rola `SERVICE`.

```json
{
  "orderId": "5b8e2f1a-3c4d-4e6f-8a9b-0c1d2e3f4a5b",
  "items": [
    { "productId": "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77", "quantity": 2 },
    { "productId": "7d2b4c10-1e55-4f0a-8a31-5c6e9b0d2f44", "quantity": 1 }
  ]
}
```

| Pole | Reguła |
|---|---|
| `orderId` | UUID zapisany tekstem; wielkie litery są zamieniane na małe (ten sam UUID wielkimi literami to ta sama rezerwacja) |
| `items` | lista 1–100 pozycji |
| `items[].productId` | UUID zapisany tekstem (liczba jest odrzucana) |
| `items[].quantity` | liczba całkowita 1–10 000 (`true`, `"10"` i `1.5` są odrzucane) |

Nieznane pole w treści albo w pozycji daje 400 `VALIDATION_ERROR`.

Odpowiedź 201 (nowa rezerwacja) albo 200 (powtórzone żądanie dla tego samego `orderId`):

```json
{
  "orderId": "5b8e2f1a-3c4d-4e6f-8a9b-0c1d2e3f4a5b",
  "status": "ACTIVE",
  "items": [
    { "productId": "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77", "quantity": 2 },
    { "productId": "7d2b4c10-1e55-4f0a-8a31-5c6e9b0d2f44", "quantity": 1 }
  ]
}
```

Reguły: powtórzone `productId` w jednym żądaniu są sumowane, a pozycje w odpowiedzi są posortowane rosnąco po `productId`. Rezerwacja jest atomowa, czyli wszystkie pozycje albo żadna. Powtórzone żądanie zwraca istniejącą rezerwację niezależnie od treści ciała. Rezerwacja zamówienia, które zostało już zwolnione, jest odrzucana. Produkt bez wpisu traktowany jest jak dostępny w ilości 0.

`DELETE /inventory/reservations/{orderId}` — rola `SERVICE`. `orderId` to UUID (wielkie litery są zamieniane na małe, niepoprawny daje 400 `VALIDATION_ERROR`). Odpowiedź 204 bez ciała, także gdy zamówienie nie miało rezerwacji lub zostało już zwolnione.

## Zdarzenia

Odbiór z kolejki `inventory.q`. Kolejki, `inventory.dlq` i bindingi tworzy wspólna konfiguracja, a usługa tylko czyta. Koperta jest wspólna:

```json
{
  "eventId": "9f1c2e0a-0000-0000-0000-000000000001",
  "type": "order.cancelled",
  "occurredAt": "2026-11-08T10:00:00Z",
  "version": 1,
  "requestId": "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77",
  "payload": { "orderId": "5b8e2f1a-3c4d-4e6f-8a9b-0c1d2e3f4a5b" }
}
```

| `type` (= klucz routingu) | Wymagane w `payload` | Skutek |
|---|---|---|
| `order.cancelled` | `orderId` | Zwolnienie rezerwacji `ACTIVE` tego zamówienia |
| `shipment.status_changed` | `orderId`, `newStatus` | Przy `SHIPPED`: dla rezerwacji `ACTIVE` maleją `quantity` i `reserved`, rezerwacja dostaje status `ISSUED`; inne statusy bez zmian |

Walidacja koperty: `eventId` i `orderId` muszą być UUID (zapisywane małymi literami), `type` i `newStatus` niepustym tekstem, `version` równa 1, `payload` obiektem, a `type` musi być równy kluczowi routingu. Każda niezgodność (także zły JSON i każdy inny wyjątek przy odczycie koperty) powoduje natychmiastowe odrzucenie bez ponowień. `requestId` niepasujący do `^[A-Za-z0-9._-]{1,64}$` (albo brak `requestId`) nie odrzuca zdarzenia: w logach zastępuje go nowy UUID. Przetwarzanie jest idempotentne względem `eventId`. Błąd chwilowy jest ponawiany w procesie (po 5 s, potem po 30 s, każdy odstęp z losowym dodatkiem do +50 %); po trzeciej nieudanej próbie wiadomość jest odrzucana (`nack` bez ponownego kolejkowania), a broker przenosi ją do `inventory.dlq`. Rezerwacja wydana przy wysyłce nie jest zwalniana przez późniejsze `order.cancelled`. Usługa nie publikuje własnych zdarzeń, a w logach nie zapisuje danych z `payload`.

## Health checki

| Ścieżka | Odpowiedź |
|---|---|
| `GET /health/live` | 200 `{"status": "UP"}` |
| `GET /health/ready` | 200 `{"status": "UP"}` albo 503, gdy baza nie odpowiada w 1,5 s lub zakończyło pracę zadanie odbiorcy zdarzeń (tylko przy błędzie programu). Utrata połączenia z RabbitMQ i brak kolejki nie zmieniają gotowości. |

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
| 503 | `SERVICE_UNAVAILABLE` | Błąd połączenia z bazą, baza bez odpowiedzi w 2 s albo brak wolnego połączenia z puli w 2 s w dowolnym endpoincie, `/health/ready` przy niedostępnej bazie lub zakończonym odbiorcy zdarzeń |
| 500 | `INTERNAL_ERROR` | Nieoczekiwany błąd usługi |

## Do potwierdzenia z zespołem

* `productId` i `orderId` są UUID zapisanym tekstem (małymi literami).
* Order woła rezerwacje z nagłówkami `X-User-Id` i `X-User-Roles` klienta z dopisaną rolą `SERVICE` (np. `CUSTOMER,SERVICE`); bez roli `SERVICE` (np. sam `CUSTOMER`) odpowiedź to 403. Tokenów usługa nie sprawdza.
* Product i Cart zakładają 404 dla produktu bez wpisu.
* Zdarzenie `shipment.status_changed` ma w `payload` pola `orderId` i `newStatus` (wartość `SHIPPED` oznacza wydanie towaru); koperta zawiera `version: 1`.
