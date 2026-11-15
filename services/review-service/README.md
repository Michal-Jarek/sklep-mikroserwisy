# Review Service

Oceny i opinie o produktach oraz średnia ocena produktu.

| | |
|---|---|
| Właściciel | Aleksandra Krzeszewska |
| Technologia | Python 3.12 · FastAPI · MongoDB |
| Port | 8088 |
| Nazwa w Consulu, Kubernetesie i obrazie Docker | `review-service` |
| Namespace Kubernetes | `shop` |
| Health checki | `/health/live`, `/health/ready` |
| Dokumentacja API | `/docs` |

## Zakres

Usługa przechowuje w MongoDB (`review_db`, kolekcja `product_reviews`) opinie o produktach: ocenę 1–5 i opcjonalny komentarz do 2000 znaków. Identyfikatory produktu (`productId`) i opinii (`id`, w bazie `_id`) to UUID zapisany tekstem; wielkie litery są zamieniane na małe. Opinię może dodać tylko użytkownik, który kupił produkt (usługa pyta Order Service), i najwyżej jedną o danym produkcie. Unikalny indeks `uq_product_user` (`productId`, `userId`) chroni przed duplikatem także przy równoległych żądaniach, a indeks `ix_product_created` służy liście opinii. Średnia ocena i liczba opinii są liczone agregacją MongoDB.

| Metoda | Ścieżka | Kto | Znaczenie |
|---|---|---|---|
| GET | `/reviews?productId=&page=&size=` | Gateway | Lista opinii od najnowszych: `items`, `page`, `size`, `total`; `productId` jest wymagany; `page` 1–1 000 000, `size` 1–100; 400, gdy `productId` nie jest UUID albo `page`/`size` są poza zakresem |
| POST | `/reviews` | zalogowany użytkownik | `{productId, rating, comment}`; 201, 403 gdy nie kupił produktu, 409 gdy już ocenił, 503 gdy nie można sprawdzić zakupu; 400, gdy `productId` nie jest UUID, `rating` nie jest liczbą całkowitą 1–5 albo treść ma nieznane pole |
| DELETE | `/reviews/{reviewId}` | autor lub ADMIN | Usunięcie opinii; 204, 403 dla cudzej opinii, 404 gdy nie istnieje, 400 gdy `reviewId` nie jest UUID |
| GET | `/reviews/summary/{productId}` | Product | `{productId, averageRating, reviewCount}`; bez opinii `averageRating` jest `null`; 400, gdy `productId` nie jest UUID |

Błędy mają format `{"status", "error", "message", "requestId"}`, a odpowiedź każdego błędu zawiera nagłówek `X-Request-Id`. Gateway udostępnia endpointy pod `/api/v1/...`, usługa widzi ścieżki bez prefiksu.

## Uruchomienie lokalne

Całość sklepu (z MongoDB i Consulem) uruchamia się z katalogu głównego repozytorium według [deploy/README.md](../../deploy/README.md): najpierw `bash deploy/create-secrets.sh` (hasła w `deploy/.env`), potem `docker compose -f deploy/compose.yaml --profile full-shop up -d --wait --build`. Review jest wtedy dostępny przez Gateway pod `/api/v1/reviews...`.

Bez kontenera aplikacji, z działającą MongoDB i atrapą Order Service. Wymagany Python 3.12 (na macOS polecenie `python3`; w aktywnym środowisku `.venv` wystarczy `python`):

```
cd services/review-service
python3 -m venv .venv
# Linux/macOS: source .venv/bin/activate
# PowerShell: .\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
python tests/mock_order_service.py
```

Atrapa Order Service nasłuchuje na porcie 8086 i uznaje każdy produkt za kupiony poza `productId=99999999-9999-4999-8999-999999999999`. Zostaw ją w osobnym oknie, a w drugim uruchom usługę:

```
export MONGODB_URL=mongodb://review_service:<haslo>@localhost:27017/review_db?authSource=review_db
export ORDER_SERVICE_URL=http://localhost:8086
export CONSUL_ENABLED=false
uvicorn app.main:app --host 127.0.0.1 --port 8088 --reload --no-access-log
```

