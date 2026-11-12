# PR #1 — poprawki User i Cart

## Zakres PR

Wyłącznie `services/user-service/` oraz `services/cart-service/`. Brak zmian w Product, Inventory, Auth, Gateway, wspólnym deploy, CODEOWNERS i głównych dokumentach repo.

## Poprawki

- Bezpieczne obrazy: kopiowanie tylko kodu i migracji, `.dockerignore` obejmujący zagnieżdżone `.env`, Python 3.12.14, UID 1000, port z `PORT`.
- Odzyskiwanie rejestracji w Consulu co 15 s, start bez Consula, odczyt `logLevel` z KV z priorytetem env nad KV, cache ostatnich znanych adresów bez wspólnej blokady na HTTP.
- Klasyfikacja błędów zgodna z D2: brak ponowień i otwierania obwodu po zwykłych 4xx lub niezgodnej odpowiedzi 2xx. Ponowienia po błędach sieci, timeout i 502/503/504. 408/429/pozostałe 5xx liczą się do obwodu, bez ponowień.
- Product/Inventory odczytywane równolegle przez Cart; termin 8 s na całą zmianę koszyka; PATCH nieistniejącej pozycji daje 404 przed wywołaniem zależności.
- Idempotentny POST `/users`: 201 przy utworzeniu, 200 przy tym samym ID i danych, 409 przy innych danych tego samego ID, także przy równoległych ponowieniach Auth. Email jest tekstem do 254 znaków — format i unikalność utrzymuje Auth. Migracja `0002` usuwa unikalność emaila bez usuwania profili.
- Limity PostgreSQL: połączenie, zapytania, blokady, keepalive i TCP; liveness asynchroniczny bez zależności od bazy.
- Logi JSON z requestId, userId, ścieżką, poziomem i typem błędu, bez treści wyjątków i danych profilu.
- Utwardzenie manifestów User/Cart: readOnlyRootFilesystem, RuntimeDefault, brak tokenu ServiceAccount. Job migracji ma osobną etykietę.
- Wewnętrzne endpointy bez SERVICE dają 403; zdublowane nagłówki tożsamości dają 400. HEAD ma te same reguły co GET; końcowy slash nie przekierowuje. Kody błędów zgodne z D7.
- Stabilna kolejność adresów i limit 50 na profil (migracja `0003`). Kolekcja Postman User działa przy wielokrotnym uruchomieniu.
- Walidacja pełnej migawki koszyka przed atomowym CAS, brak częściowego zapisu przy uszkodzonym Redisie, do 64 prób z krótkim losowym odstępem, nadal w terminie 8 s.
- FastAPI 0.121.3, Starlette 0.49.3, PyYAML; locki z hashami. Brak tworzenia połączeń przy imporcie.

## Kontrakty zależności

Cart korzysta z istniejących ustaleń repo D1–D4: UUID produktu, nazwa do 200 znaków, cena tekstem z dwoma miejscami po kropce i `currency: PLN`, stan w `available`. 404 Inventory oznacza zero sztuk; awaria lub niezgodny kontrakt daje `inventoryChecked:false`. To zmiany obsługi po stronie Cart — pliki Product i Inventory nie zostały zmienione. Pełny zakup wymaga ich działających implementacji i rezerwacji w Order.

## Wpięcie przez właściciela wspólnej konfiguracji

Po akceptacji PR należy dodać kontenery User, migracji User i Cart do wspólnego Compose, wskazać istniejące `user_db`/`user_service` oraz `redis-cart`, a następnie włączyć `USER_SERVICE_ENABLED=true` w Auth. Migracje muszą zakończyć się przed startem User. Propozycje NetworkPolicy są w dokumentacji usług; Job migracji potrzebuje osobnej reguły egress do DNS i PostgreSQL. W tym PR nie ma zmian `deploy/`.

## Weryfikacja

- User: 22/22 na PostgreSQL 17 i 22/22 na SQLite.
- Cart: 57/57 na Redisie 7.4, w tym 20 współbieżnych dodań, klasyfikacja błędów, KV/rejestracja, uszkodzone dane bez częściowego zapisu i anulowanie prób wyłącznika.
- Oba obrazy zbudowane, uruchomione jako UID 1000 z systemem plików tylko do odczytu; brak `.env`, `.venv` i testów w obrazie.
- Kolekcja Postman User: dwa uruchomienia z rzędu, za każdym razem 7 żądań i 7 asercji, bez błędów.
- Prawdziwy Consul: odzyskanie ręcznie usuniętej rejestracji; start User bez Consula.
- PostgreSQL: `pg_sleep(5)` przerwane po ok. 2,02 s.
- W osobnym, lokalnym zestawie testowym sprawdzono istniejące Auth/Gateway z tymi usługami: rejestracja, profil, logowanie, własny koszyk, zastępowanie podrobionych nagłówków i blokowanie endpointów wewnętrznych. Konfiguracja tego zestawu nie wchodzi do PR. Testy istniejącego Gateway 449/449 i Auth 224/224 także przeszły.
- Manifesty Kubernetes sprawdzone jako YAML wraz z kontekstami bezpieczeństwa; bez wdrożenia w klastrze.

