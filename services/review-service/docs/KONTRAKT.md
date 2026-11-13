# Kontrakt review-service

Pola JSON mają nazwy w camelCase. Usługa widzi ścieżki bez prefiksu `/api/v1`. Kontrakty z Product i Order wymagają potwierdzenia przy implementacji tych usług. Pełna specyfikacja OpenAPI: `/docs` i `/openapi.json`.

## Nagłówki

| Nagłówek | Kierunek | Znaczenie |
|---|---|---|
| `X-User-Id`, `X-User-Roles` | żądanie | Tożsamość i role (role oddzielone przecinkami, np. `CUSTOMER`). |
| `Authorization: Bearer <JWT>` | żądanie | Token weryfikowany kluczem z JWKS, gdy ustawione jest `JWT_JWKS_URL`. |
| `X-Request-Id` | żądanie i odpowiedź | Jeśli go brak, usługa generuje własny; trafia do logów i do błędów jako `requestId`. |
| `X-Instance-Id` | odpowiedź | Nazwa poda, który obsłużył żądanie. |

## Dodanie opinii

`POST /reviews` — wymaga zalogowanego użytkownika (dowolna rola, ale z identyfikatorem w `X-User-Id` lub w tokenie).

```json
{ "productId": 1001, "rating": 4, "comment": "Dobry produkt, polecam" }
```

| Pole | Reguła |
|---|---|
| `productId` | liczba całkowita > 0 |
| `rating` | liczba całkowita 1–5 |
| `comment` | opcjonalny tekst do 2000 znaków; spacje na brzegach są obcinane, pusty tekst zapisuje się jako `null` |

Autor opinii pochodzi zawsze z tożsamości, nigdy z treści żądania. Odpowiedź 201:

```json
{
  "id": "6af0625fe667b090b196e19a",
  "productId": 1001,
  "userId": "u1",
  "rating": 4,
  "comment": "Dobry produkt, polecam",
  "createdAt": "2026-11-08T11:51:59.200588Z"
}
```

Reguły: użytkownik może dodać jedną opinię o danym produkcie (druga daje 409), a opinię może dodać tylko ten, kto kupił produkt, co usługa sprawdza w Order Service (brak zakupu daje 403). Gdy zakupu nie da się zweryfikować, opinia nie jest zapisywana i usługa zwraca 503.

## Lista opinii

`GET /reviews?productId=1001&page=1&size=20` — bez roli.

| Parametr | Reguła |
|---|---|
| `productId` | wymagany, liczba całkowita > 0 |
| `page` | liczba całkowita ≥ 1, domyślnie 1 |
| `size` | liczba całkowita 1–100, domyślnie 20 |

```json
{
  "items": [
    {
      "id": "6af0625fe667b090b196e19a",
      "productId": 1001,
      "userId": "u1",
      "rating": 4,
      "comment": "Dobry produkt, polecam",
      "createdAt": "2026-11-08T11:51:59.200588Z"
    }
  ],
  "page": 1,
  "size": 20,
  "total": 1
}
```

Opinie są posortowane od najnowszych. Produkt bez opinii daje pustą listę `items` i `total: 0`.

## Średnia ocena

`GET /reviews/summary/{productId}` — bez roli; wołane przez Product Service.

```json
{ "productId": 1001, "averageRating": 4.33, "reviewCount": 3 }
```

`averageRating` jest zaokrąglana do dwóch miejsc po przecinku. Produkt bez opinii ma `"averageRating": null` i `"reviewCount": 0`. `productId` ≤ 0 daje 400.

## Usunięcie opinii

`DELETE /reviews/{id}` — wymaga zalogowanego użytkownika, który jest autorem opinii, albo roli `ADMIN`. Odpowiedź 204 bez ciała. Nieistniejące lub niepoprawne `id` daje 404, a cudza opinia przy braku roli `ADMIN` daje 403.

## Wywołanie Order Service

Przy dodawaniu opinii usługa wysyła do Order Service:

```
GET /orders/purchased?userId=<id użytkownika>&productId=<id produktu>
```

Oczekiwana odpowiedź 200 to `{"purchased": true}` albo `{"purchased": false}`; akceptowana jest też sama wartość `true` lub `false`. Usługa przekazuje nagłówki `Authorization` (jeśli były w żądaniu) i `X-Request-Id`. Adres instancji pochodzi z Consula (`order-service`), a gdy go brakuje, z `ORDER_SERVICE_URL`. Timeout wynosi 2 s, ponowienia (maksymalnie dwa) dotyczą błędów sieci i odpowiedzi 5xx, a po pięciu kolejnych błędach circuit breaker na 30 s odrzuca zapytania bez wołania Ordera. Odpowiedź 4xx, niepoprawny JSON lub nieoczekiwany format są traktowane jak brak możliwości weryfikacji i dają 503.

## Health checki

| Ścieżka | Odpowiedź |
|---|---|
| `GET /health/live` | 200 `{"status": "UP"}` |
| `GET /health/ready` | 200 `{"status": "UP"}` albo 503, gdy MongoDB nie odpowiada |

## Błędy

```json
{
  "status": 409,
  "error": "CONFLICT",
  "message": "Opinia o tym produkcie została już dodana",
  "requestId": "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77"
}
```

| Kod | `error` | Kiedy |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Niepoprawne dane wejściowe, brak `productId` w liście, ocena poza 1–5 |
| 401 | `UNAUTHORIZED` | Brak uwierzytelnienia, brak identyfikatora użytkownika lub nieprawidłowy token |
| 403 | `FORBIDDEN` | Użytkownik nie kupił produktu albo usuwa cudzą opinię bez roli `ADMIN` |
| 404 | `NOT_FOUND` | Opinia o podanym `id` nie istnieje |
| 409 | `CONFLICT` | Użytkownik już ocenił ten produkt |
| 503 | `SERVICE_UNAVAILABLE` | Nie można zweryfikować zakupu w Order Service albo `/health/ready` przy niedostępnej bazie |
| 500 | `INTERNAL_ERROR` | Nieoczekiwany błąd usługi, np. brak połączenia z bazą |