`MONGODB_URL` jest wymagany, a indeksy są zakładane przy starcie. Domyślny Consul: `http://consul:8500`, dlatego bez infrastruktury lokalnie `CONSUL_ENABLED=false`, a adres Order Service podaje `ORDER_SERVICE_URL`. Przy infrastrukturze z Docker Compose usługa z VS Code rejestruje się w Consulu po ustawieniu `CONSUL_HOST=127.0.0.1` i `SERVICE_ADDRESS=host.docker.internal` (Consul w kontenerze sprawdza `/health/ready` pod tym adresem), a serwer nasłuchuje na `127.0.0.1`.

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `MONGODB_URL` | — (wymagana) | adres MongoDB z użytkownikiem usługi; zawiera hasło, nie trafia do logów |
| `MONGODB_DATABASE` | `review_db` | nazwa bazy |
| `SERVICE_PORT` | `8088` | port rejestrowany w Consulu |
| `SERVICE_ADDRESS` | własny adres IP | adres rejestrowany w Consulu (w Kubernetesie adres poda) |
| `INSTANCE_ID` | `review-service-<hostname>` | pełne ID instancji w Consulu i w nagłówku `X-Instance-Id` (w Kubernetesie nazwa poda) |
| `LOG_LEVEL` | `info` albo `logLevel` z Consul KV | poziom logów usługi; zmienna ma pierwszeństwo przed KV |
| `CONSUL_ENABLED`, `CONSUL_HOST`, `CONSUL_PORT` | `true`, `consul`, `8500` | Consul (rejestracja, KV, adres Order Service) |
| `ORDER_SERVICE_NAME` | `order-service` | nazwa Order Service w Consulu |
| `ORDER_SERVICE_URL` | pusty | adres zapasowy Order Service, gdy Consul jest wyłączony albo nie zna instancji |
| `HTTP_TIMEOUT_SECONDS` | `2` | timeout jednej próby wywołania Order Service |

Nazwy zmiennych są też w `.env.example`. Tożsamość jest odczytywana z nagłówków `X-User-Id` (UUID) i `X-User-Roles` (lista oddzielona przecinkami, wielkość liter ma znaczenie), np. `X-User-Id: 5c9d1a7e-3b2f-4e8a-b6d4-1f0e9a8c7b65` i `X-User-Roles: CUSTOMER` przy dodawaniu opinii z Postmana.

Bez działającej MongoDB usługa nie wystartuje. Gdy baza przestanie odpowiadać później, operacje zwracają 503 `SERVICE_UNAVAILABLE` najpóźniej po ok. 1,5 s (wybór serwera 1 s, połączenie 1 s, brak odpowiedzi na otwartym połączeniu 1,5 s, bez ponawiania odczytu przez sterownik), a `/health/ready` odpowiada 503 po 1,5 s. `/health/live` nie korzysta z bazy i odpowiada od razu. Po powrocie bazy usługa działa dalej bez restartu.

## Testy

Z katalogu `services/review-service`, po instalacji zależności deweloperskich:

```
python -m pytest -q
```

Testy działają na `mongomock`, a Order Service jest zastępowany atrapą klienta i transportem testowym httpx, więc nie potrzebują MongoDB, Consula ani Order Service. Obejmują dodawanie i walidację opinii (UUID, nieznane pola, `rating` tylko jako liczba całkowita), nagłówki przekazywane do Order, uprawnienia, duplikaty, listę, średnią, usuwanie, 503 przy błędach MongoDB, klienta Order (ponowienia, które odpowiedzi są awarią), wyłącznik (stany, okno 10 wywołań, wywołanie próbne po 30 s z podmienionym zegarem, praca z wielu wątków), ponowną rejestrację w Consulu, odczyt konfiguracji z Consul KV i logi JSON. Unikalny indeks jest sprawdzany tylko na `mongomock`.

Kolekcję Postman (`postman/review-service.postman_collection.json`) uruchamia się w Postmanie (Runner, po kolei) albo przez newman, przy usłudze dostępnej pod `http://localhost:8088` (zmienna kolekcji `baseUrl`) i atrapie Order Service. Kolekcja woła usługę bezpośrednio i sama ustawia nagłówki `X-User-*`. Każdy przebieg tworzy nowy `productId`, więc kolekcję można uruchamiać wielokrotnie:

```
npx newman run postman/review-service.postman_collection.json --env-var baseUrl=http://localhost:8088
```

## Zależności i wdrożenie

Review woła wyłącznie Order Service, przy dodawaniu opinii: `GET /orders/purchased?userId=&productId=` z nagłówkami klienta (`X-User-Id`, `X-User-Roles` = role klienta i `SERVICE`, np. `CUSTOMER,SERVICE`, oraz `X-Request-Id`); oczekiwana odpowiedź to `{"purchased": true|false}`. Adres `order-service` pochodzi z Consula (lista zdrowych instancji przechowywana 10 s, wybierana po kolei). Pusta lista z Consula (np. tuż po jego restarcie, zanim checki przejdą) nie jest zapamiętywana; dopóki Consul zwraca pustą listę najwyżej 30 s bez przerwy, Review używa ostatniej niepustej, a awaria Consula tej listy nie postarza. Gdy zapytanie do Consula się nie uda (np. zawieszony Consul), ostatnia lista jest używana przez kolejne 10 s bez ponownego pytania, więc ponowienia wywołania Order nie czekają znowu 2 s na Consula. Przy przerywanych błędach Consula ostatnia lista może działać dłużej niż 30 s: błąd nie zaczyna serii pustych odpowiedzi od nowa, ale po każdym błędzie ostatnia lista wraca na 10 s, także gdy seria przekroczyła już 30 s. Brak instancji (503) dopiero po dłuższej serii pustych odpowiedzi albo gdy żadnej listy nie było. Jedna próba ma timeout 2 s; po braku połączenia, timeoucie, 502, 503 i 504 są najwyżej dwa ponowienia (po 200 ms i 400 ms). Wyłącznik (`app/circuit_breaker.py`, zasada D2) liczy jako awarię tylko brak połączenia, timeout, 5xx, 408 i 429; inne odpowiedzi 4xx (np. 403) to odpowiedź działającej usługi i nie otwierają go. Gdy co najmniej połowa z ostatnich 10 wywołań to awarie, wyłącznik jest otwarty przez 30 s i usługa od razu zwraca 503; potem przepuszcza jedno wywołanie próbne. Wyłącznik nie trzyma blokady na czas wywołania. Gdy zakupu nie da się sprawdzić (awaria, odmowa Order, odpowiedź niezgodna z kontraktem, brak instancji), dodanie opinii kończy się 503.