Nie dostarczono `laboratory-2026Z.pdf`, więc wymagania prowadzącego dotyczącego Spring Boot nie można zweryfikować. Zachowano obecną technologię usług. Historia oryginalnego commita pozostaje bez zmian. Nie publikowano do zdalnego repo.


## Ponowny audyt wymagań Michała

Sprawdzono paczkę PR względem uwag W1–W2, S1–S11, N1–N16 oraz `docs/decisions.md` z przesłanego develop. Przy drugim przeglądzie znaleziono i poprawiono braki D13/D16/D17: losowe ID instancji zastąpiono stałym hostname; rejestracja czeka w tle na działające HTTP; niedostępna instancja jest pomijana do następnego odświeżenia; uruchomienie kontenera to `python -m app.run` bez powłoki; wszystkie wykluczenia Docker obejmują podfoldery; logi startu i zamykania Uvicorn też mają format JSON na stdout. Izolowany dev-compose używa nazw postgres/redis-cart i własnego IP aplikacji zamiast nazwy usługi jako adresu instancji.

| Wymaganie | Wynik w zakresie User i Cart |
|---|---|
| D1 UUID | Spełnione: UUID w ścieżkach/JSON, błędny UUID wejścia → 400 VALIDATION_ERROR. |
| D2 retry i breaker | Spełnione dla wywołań Cart; testy 4xx/5xx, kontraktu, half-open i anulowania. |
| D3 kwoty | Spełnione: tekst, grosze/Decimal, currency PLN. |
| D4 lekki produkt | Cart wysyła SERVICE. Zachowanie Product należy sprawdzić z jego właścicielem. |
| D5 termin | Cała zmiana koszyka ograniczona do 8 s. |
| D6 konwencje i zakres | Własne bazy/nazwy, sekrety poza obrazem; wspólny deploy nie jest zmieniany. |
| D7 błędy | Wspólny format, walidacja 400, kody VALIDATION_ERROR i INTERNAL_ERROR. |
| D8 profil Auth | Spełnione: 201/200/409, także równolegle, bez EmailStr i UNIQUE email. |
| D9 PR i code owner | Paczka tylko User/Cart, patch do develop poprawny. Wysłanie i akceptacja PR pozostają do wykonania. |
| D10 endpointy wewnętrzne | SERVICE wymagane, brak roli → 403. |
| D11 tożsamość | Bez JWT; własność danych, przekazanie ról i korelacji. Egzekwowanie izolacji sieciowej wymaga wspólnego wdrożenia. |
| D12 ścieżki | Bez prefiksu w usługach, bez przekierowań slash, HEAD jak GET. |
| D13 Consul | Stałe ID, rejestracja po HTTP, odzyskiwanie co 15 s, cache/round robin/stale fallback/odrzucanie martwych adresów. |
| D14 KV | logLevel z YAML, env > KV > domyślne, start bez KV dozwolony. |
| D15 zdrowie | Live bez zależności, ready sprawdza tylko własny magazyn. |
| D16 logi | JSON na stdout, requestId/userId, bez danych profilu i treści wyjątków; także logi Uvicorn. |
| D17 obraz i zamykanie | Numeryczny UID, przypięta baza, pełne dockerignore, Python PID 1; test SIGTERM Cart: ok. 0,36 s bez aktywnego żądania. |
| D18 OpenAPI | Wbudowane docs/openapi; blokadę przez Gateway zapewnia jego właściciel. |
| D19 zdarzenia | Nie dotyczy: User/Cart nie publikują i nie konsumują zdarzeń w obecnym kontrakcie. |
| D20 testy i Postman | Testy i kolekcje w usługach; baseUrl w zmiennych kolekcji. |

Nie potwierdzono pełnej zgodności całego projektu: Spring Boot wymaga brakującego PDF-a, W2 wymaga sprawdzenia faktycznej implementacji Inventory po stronie jej właściciela, a wspólny deploy, NetworkPolicy/CNI i akceptacja code ownera należą do integracji Michała. N14 (historia oryginalnego commita) nie daje się odtworzyć z ZIP. Te punkty nie zostały uznane za spełnione przez same testy User/Cart.
