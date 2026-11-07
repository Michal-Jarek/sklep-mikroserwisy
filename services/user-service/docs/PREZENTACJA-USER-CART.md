# User Service i Cart Service — zakres prezentacji

## Zakres rozwiązania

Dwa niezależne serwisy REST w Pythonie 3.12 i FastAPI. User przechowuje profile i adresy dostawy w PostgreSQL. Cart zarządza koszykiem w Redisie i pobiera dane z Product oraz Inventory. Każdy serwis ma własną konfigurację, testy i obraz Docker.

Logowanie, wydawanie JWT, składanie zamówień, rezerwacja towaru i wysyłka należą do pozostałych usług sklepu.

## User Service

Profil zawiera UUID konta z Auth, imię, nazwisko i e-mail. Adresy są powiązane z właścicielem przez klucz obcy. Zapis profilu i operacje na adresach korzystają z transakcji SQLAlchemy. Schemat bazy jest wersjonowany przez Alembic.

Przepływ zmiany profilu:

1. Gateway przekazuje `PUT /users/me` z tożsamością użytkownika.
2. Pydantic waliduje pola imienia i nazwiska.
3. `routes.py` przekazuje dane do `ProfileService.update()`.
4. Serwis pobiera profil, zapisuje zmianę w transakcji i zwraca JSON.

ID właściciela pochodzi z nagłówka Gateway. Przy usuwaniu adresu zapytanie uwzględnia zarówno ID adresu, jak i ID użytkownika. Odczyt dowolnego profilu jest dostępny tylko dla ADMIN lub SERVICE.

## Cart Service

Koszyk jest hashem Redis pod kluczem `cart:{userId}`. Pole hasha identyfikuje produkt, a wartość zawiera nazwę, cenę i ilość.

Przepływ dodania pozycji:

1. Cart przyjmuje UUID produktu i całkowitą ilość od 1 do 999.
2. Consul wskazuje zdrowe instancje Product i Inventory.
3. Product zwraca nazwę i cenę, a Inventory liczbę dostępnych sztuk.
4. Cart sprawdza docelową ilość i zapisuje pozycję w Redisie.
5. Odpowiedź zawiera pozycje, sumę oraz wynik sprawdzenia dostępności.

POST zwiększa ilość, a PATCH ustawia nową wartość. Cena jest pobierana z Product. Obliczenia wykorzystują `Decimal` i całkowitą liczbę groszy; dwie sztuki po `19.99` dają `39.98`.

Skrypt Lua wykonuje porównanie poprzedniej wartości i zapis atomowo. W razie konfliktu serwis ponawia odczyt i obliczenie ilości. Chroni to przed utratą zmian między równoległymi żądaniami i replikami aplikacji.

TTL koszyka wynosi siedem dni od ostatniej zmiany. Odczyt koszyka nie przedłuża tego czasu.

## Komunikacja i odporność

Serwisy rejestrują instancje w Consulu z health checkiem `/health/ready`. Cart zapamiętuje listę zdrowych adresów przez 10 sekund i wybiera je round robin.

Wywołania GET mają timeout 2 s na próbę i maksymalnie dwa ponowienia. Osobny circuit breaker dla Product i Inventory otwiera obwód przy co najmniej pięciu błędach w ostatnich dziesięciu wywołaniach. Po 30 s przepuszcza pojedynczą próbę powrotu.

| Sytuacja | Odpowiedź |
| --- | --- |
| Niepoprawne dane wejściowe | 400 |
| Brak uprawnień | 403 |
| Brak produktu lub profilu | 404 |
| Niewystarczający stan magazynowy | 409 |
| Brak ceny z Product | 503 |
| Niedostępny Inventory | Zapis dopuszczalny, `inventoryChecked:false` |
| Niedostępny Redis | 503 |

Stan sprawdzony w koszyku nie oznacza rezerwacji towaru. Końcową rezerwację wykonuje Order.

## Scenariusz demonstracji

1. Utworzenie profilu przez `POST /users` z rolą SERVICE.
2. Odczyt `/users/me`, edycja profilu i dodanie adresu jako CUSTOMER.
3. Próba odczytu dowolnego profilu jako CUSTOMER — oczekiwane 403.
4. Dodanie produktu do koszyka, zmiana ilości i usunięcie pozycji.
5. Próba czyszczenia całego koszyka bez SERVICE — oczekiwane 403.
6. Wyniki pytest oraz zdrowe instancje w Consulu.

Demonstracja koszyka wymaga Product zgodnego z kontraktem. W testach zależności biznesowe zastępują atrapy. Nagłówki ustawiane w Swaggerze służą wyłącznie do lokalnego sprawdzenia API.

## Stan weryfikacji

Sprawdzono 49 różnych testów: 17 User i 32 Cart. Kolekcje Postman wykonano przez Newman: 12 żądań i asercji bez błędów. Obie aplikacje uruchomiono przez Compose z PostgreSQL, Redisem i Consulem. Potwierdzono także ponowne wykonanie migracji oraz dostępność profilu po restarcie User.

Wdrożenie w docelowym Kubernetesie, egzekwowanie NetworkPolicy i integracja z rzeczywistymi usługami zespołu pozostają do wykonania. Szczegóły zawiera [raport weryfikacji](WERYFIKACJA.md).