Review rejestruje się w Consulu jako `review-service` z ID `INSTANCE_ID` (pełne ID, w Kubernetesie nazwa poda) albo `review-service-<hostname>`, adresem `SERVICE_ADDRESS` albo własnym adresem IP i health checkiem `/health/ready` co 10 s; stan początkowy checku (`passing` albo `critical`) wynika ze sprawdzenia bazy. Wpis z tym samym ID pozostały po poprzednim procesie zatrzymanym bez wyrejestrowania usługa przy starcie najpierw usuwa, bo Consul przy ponownej rejestracji zachowuje stary stan checku. Przy tej pierwszej rejestracji usuwa też wpisy `review-service` z tym samym adresem i portem, ale innym ID (np. kontener w compose zabity i utworzony od nowa dostaje nowe ID i zwykle ten sam IP); błąd tego sprzątania kończy się ostrzeżeniem w logu i nie blokuje rejestracji. Co ok. 15 s sprawdza, czy wpis istnieje z aktualnym adresem, i rejestruje się ponownie, gdy go nie ma (np. Consul usunął instancję po dłuższej awarii bazy), a przy zatrzymaniu się wyrejestrowuje. Przy starcie czyta z Consul KV klucz `config/review-service/data` (dokument YAML, pole `logLevel`: `debug`, `info`, `warning` lub `error`); zmienna `LOG_LEVEL` ma pierwszeństwo, a start bez Consula jest dozwolony.

Logi to jedna linia JSON na wpis (`time`, `level`, `service`, `requestId`, `userId`, `msg`); przy wyjątku tylko jego klasa i miejsca w kodzie, bez treści. Biblioteki (`uvicorn`, `httpx`, `pymongo`) zapisują tylko ostrzeżenia i błędy.

Wdrożenie w klastrze robi platforma (`deploy/k8s/services/review-service.yaml`, sekret tworzy `deploy/k8s/secrets.sh`, całość `bash deploy/k8s/up.sh`). Manifesty w folderze `k8s/` są wzorem — nie aplikuj ich w namespace `shop`.

## Przejście ze starej wersji

Wcześniejsza wersja zapisywała opinie w kolekcji `reviews` z `productId` liczbowym i `_id` typu ObjectId. Ta wersja używa nowej kolekcji `product_reviews` (z indeksami `uq_product_user` i `ix_product_created`), którą zakłada sama przy starcie, więc istniejąca baza `review_db` nie wymaga ręcznych kroków. Stare opinie nie są przenoszone. Usługa nie czyta i nie usuwa kolekcji `reviews`; jej usunięcie opisuje [deploy/README.md](../../deploy/README.md) (w klastrze robi to platforma).

## Pliki

* `app/` — kod aplikacji.
* `tests/` — testy pytest oraz atrapa Order Service do ręcznych testów.
* `Dockerfile`, `.dockerignore`, `.env.example`, `requirements*.txt` — obraz, nazwy zmiennych i zależności.
* `k8s/` — wzór manifestów tej usługi (ConfigMap, Deployment, Service); wdrożenie w klastrze jest w `deploy/k8s/`.
* `postman/` — kolekcja Postman tej usługi.
* [docs/OPIS-KODU.md](docs/OPIS-KODU.md) — odpowiedzialność plików, przepływ dodania opinii, współbieżność i zachowanie przy awariach.
* [docs/KONTRAKT.md](docs/KONTRAKT.md) — pola JSON, odpowiedzi i wywołanie Order Service.
* [docs/INTEGRACJA.md](docs/INTEGRACJA.md) — wymagania wspólnej infrastruktury.

Tożsamość jest przekazywana wyłącznie w nagłówkach z zaufanego Gateway (usługa nie sprawdza tokenów). W klastrze niezbędne są ograniczenia ruchu sieciowego (NetworkPolicy po stronie infrastruktury). Usługa nie jest publicznym punktem wejścia do sklepu.

Wyniki sprawdzenia: [docs/WERYFIKACJA.md](docs/WERYFIKACJA.md).
