# Kontrakt review-service

Pola JSON mają nazwy w camelCase. Usługa widzi ścieżki bez prefiksu `/api/v1`. Identyfikatory (`productId`, `id` opinii, `userId`) to UUID zapisany tekstem; usługa zapisuje i zwraca je małymi literami. Pełna specyfikacja OpenAPI: `/docs` i `/openapi.json`.

## Nagłówki

| Nagłówek | Kierunek | Znaczenie |
|---|---|---|
| `X-User-Id` | żądanie | UUID użytkownika, ustawiany przez Gateway; wartość niebędąca UUID daje 400. |
| `X-User-Roles` | żądanie | Role oddzielone przecinkami, np. `CUSTOMER` albo `ADMIN`; wielkość liter ma znaczenie. |
| `X-Request-Id` | żądanie i odpowiedź | Wartość spoza wzorca `^[A-Za-z0-9._-]{1,64}$` albo jej brak — usługa nadaje nowy UUID; trafia do logów i do błędów jako `requestId`. |
| `X-Instance-Id` | odpowiedź | ID instancji, która obsłużyła żądanie (w Kubernetesie nazwa poda). |

Usługa nie sprawdza tokenów; nagłówek `Authorization` jest ignorowany.

## Dodanie opinii

`POST /reviews` — wymaga zalogowanego użytkownika (`X-User-Id`, dowolna rola).

```json
{ "productId": "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77", "rating": 4, "comment": "Dobry produkt, polecam" }
```

| Pole | Reguła |
|---|---|
| `productId` | UUID tekstem (36 znaków z myślnikami); wielkie litery są zamieniane na małe |
| `rating` | liczba całkowita 1–5 (tekst `"4"`, `4.5` i `true` dają 400) |
| `comment` | opcjonalny tekst do 2000 znaków; spacje na brzegach są obcinane, pusty tekst zapisuje się jako `null` |

Inne pola w treści dają 400 `VALIDATION_ERROR`. Autor opinii pochodzi zawsze z `X-User-Id`, nigdy z treści żądania. Odpowiedź 201:

```json
{
  "id": "4bdd5850-aa51-4bee-965b-96c36f41bfbb",
  "productId": "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77",
  "userId": "5c9d1a7e-3b2f-4e8a-b6d4-1f0e9a8c7b65",
  "rating": 4,
  "comment": "Dobry produkt, polecam",
  "createdAt": "2026-11-14T17:22:35.441751Z"
}
```

Reguły: użytkownik może dodać jedną opinię o danym produkcie (druga daje 409), a opinię może dodać tylko ten, kto kupił produkt, co usługa sprawdza w Order Service (brak zakupu daje 403). Gdy zakupu nie da się zweryfikować, opinia nie jest zapisywana i usługa zwraca 503.

## Lista opinii

`GET /reviews?productId=3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77&page=1&size=20` — bez roli.

| Parametr | Reguła |
|---|---|
| `productId` | wymagany, UUID |
| `page` | liczba całkowita 1–1 000 000, domyślnie 1 |
| `size` | liczba całkowita 1–100, domyślnie 20 |

```json
{
  "items": [
    {
      "id": "4bdd5850-aa51-4bee-965b-96c36f41bfbb",
      "productId": "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77",
      "userId": "5c9d1a7e-3b2f-4e8a-b6d4-1f0e9a8c7b65",
      "rating": 4,
      "comment": "Dobry produkt, polecam",
      "createdAt": "2026-11-14T17:22:35.441000Z"
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
{ "productId": "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77", "averageRating": 4.33, "reviewCount": 3 }
```

`averageRating` jest zaokrąglana do dwóch miejsc po przecinku. Produkt bez opinii ma `"averageRating": null` i `"reviewCount": 0`. `productId` niebędący UUID daje 400.

## Usunięcie opinii

`DELETE /reviews/{reviewId}` — wymaga zalogowanego użytkownika, który jest autorem opinii, albo roli `ADMIN`. Odpowiedź 204 bez ciała. `reviewId` niebędący UUID daje 400, nieistniejąca opinia 404, a cudza opinia przy braku roli `ADMIN` 403.

## Wywołanie Order Service

Przy dodawaniu opinii usługa wysyła do Order Service (endpoint wewnętrzny, tylko rola `SERVICE`):

```
GET /orders/purchased?userId=<UUID użytkownika>&productId=<UUID produktu>
X-User-Id: <UUID użytkownika>
X-User-Roles: <role klienta>,SERVICE      (np. CUSTOMER,SERVICE)
X-Request-Id: <bieżący requestId>
```

Oczekiwana odpowiedź 200 to `{"purchased": true}` albo `{"purchased": false}`. Adres instancji pochodzi z Consula (`order-service`), a gdy go brakuje, z `ORDER_SERVICE_URL`. Zasady (D2):

| Wynik próby | Awaria dla wyłącznika | Ponowienie | Dodanie opinii |
|---|---|---|---|
| brak połączenia, timeout 2 s, 502, 503, 504 | tak | tak, najwyżej 2 razy (po 200 ms i 400 ms) | po ostatniej próbie 503 |
| 500 i inne 5xx, 408, 429 | tak | nie | 503 |
| 400, 401, 403, 404, 409 i inne 4xx | nie | nie | 503 (log `error`) |
| 200 niezgodne z kontraktem | nie liczy się | nie | 503 (log `error`) |
| wyłącznik otwarty, brak instancji | — (bez wywołania) | nie | 503 |

Wyłącznik otwiera się na 30 s, gdy co najmniej połowa z ostatnich 10 wywołań to awarie; potem przepuszcza jedno wywołanie próbne (sukces zamyka, awaria otwiera na kolejne 30 s).

## Health checki

| Ścieżka | Odpowiedź |
|---|---|
| `GET /health/live` | 200 `{"status": "UP"}` (bez bazy) |
| `GET /health/ready` | 200 `{"status": "UP"}` albo 503 `SERVICE_UNAVAILABLE`, gdy MongoDB nie odpowiada w 1,5 s |

## Błędy

```json
{
  "status": 409,
  "error": "CONFLICT",
  "message": "Opinia o tym produkcie została już dodana",
  "requestId": "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77"
}
```

Odpowiedź każdego błędu ma też nagłówek `X-Request-Id`.

| Kod | `error` | Kiedy |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Niepoprawne dane wejściowe: `productId`/`reviewId`/`X-User-Id` niebędący UUID, brak `productId` w liście, ocena poza 1–5 albo nie liczba całkowita, nieznane pole w treści |
| 401 | `UNAUTHORIZED` | Brak `X-User-Id` przy dodawaniu lub usuwaniu opinii |
| 403 | `FORBIDDEN` | Użytkownik nie kupił produktu albo usuwa cudzą opinię bez roli `ADMIN` |
| 404 | `NOT_FOUND` | Opinia o podanym `reviewId` nie istnieje |
| 409 | `CONFLICT` | Użytkownik już ocenił ten produkt |
| 503 | `SERVICE_UNAVAILABLE` | MongoDB nie odpowiada (każdy endpoint i `/health/ready`) albo nie można zweryfikować zakupu w Order Service |
| 500 | `INTERNAL_ERROR` | Nieoczekiwany błąd usługi (w logu klasa wyjątku i `requestId`) |
