# cart-service — struktura kodu

## Dodanie pozycji

1. `routes.py` przyjmuje `POST /cart/items`. Pydantic sprawdza UUID oraz całkowitą ilość 1–999. Odrzuca `true`, ułamki i cenę podaną przez klienta.
2. `security.py` ustala właściciela na podstawie nagłówka z Gateway.
3. `CartService.change()` woła `CatalogClient.product()` i `available()`.
4. `discovery.py` pobiera zdrowe instancje z Consula. Listę zapamiętuje na 10 sekund i wybiera kolejne instancje round robin.
5. `catalog.py` wykonuje GET z timeoutem, ponowieniami i przekazaniem kontekstu. Do ról dodaje SERVICE. Nazwa i cena muszą mieć poprawny format.
6. Serwis odczytuje obecną pozycję. POST dodaje ilość, PATCH zastępuje ją. Porównuje docelową ilość z dostępnym stanem.
7. `store.py` wykonuje w Redisie skrypt Lua: porównuje poprzednią wartość, zapisuje nową i ustawia TTL atomowo.
8. Jeśli inny zapis zdążył zmienić pozycję, serwis odczytuje ją jeszcze raz i ponownie oblicza ilość. Po ośmiu konfliktach zwraca 409.
9. Odpowiedź zawiera aktualny koszyk, sumę oraz `inventoryChecked`, czyli informację, czy udało się sprawdzić stan magazynowy.

### Pliki Cart Service

Ścieżki względem `services/cart-service/`.

| Plik | Odpowiedzialność |
| --- | --- |
| `app/main.py` | Tworzy klientów Redis/httpx, discovery i serwis; zamyka zasoby przy wyłączeniu; health checki. |
| `app/config.py` | Port, Redis, Consul, identyfikator instancji i opcjonalne lokalne adresy zależności. |
| `app/schemas.py` | Modele żądań, pozycji i koszyka; aliasy JSON; funkcje przeliczania kwot. |
| `app/routes.py` | Endpointy koszyka. Wewnętrzne czyszczenie wymaga SERVICE. |
| `app/service.py` | Ilości, pobranie ceny, dostępność, sumy i rozwiązywanie konfliktów równoległych zmian. |
| `app/store.py` | Wyłącznie Redis: hash `cart:{userId}`, odczyt, atomowy zapis CAS, usuwanie, TTL i ping. |
| `app/catalog.py` | GET do Product i Inventory, walidacja odpowiedzi, retry oraz określone fallbacki. |
| `app/circuit_breaker.py` | Liczy wyniki ostatnich 10 wywołań, otwiera obwód przy 50% błędów i po 30 s pozwala na jedną próbę powrotu. |
| `app/discovery.py` | Rejestracja instancji, cache zdrowych adresów i round robin. |
| `app/security.py`, `app/http_support.py` | Te same zasady nagłówków, tożsamości, błędów i logowania co w User. |
| `tests/conftest.py` | Prawdziwy Redis w bazie nr 15 oraz atrapy HTTP Consula, Product i Inventory. |
| `tests/test_cart.py` | Testy API, cen, ilości, TTL, uprawnień, awarii i współbieżności. |
| `tests/test_resilience.py` | Testy circuit breakera, powrotu po awarii, pojedynczej próby half-open i discovery. |

### Obsługa operacji wejścia i wyjścia

Cart często czeka na sieć: Redis i usługi HTTP. Podczas `await` Python może obsługiwać inne żądania zamiast blokować cały proces. User korzysta z synchronicznego SQLAlchemy i endpointów `def`, które FastAPI wykonuje w puli wątków. Zapytania synchroniczne nie blokują dzięki temu pętli zdarzeń.

### Współbieżne zmiany koszyka

Oddzielny odczyt i zapis ilości mogą powodować utratę równoległych zmian. Na przykład dwa procesy mogą odczytać ilość 1 i oba zapisać 2 zamiast 3. Lua wykonuje porównanie oraz zapis jednym atomowym krokiem w Redisie, także między różnymi replikami aplikacji. Blokada w samym Pythonie nie wystarczyłaby do ochrony kilku replik.

### Pieniądze i TTL

Kwoty są przeliczane przez `Decimal` na całkowitą liczbę groszy. Cena `"19.99"` to 1999 groszy, a trzy sztuki dają `"59.97"`. Obliczenia nie korzystają z `float`.

TTL wynosi 604800 sekund od ostatniej zmiany. POST, PATCH i skuteczne usunięcie pozycji go odświeżają. GET nie odnawia ważności. Po usunięciu ostatniej pozycji Redis usuwa pusty hash; API zwraca wtedy pustą listę i `"0.00"`.

### Awaria zależności

| Sytuacja | Zachowanie |
| --- | --- |
| Product nie działa lub podaje niepoprawną cenę | 503, bez zapisu pozycji. |
| Produkt nie istnieje | 404, bez ponawiania. |
| Inventory potwierdza zbyt mały stan | 409. |
| Inventory nie działa | Dodanie dozwolone, `inventoryChecked:false`; rezerwację wykona Order. |
| Redis nie działa | 503, operacja zgłaszana jako nieudana. |

Circuit breaker jest osobny dla Product i Inventory. Liczy wynik całego wywołania wraz z ponowieniami. 404 jest wynikiem biznesowym, więc nie liczy się jako awaria. Ponowienia obejmują wyłącznie GET, a nie operacje zapisu.
