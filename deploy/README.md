# Wspólna infrastruktura sklepu (Docker Compose)

Wspólna infrastruktura usług sklepu uruchamiana w Docker Compose: Consul (rejestr usług i konfiguracja w KV), PostgreSQL, Redis dla API Gateway, RabbitMQ (zdarzenia między usługami), MongoDB (Review i Notification), Redis dla Cart i Mailpit (podgląd e-maili). Uruchomienie: sekcja „Pierwsze uruchomienie”. Zasady obowiązujące usługi: [docs/decisions.md](../docs/decisions.md), jak je spełnić (w tym praca z VS Code przy tej infrastrukturze i wpis usługi w compose): [docs/patterns.md](../docs/patterns.md).

**Wszystkie polecenia uruchamia się z katalogu głównego repo** (tam, gdzie jest folder `deploy/`), nie z wnętrza `deploy/`.

## Co tu jest

| Kontener | Rola | Adres lokalny |
|---|---|---|
| `consul` | Rejestr usług (usługi zgłaszają się tu, żeby inne je znalazły) i konfiguracja usług (Key/Value). Ma interfejs WWW. | http://127.0.0.1:8500/ui |
| `consul-kv-seed` | Przy każdym starcie wgrywa do Consula pliki z `deploy/consul/config/` i kończy pracę (stan `Exited`). | – |
| `postgres` | PostgreSQL 17: osobna baza i osobny użytkownik dla 6 usług (lista w sekcji „Konwencje”). | `127.0.0.1:5432` |
| `redis-gateway` | Redis dla API Gateway (liczniki limitów żądań). Bez zapisu na dysk. | `127.0.0.1:6379` |
| `rabbitmq` | RabbitMQ 4.3: broker zdarzeń (exchange `shop.events`, kolejki odbiorców). Ma panel WWW. | AMQP `127.0.0.1:5672`, panel http://127.0.0.1:15672 |
| `rabbitmq-setup` | Przy każdym starcie wgrywa do RabbitMQ topologię z `deploy/rabbitmq/definitions.json` i konta usług, potem kończy pracę (stan `Exited`). | – |
| `mongo` | MongoDB 8.0: bazy `review_db` i `notification_db`, w każdej osobny użytkownik (sekcja „Konwencje”). | `127.0.0.1:27017` |
| `redis-cart` | Redis dla Cart Service (koszyki). Z hasłem i z zapisem na dysk – dane przeżywają restart. | `127.0.0.1:6380` |
| `mailpit` | Mailpit: serwer SMTP dla Notification Service z panelem WWW do podglądu wysłanych e-maili. Niczego nie wysyła dalej. | SMTP `127.0.0.1:1025`, panel http://127.0.0.1:8025 |

Pliki w folderze:
- `compose.yaml` – opis kontenerów;
- `create-secrets.sh` – tworzy lokalne hasła (`deploy/.env`, także hasło pierwszego administratora Auth) i klucze JWT (`deploy/secrets/`);
- `.env.example` – lista nazw haseł (bez wartości, tylko dla informacji);
- `consul/config/<usługa>.yaml` – konfiguracja usług wgrywana do Consula;
- `consul/seed-kv.sh` – skrypt, którym `consul-kv-seed` wgrywa konfigurację (nie uruchamia się go ręcznie);
- `postgres/init/01-service-databases.sh` – tworzy bazy i użytkowników przy pierwszym starcie;
- `mongo/init/01-service-users.js` – tworzy użytkowników baz MongoDB przy pierwszym starcie;
- `rabbitmq/definitions.json` – exchange, kolejki, wiązania i polityki RabbitMQ (bez kont i haseł);
- `rabbitmq/setup.sh` – skrypt, którym `rabbitmq-setup` wgrywa `definitions.json` i zakłada konta usług (nie uruchamia się go ręcznie);
- `k8s/` – na później. Kubernetes to ostatni etap projektu; do tego czasu infrastruktura i usługi działają w Docker Compose.

Usługi sklepu są w tym samym `compose.yaml` w grupach (tzw. profilach): profil `platform` (API Gateway, Auth Service, User Service i frontend) i profil `full-shop` (cały sklep, w tym usługi z `platform`; usługa zespołu trafia do niego przy scaleniu jej PR – wzór wpisu w [docs/patterns.md](../docs/patterns.md), stan w sekcji „Profil full-shop (usługi zespołu)”). Polecenie bez `--profile` uruchamia tylko infrastrukturę z tabeli; profil `platform` – sekcja „Profil platform (API Gateway, Auth Service i frontend)”.

## Wymagania

1. **Rancher Desktop** z silnikiem Dockera: Preferences → Container Engine → `dockerd (moby)`. Rancher Desktop musi być uruchomiony.
2. **Docker Compose** – jest razem z Rancher Desktop. Sprawdzenie w terminalu:
   ```bash
   docker compose version
   ```
   Wynik: np. `Docker Compose version v5.1.4`. `command not found` albo `unknown command` oznacza, że Rancher Desktop nie działa albo ma inny silnik (punkt 1).
3. **Git.** Na Windowsie: **Git for Windows** – razem z nim instaluje się **Git Bash** (terminal, w którym działają skrypty `.sh`). Na Windowsie wszystkie polecenia z tego pliku wpisuje się w Git Bash otwartym w katalogu repo (prawy przycisk myszy na folderze repo → na Windows 11 najpierw „Pokaż więcej opcji” → „Open Git Bash here”).

## Pierwsze uruchomienie

**Krok 1.** Utwórz lokalne hasła i klucze (istnieją tylko lokalnie, nie trafiają do gita):
```bash
bash deploy/create-secrets.sh
```
Wynik przy pierwszym uruchomieniu (komunikaty skryptów są po angielsku: `created` – utworzono, `variables` – zmienne):
```
deploy/.env: created (19 variables)
deploy/secrets/jwt-*.pem: created
Done. Start: docker compose -f deploy/compose.yaml up -d --wait
```
Skrypt można uruchamiać dowolnie wiele razy. **Nigdy nie nadpisuje istniejących haseł ani kluczy**, tylko dopisuje brakujące. Wynik przy kolejnym uruchomieniu (`unchanged` – bez zmian):
```
deploy/.env: unchanged
deploy/secrets/jwt-*.pem: unchanged
Done. Start: docker compose -f deploy/compose.yaml up -d --wait
```
Kopiowanie `.env.example` do `.env` nie jest potrzebne. Jeśli plik został już skopiowany, skrypt sam uzupełni puste hasła (wynik: `deploy/.env: added: …` z nazwami dopisanych zmiennych).

**Po aktualizacji repozytorium** (np. `git pull`) uruchom skrypt ponownie – nowe wersje mogą wymagać nowych zmiennych. Etap 2 dodał `ADMIN_PASSWORD` (hasło pierwszego administratora Auth); wynik przy starym `deploy/.env`:
```
deploy/.env: added: ADMIN_PASSWORD
```
Etap 4 dodał hasła RabbitMQ (konto `admin` i konta usług); wynik przy starym `deploy/.env`:
```
deploy/.env: added: RABBITMQ_ADMIN_PASSWORD AUTH_RABBITMQ_PASSWORD NOTIFICATION_RABBITMQ_PASSWORD INVENTORY_RABBITMQ_PASSWORD SHIPPING_RABBITMQ_PASSWORD ORDER_RABBITMQ_PASSWORD
```
Etap 5 dodał hasła MongoDB (konto `admin` i użytkownicy baz Review i Notification) i Redisa koszyka; wynik przy starym `deploy/.env`:
```
deploy/.env: added: MONGO_ROOT_PASSWORD REVIEW_DB_PASSWORD NOTIFICATION_DB_PASSWORD REDIS_CART_PASSWORD
```
Potem `docker compose -f deploy/compose.yaml up -d --wait` (z `--profile platform`, jeśli działają Gateway i Auth) uruchamia nowe kontenery `mongo`, `redis-cart` i `mailpit`; dotychczasowe dane zostają.

Bez tego każde polecenie `docker compose -f deploy/compose.yaml …` (także bez profilu) kończy się błędem `required variable … is missing a value: Run deploy/create-secrets.sh` z nazwą brakującej zmiennej.

**Krok 2.** Uruchom infrastrukturę:
```bash
docker compose -f deploy/compose.yaml up -d --wait
```
`-d` – działa w tle, `--wait` – polecenie kończy się dopiero, gdy kontenery są gotowe. Za pierwszym razem pobiera obrazy (kilka minut). Na końcu przy kontenerach jest `Healthy`, a przy `consul-kv-seed` i `rabbitmq-setup` – `Exited` (kontenery kończą pracę po wgraniu konfiguracji). RabbitMQ startuje najdłużej (ok. 10–20 s); MongoDB przy pierwszym starcie zakłada użytkowników baz (kilka sekund dłużej niż przy kolejnych).

**Krok 3.** Sprawdź stan:
```bash
docker compose -f deploy/compose.yaml ps
```
Wynik: siedem kontenerów ze statusem `Up … (healthy)` (jeśli działa też profil `platform`, na liście są dodatkowo `api-gateway` i `auth-service`). W skrócie (kolumny `SERVICE` i `STATUS`):
```
SERVICE         STATUS
consul          Up 12 minutes (healthy)
mailpit         Up 12 minutes (healthy)
mongo           Up 12 minutes (healthy)
postgres        Up 12 minutes (healthy)
rabbitmq        Up 12 minutes (healthy)
redis-cart      Up 12 minutes (healthy)
redis-gateway   Up 12 minutes (healthy)
```
`consul-kv-seed` i `rabbitmq-setup` nie ma na tej liście, bo już zakończyły pracę. Ich stan (oczekiwany `exited 0`, czyli „zakończył się bez błędu”):
```bash
docker compose -f deploy/compose.yaml ps -a consul-kv-seed rabbitmq-setup --format '{{.Service}} {{.State}} {{.ExitCode}}'
```

## Jak sprawdzić, że działa

**Consul.** W przeglądarce http://127.0.0.1:8500/ui → zakładka **Key/Value** → folder `config/` → po jednym folderze na usługę (10: `api-gateway/`, `auth-service/` i osiem usług zespołu, np. `review-service/`), w każdym klucz `data` z treścią pliku z `deploy/consul/config/`.

**PostgreSQL.** Lokalny `psql` nie jest potrzebny – polecenie uruchamia go w kontenerze:
```bash
docker compose -f deploy/compose.yaml exec postgres psql -U auth_service -d auth_db -c 'select current_user'
```
Wynik:
```
 current_user 
--------------
 auth_service
(1 row)
```
To sprawdza, że baza `auth_db` i użytkownik `auth_service` istnieją. Wewnątrz kontenera `postgres` baza nie pyta o hasło, więc to nie jest test hasła. Zamiast `auth` można wpisać inną usługę z sekcji „Konwencje” – w obu miejscach (np. `-U user_service -d user_db`).

Z zewnątrz (lokalny `psql` albo DBeaver): host `127.0.0.1`, port `5432`, baza `<usługa>_db` (np. `auth_db`), użytkownik `<usługa>_service` (np. `auth_service`), hasło z pliku `deploy/.env`, zmienna `<USŁUGA>_DB_PASSWORD` (np. `AUTH_DB_PASSWORD`). Haseł nie wkleja się do czatu, issue ani do repo.

**Redis.**
```bash
docker compose -f deploy/compose.yaml exec redis-gateway sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping'
```
Wynik: `PONG`. Redis ma hasło, dlatego zwykłe `redis-cli ping` odpowiada `NOAUTH Authentication required.` Hasło rozwija powłoka w kontenerze (pojedyncze cudzysłowy), więc nie pojawia się na ekranie ani w historii poleceń. Redis koszyka – to samo polecenie z `redis-cart` zamiast `redis-gateway` (zmienna w kontenerze też nazywa się `REDIS_PASSWORD`):
```bash
docker compose -f deploy/compose.yaml exec redis-cart sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping'
```

Z laptopa (usługa uruchomiona z VS Code, RedisInsight): Redis koszyka to host `127.0.0.1`, port **`6380`** (port 6379 ma Redis Gateway), hasło – zmienna `REDIS_CART_PASSWORD` z `deploy/.env`.

**MongoDB.** Lokalny `mongosh` nie jest potrzebny – polecenie uruchamia go w kontenerze, a hasło rozwija powłoka w kontenerze:
```bash
docker compose -f deploy/compose.yaml exec -T mongo sh -c 'HOME=/tmp mongosh --quiet "mongodb://review_service:$REVIEW_DB_PASSWORD@127.0.0.1:27017/review_db?authSource=review_db" --eval "db.runCommand({connectionStatus: 1}).authInfo.authenticatedUsers"'
```
Wynik:
```
[ { user: 'review_service', db: 'review_db' } ]
```
To sprawdza, że użytkownik `review_service` loguje się hasłem do bazy `review_db`. Dla Notification w adresie zamień wszystkie cztery wystąpienia `review`/`REVIEW` na `notification`/`NOTIFICATION` (użytkownik, zmienna z hasłem, baza i `authSource`). Bez `-T` i bez `--eval …` otwiera się interaktywna konsola `mongosh` (wyjście: `exit`).

Z laptopa (usługa uruchomiona z VS Code, MongoDB Compass): adres `mongodb://review_service:<hasło>@127.0.0.1:27017/review_db?authSource=review_db`, hasło – zmienna `REVIEW_DB_PASSWORD` z `deploy/.env`. `authSource` musi wskazywać bazę usługi (użytkownik jest zapisany w niej, nie w `admin`). Hasła z `create-secrets.sh` to same cyfry i litery `a–f`, więc można je wkleić do adresu bez zmian. Hasło ustawione ręcznie ze znakiem `@`, `:` albo `/` psuje adres `mongodb://` (trzeba by je zakodować, np. `@` jako `%40`) – lepiej zostać przy hasłach ze skryptu.

**Mailpit.** Panel: http://127.0.0.1:8025 – lista e-maili wysłanych przez usługi. Panel i API odpowiadają tylko pod http://127.0.0.1:8025 albo http://localhost:8025; pod inną nazwą hosta (np. `mailpit:8025` z innego kontenera) odpowiadają `403` (ochrona przed odczytem e-maili przez obcą stronę WWW). Usługi wysyłają pocztę przez SMTP: w sieci compose host `mailpit`, port `1025`; z laptopa `127.0.0.1:1025`. Bez szyfrowania i bez logowania. Mailpit trzyma wiadomości w pamięci – znikają po restarcie albo `down` kontenera.

**RabbitMQ.** Panel: http://127.0.0.1:15672, login `admin`, hasło – zmienna `RABBITMQ_ADMIN_PASSWORD` z `deploy/.env`. Zakładka **Exchanges** pokazuje `shop.events` i `shop.dlx` (obok wbudowanych `(AMQP default)` i `amq.*`, których sklep nie używa), zakładka **Queues and Streams** – osiem kolejek (`notification.q`, `inventory.q`, `shipping.q`, `order.q` i ich kolejki błędów `*.dlq`), zakładka **Admin** – konto `admin` i pięć kont usług. Konta `guest` nie ma.

Przebieg ostatniego wgrywania topologii i kont:
```bash
docker compose -f deploy/compose.yaml logs --no-log-prefix rabbitmq-setup
```
Wynik (po jednej parze linii na każde `up`; ostatnie są na końcu):
```
imported definitions.json
applied 5 service accounts
```

Usługi łączą się z RabbitMQ przez AMQP: w sieci compose host `rabbitmq`, port `5672`; z laptopa (usługa uruchomiona z VS Code) `127.0.0.1:5672`. Każda usługa ma własne konto `<usługa>-service` (np. `auth-service`) z hasłem `<USŁUGA>_RABBITMQ_PASSWORD` z `deploy/.env` i prawem tylko do swojej kolejki i swoich zdarzeń (tabela w sekcji „Konwencje”). Konta usług nie logują się do panelu. Zdarzenia, kolejki, uprawnienia i sposób odbierania zdarzeń: [docs/events.md](../docs/events.md).

Topologię i konta przywraca `rabbitmq-setup` przy każdym `up` (zmiana zrobiona ręcznie w panelu, np. usunięte uprawnienie, wraca do stanu z repo). Wgrywanie dodaje brakujące elementy i aktualizuje polityki, konta i uprawnienia. Istniejące kolejki i exchange pomija bez błędu, więc zmiana typu albo argumentów kolejki w `definitions.json` działa dopiero po czystym starcie (sekcja „RabbitMQ od zera”). Wgrywanie niczego nie usuwa: kolejka, wiązanie albo konto dodane ręcznie w panelu zostaje do czystego startu.

## Profil platform (API Gateway, Auth Service i frontend)

Infrastruktura razem z API Gateway, Auth Service i frontendem (sklep w przeglądarce):
```bash
bash deploy/create-secrets.sh
docker compose -f deploy/compose.yaml --profile platform up -d --wait --build
```
`--build` buduje obrazy `api-gateway:dev`, `auth-service:dev` i `user-service:dev` z `services/` oraz `frontend:dev` z `frontend/` (pierwszy raz kilka minut). Dochodzi sześć kontenerów: `auth-migrate` i `user-migrate` (jednorazowo stosują migracje baz `auth_db` i `user_db` i kończą się kodem 0), `auth-service` (startuje po migracjach i po `rabbitmq-setup`), `user-service` (startuje po `user-migrate`), `api-gateway` i `frontend` (startuje, gdy Gateway jest zdrowy). User Service jest w tym profilu, bo przy rejestracji Auth zakłada w nim profil klienta (`USER_SERVICE_ENABLED: "true"`); bez niego rejestracja kończy się `503`. Stan:
```bash
docker compose -f deploy/compose.yaml --profile platform ps --format '{{.Service}} {{.Status}}'
```
Wynik: `api-gateway`, `auth-service`, `user-service`, `frontend`, `consul`, `postgres`, `rabbitmq` i `redis-gateway` ze statusem `Up … (healthy)`.

Przez pierwsze sekundy po starcie Gateway może jeszcze odpowiadać `503` na `/api/v1/auth/…` – czeka, aż zobaczy w Consulu zdrowy Auth Service. Wtedy powtórz polecenie po kilku sekundach.

**Frontend (sklep w przeglądarce)** działa pod adresem **http://127.0.0.1:8090** (port tylko na `127.0.0.1`). Kontener `frontend` (nginx bez roota, tylko w sieci `sklep_edge`) serwuje aplikację React i przekazuje żądania `/api/…` do API Gateway, więc aplikacja i API mają jeden adres (bez CORS). Healthcheck kontenera to `/health/live` co 5 s; logi dostępu są w JSON, jedna linia na żądanie, bez nagłówków, ciasteczek i parametrów zapytania (`docker compose -f deploy/compose.yaml logs frontend`). Sprawdzenie:
```bash
curl -i http://127.0.0.1:8090/health/ready
```
Wynik: `HTTP/1.1 200 OK` i `{"status":"UP"}`. Obraz, nagłówki bezpieczeństwa i praca nad frontendem: [frontend/README.md](../frontend/README.md).

**API Gateway** działa pod adresem `http://localhost:8080` (port tylko na `127.0.0.1`) – to wejście do usług z laptopa dla Postmana, curl i dokumentacji; przeglądarka korzysta z niego przez frontend. Sprawdzenie:
```bash
curl -i http://localhost:8080/health/ready
```
Wynik: `HTTP/1.1 200 OK` i `{"status":"UP"}`. Gateway przekazuje żądania `/api/v1/<zasób>/…` do usług zarejestrowanych w Consulu; trasy, reguły dostępu, limity żądań i kody błędów opisuje [services/api-gateway/README.md](../services/api-gateway/README.md).

**Auth Service** nie ma portu na laptopie – działa w sieci `sklep_backend`, a z laptopa woła się go przez Gateway pod `http://localhost:8080/api/v1/auth/…`. Rejestracja i logowanie (przykładowe dane; hasło co najmniej 8 znaków):
```bash
curl -s -w ' %{http_code}\n' -H 'Content-Type: application/json' \
  -d '{"email":"anna@example.com","password":"Haslo-1234!","firstName":"Anna","lastName":"Nowak"}' \
  http://localhost:8080/api/v1/auth/register
curl -s -o /dev/null -w '%{http_code}\n' -c /tmp/sklep-cookies.txt -H 'Content-Type: application/json' \
  -d '{"email":"anna@example.com","password":"Haslo-1234!"}' \
  http://localhost:8080/api/v1/auth/login
```
Wynik: dane konta i `201` (drugi raz `409` – e-mail zajęty), potem `200`. Bez `-o /dev/null -w …` odpowiedź logowania zawiera `accessToken` – traktuj go jak hasło. Ciasteczko `refresh_token` (`Path=/api/v1/auth`) trafia do pliku `/tmp/sklep-cookies.txt` i działa przez Gateway bez przepisywania:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/sklep-cookies.txt -c /tmp/sklep-cookies.txt -X POST http://localhost:8080/api/v1/auth/refresh
```
Wynik: `200`. Gateway ogranicza logowanie do 5, a rejestrację do 10 żądań na minutę z jednego adresu IP – potem odpowiada `429`. Szczegóły Auth: [services/auth-service/README.md](../services/auth-service/README.md).

**Adres IP klienta za frontendem.** Gateway przyjmuje adres klienta z nagłówka `X-Forwarded-For` tylko od kontenera `frontend` (`TRUSTED_PROXIES: frontend` w `compose.yaml`; nginx frontendu zawsze nadpisuje ten nagłówek adresem swojego klienta). Dzięki temu limity żądań i adres widziany przez Auth i usługi dotyczą prawdziwego klienta, a nie całego frontendu. Od każdego innego rozmówcy (curl na `8080`, inny kontener) nagłówek nie ma znaczenia. W Rancher Desktop wszystkie połączenia z laptopa – przez frontend i bezpośrednio na `8080` – mają ten sam adres (bramka sieci `sklep_edge`), więc z jednego laptopa limity są wspólne; osobne adresy mają tylko kontenery w sieci `sklep_edge`. Gateway sprawdza adres kontenera `frontend` w DNS co 10 s, więc przez kilka sekund po starcie albo odtworzeniu frontendu limity wszystkich jego klientów liczą się razem. Szczegóły: [services/api-gateway/README.md](../services/api-gateway/README.md), zmienna `TRUSTED_PROXIES`.

Plik z ciasteczkiem działa jak hasło do sesji – po testach go usuń:
```bash
rm -f /tmp/sklep-cookies.txt
```

## Profil full-shop (usługi zespołu)

Profil `full-shop` to wszystko z `platform` oraz usługi zespołu, które mają już wpis w `compose.yaml`:

| Usługa | Zależności w compose | Stan |
|---|---|---|
| `user-service` (+ `user-migrate`) | `postgres` (`user_db`), Consul | także w `platform` |
| `cart-service` | `redis-cart`, Consul | działa; dodanie produktu do koszyka wymaga Product Service (do tego czasu `503`) |
| `inventory-service` | `postgres` (`inventory_db`), RabbitMQ (`inventory.q`), Consul | wpis gotowy, kod w PR #2 |
| `review-service` | `mongo` (`review_db`), Consul | wpis gotowy, kod w PR #2 |

Product, Order, Notification i Shipping nie mają jeszcze wpisów (dojdą przy scaleniu ich PR).

Dopóki PR #2 (Inventory, Review) nie jest w `develop`, foldery tych usług nie mają `Dockerfile`, więc samo `--profile full-shop up` kończy się błędem budowania. Do tego czasu podaj usługi z nazwy:
```bash
docker compose -f deploy/compose.yaml --profile full-shop up -d --wait --build user-service cart-service api-gateway frontend
```
Po scaleniu PR #2:
```bash
docker compose -f deploy/compose.yaml --profile full-shop up -d --wait --build
```
Usługi zespołu nie mają portów na laptopie; z zewnątrz woła się je przez Gateway (`http://localhost:8080/api/v1/users/me`, `…/cart`, `…/inventory/<id>`, `…/reviews?productId=<id>`). Jak zatrzymać usługę z compose na czas pracy z VS Code: [docs/patterns.md](../docs/patterns.md), sekcja 1.

W `up`, `stop` i `down` podaje się `--profile platform`, inaczej polecenie pomija kontenery Gateway, Auth i frontendu (`stop` zostawia je uruchomione, `down` ich nie usuwa). W `ps` i `logs` profil nie jest potrzebny, ale nie szkodzi:
```bash
docker compose -f deploy/compose.yaml --profile platform ps
```
Podpowiedź `Done. Start: …` na końcu `create-secrets.sh` dotyczy samej infrastruktury; z Gateway, Auth i frontendem użyj polecenia z początku tej sekcji.

Wolumen PostgreSQL utworzony przed etapem 2 nie ma bazy cieni `auth_shadow_db` (potrzebnej tylko do tworzenia migracji Auth). Dodaje ją ponowne uruchomienie skryptu baz, bez utraty danych – polecenie `exec … 01-service-databases.sh` z sekcji „Reset od zera”.

### Pokaz load balancingu (dwie instancje Auth)

Druga instancja Auth Service:
```bash
docker compose -f deploy/compose.yaml --profile platform up -d --wait --scale auth-service=2
sleep 12   # Gateway odświeża listę instancji z Consula co 10 s
```
Osiem żądań przez Gateway; nagłówek `X-Instance-Id` w odpowiedzi pokazuje, która instancja odpowiedziała (`POST /api/v1/auth/logout` bez ciasteczka odpowiada 204 i niczego nie zmienia):
```bash
for i in $(seq 1 8); do
  curl -s -D - -o /dev/null -X POST http://localhost:8080/api/v1/auth/logout | grep -i '^x-instance-id' | tr -d '\r'
done | sort | uniq -c
```
Wynik: dwie różne wartości `x-instance-id: auth-service-<hostname>`, każda po 4 razy. Powrót do jednej instancji:
```bash
docker compose -f deploy/compose.yaml --profile platform up -d --wait --scale auth-service=1
sleep 12   # Gateway odświeża listę instancji z Consula co 10 s
```
Bez odczekania Gateway może jeszcze przez około 10 s kierować żądania do usuniętej instancji: `POST` (np. logowanie) dostaje wtedy `502`, a `GET` jest ponawiany do drugiej instancji.

### Logowanie jako ADMIN

Przy pierwszym starcie `auth-service` zakłada konto z rolą `ADMIN`: e-mail `admin@sklep.local` (inny: `ADMIN_EMAIL=…` w `deploy/.env` przed pierwszym startem), hasło – zmienna `ADMIN_PASSWORD` z `deploy/.env`. Późniejsza zmiana `ADMIN_PASSWORD` nie zmienia hasła istniejącego konta. Hasła nie wkleja się do czatu, issue ani do repo.

Sprawdzenie logowania przez Gateway bez wypisywania hasła (hasło trafia do zmiennej, a żądanie idzie przez standardowe wejście):
```bash
P=$(docker compose -f deploy/compose.yaml --profile platform exec -T auth-service printenv ADMIN_PASSWORD)
printf '{"email":"admin@sklep.local","password":"%s"}' "$P" | curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Content-Type: application/json' --data-binary @- http://localhost:8080/api/v1/auth/login
unset P
```
Wynik: `200`. Bez `-o /dev/null -w …` odpowiedź zawiera `accessToken` (token z rolą `ADMIN`, ważny 15 minut) – traktuj go jak hasło.

## Codzienna praca

Jeśli uruchamiasz też Gateway i Auth (profil `platform`), dodaj `--profile platform` do każdego polecenia w tej i następnej sekcji (np. `docker compose -f deploy/compose.yaml --profile platform stop`) – inaczej kontenery Gateway i Auth zostaną pominięte.

Zatrzymanie (kontenery zostają, start jest szybszy):
```bash
docker compose -f deploy/compose.yaml stop
```
Albo zatrzymanie i usunięcie kontenerów:
```bash
docker compose -f deploy/compose.yaml down
```
W obu przypadkach dane zostają: bazy w PostgreSQL i MongoDB, koszyki w Redisie koszyka, zawartość Consula oraz kolejki i wiadomości w RabbitMQ przeżywają. Redis Gateway zaczyna zawsze pusty (celowo, bez zapisu na dysk) – liczniki limitów żądań startują od zera. Mailpit też zaczyna pusty (e-maile trzyma w pamięci).

Do czasu, aż usługi odbierające zdarzenia będą w Docker Compose, wiadomości zbierają się w kolejkach `*.q` (np. każda rejestracja dodaje jedną do `notification.q`). Kolejkę czyści się w panelu: **Queues and Streams** → kolejka → **Purge Messages**.

Ponowny start – to samo polecenie co za pierwszym razem:
```bash
docker compose -f deploy/compose.yaml up -d --wait
```

**Zmiana konfiguracji usługi w Consulu:** edytuj plik `deploy/consul/config/<usługa>.yaml`, potem uruchom `docker compose -f deploy/compose.yaml --profile platform up -d --wait` (z profilem, jeśli działają usługi z `platform`). Przy każdym `up` kontener `consul-kv-seed` wgrywa te pliki do Consula i nadpisuje to, co tam było. Usługa czyta konfigurację tylko przy starcie, więc potem zrestartuj ją, np. `docker compose -f deploy/compose.yaml --profile platform restart api-gateway`; `restart` nie czeka na gotowość – usługa działa, gdy `docker compose -f deploy/compose.yaml --profile platform ps` pokazuje przy niej `(healthy)`. Zmiana zrobiona ręcznie w UI Consula działa tylko do następnego `up`. W tych plikach nie wpisuje się haseł.

## Reset od zera

Z Auth (profil `platform`) oba polecenia z `--profile platform` – inaczej `auth-service` zostaje uruchomiony, a po `up` bez profilu nikt nie założy tabel w nowej, pustej bazie `auth_db` (robi to `auth-migrate`):

```bash
docker compose -f deploy/compose.yaml --profile platform down -v
docker compose -f deploy/compose.yaml --profile platform up -d --wait
```
Sama infrastruktura (bez Auth i Gateway): te same polecenia bez `--profile platform`.

`-v` usuwa też dane: **wszystkie bazy w PostgreSQL i MongoDB (z tabelami, kolekcjami i danymi), koszyki w Redisie koszyka, całą zawartość Consula i RabbitMQ (kolejki z wiadomościami, konta)**. Po `up` bazy i użytkownicy powstają od nowa, puste. Plik `deploy/.env` i klucze w `deploy/secrets/` zostają.

Kiedy to potrzebne: po zmianie hasła w `deploy/.env` po pierwszym starcie. Bazy i użytkownicy powstają tylko przy pierwszym starcie na pustych danych, więc baza dalej ma stare hasło.

Bez utraty danych – zamiast `down -v` ustaw nowe hasła w bazie:
```bash
docker compose -f deploy/compose.yaml up -d --wait
docker compose -f deploy/compose.yaml exec -T postgres bash /docker-entrypoint-initdb.d/01-service-databases.sh
```
Pierwsze polecenie odtwarza kontener `postgres` z nowymi wartościami z `deploy/.env` (dane zostają). Drugie ustawia użytkownikom hasła według `deploy/.env` i tworzy brakujące bazy (także `auth_shadow_db`); istniejących baz nie rusza. Skrypt wypisuje najpierw linie `SET`, `ALTER ROLE`, `REVOKE` (wyniki kolejnych poleceń SQL), a na końcu `01-service-databases.sh: done (auth user product inventory order shipping)`.

### RabbitMQ od zera

Hasło konta `admin` (`RABBITMQ_ADMIN_PASSWORD`) RabbitMQ ustawia tylko przy pierwszym starcie na pustych danych. Po późniejszej zmianie tej zmiennej `rabbitmq-setup` nie może się zalogować i `up` kończy się błędem `service "rabbitmq-setup" didn't complete successfully`. Rozwiązanie – czysty start samego RabbitMQ (kolejki z wiadomościami znikają, bazy i Consul zostają):
```bash
docker compose -f deploy/compose.yaml --profile platform down
docker volume rm sklep_rabbitmq-data
docker compose -f deploy/compose.yaml --profile platform up -d --wait
```
Bez Gateway i Auth (sama infrastruktura) te same polecenia bez `--profile platform`.

To samo polecenie przywraca dokładny stan z repo, gdy w panelu dodano ręcznie kolejki, wiązania albo konta (`rabbitmq-setup` ich nie usuwa) albo gdy w `definitions.json` zmienił się typ lub argumenty istniejącej kolejki. Hasła kont usług (`<USŁUGA>_RABBITMQ_PASSWORD`) `rabbitmq-setup` ustawia przy każdym `up` – ich zmiana nie wymaga czystego startu. Dozwolone znaki w tych hasłach: litery, cyfry i `. _ ~ -` (hasła z `create-secrets.sh` je spełniają).

### MongoDB od zera i ponowne utworzenie użytkowników

Konto `admin` i użytkowników baz (`review_service`, `notification_service`) MongoDB zakłada tylko przy pierwszym starcie na pustych danych (wolumen `sklep_mongo-data`). Wolumen z wcześniejszej próby, bez tych użytkowników albo ze starymi hasłami, daje przy logowaniu usługi błąd `Authentication failed`. Są dwie drogi.

**Pusty wolumen** (kolekcje Review i Notification znikają, reszta danych zostaje):
```bash
docker compose -f deploy/compose.yaml --profile platform down
docker volume rm sklep_mongo-data
docker compose -f deploy/compose.yaml --profile platform up -d --wait
```
Bez Gateway i Auth (sama infrastruktura) te same polecenia bez `--profile platform`. W logu `docker compose -f deploy/compose.yaml logs mongo` pojawiają się wtedy linie `created review_service in review_db` i `created notification_service in notification_db`.

**Ponowny skrypt bez kasowania danych** – np. po zmianie `REVIEW_DB_PASSWORD` albo `NOTIFICATION_DB_PASSWORD` w `deploy/.env`:
```bash
docker compose -f deploy/compose.yaml up -d --wait
docker compose -f deploy/compose.yaml exec -T mongo sh -c 'HOME=/tmp mongosh --quiet -u admin -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin /docker-entrypoint-initdb.d/01-service-users.js'
```
Pierwsze polecenie odtwarza kontener `mongo` z nowymi wartościami z `deploy/.env` (dane zostają). Drugie loguje się kontem `admin` (hasło rozwija powłoka w kontenerze) i ustawia użytkownikom baz hasła i uprawnienia według `deploy/.env`; brakujących użytkowników zakłada. Wynik:
```
updated review_service in review_db
updated notification_service in notification_db
```
Hasła konta `admin` (`MONGO_ROOT_PASSWORD`) to nie zmienia: MongoDB ustawia je tylko przy pustym wolumenie, tak jak RabbitMQ. Po zmianie `MONGO_ROOT_PASSWORD` w `deploy/.env` drugie polecenie kończy się błędem `Authentication failed` – wtedy pozostaje pusty wolumen.

### Redis koszyka od zera

Usunięcie wszystkich koszyków (pozostałe dane zostają):
```bash
docker compose -f deploy/compose.yaml --profile platform down
docker volume rm sklep_redis-cart-data
docker compose -f deploy/compose.yaml --profile platform up -d --wait
```
Hasło Redisa koszyka (`REDIS_CART_PASSWORD`) nie jest zapisane w danych – po jego zmianie w `deploy/.env` wystarczy `up -d --wait` (odtwarza kontener z nowym hasłem), bez kasowania koszyków.

## Konwencje

Obowiązują w kolejnych etapach (Auth, Gateway, usługi zespołu).

| Co | Wartość |
|---|---|
| Hosty w sieci compose (i później w k8s) | `consul`, `postgres`, `redis-gateway`, `rabbitmq`, `mongo`, `redis-cart`, `mailpit` |
| Nazwa usługi w Consulu | = nazwa usługi w compose = nazwa obrazu (`auth-service`, `api-gateway`, …) |
| Zmienne usług – Consul | `CONSUL_HOST` (`consul`, lokalnie `127.0.0.1`), `CONSUL_PORT` (`8500`) |
| Zmienne usług – baza | `DB_HOST` (`postgres`), `DB_PORT` (`5432`), `DB_NAME` (`<s>_db`), `DB_USER` (`<s>_service`), `DB_PASSWORD` (w compose: `${<S>_DB_PASSWORD}`) |
| Zmienne usług – MongoDB (Review, Notification) | `DB_HOST` (`mongo`), `DB_PORT` (`27017`), `DB_NAME` (`<s>_db`), `DB_USER` (`<s>_service`), `DB_PASSWORD` (w compose: `${<S>_DB_PASSWORD}`); `authSource` = `<s>_db` |
| Zmienne Gateway – Redis | `REDIS_HOST` (`redis-gateway`), `REDIS_PORT` (`6379`), `REDIS_PASSWORD` (w compose: `${REDIS_GATEWAY_PASSWORD}`) |
| Zmienne Cart – Redis | `REDIS_HOST` (`redis-cart`), `REDIS_PORT` (`6379`), `REDIS_PASSWORD` (w compose: `${REDIS_CART_PASSWORD}`) |
| Zmienne Notification – SMTP | `SMTP_HOST` (`mailpit`), `SMTP_PORT` (`1025`); bez logowania i bez TLS |
| Zmienne usług – RabbitMQ | `RABBITMQ_HOST` (`rabbitmq`), `RABBITMQ_PORT` (`5672`), `RABBITMQ_USER` (`<s>-service`), `RABBITMQ_PASSWORD` (w compose: `${<S>_RABBITMQ_PASSWORD}`) |
| Usługa uruchomiona z VS Code (poza kontenerem) | łączy się z infrastrukturą przez `127.0.0.1` i porty z tabeli „Co tu jest” (5432, 8500, 6379, 5672, 27017, 6380 – Redis koszyka, 1025 – SMTP); rejestruje się w Consulu z adresem `host.docker.internal` (szczegóły: [docs/patterns.md](../docs/patterns.md)) |
| Klucze JWT | `deploy/secrets/jwt-private.pem` (tylko Auth; w kontenerze `/run/secrets/jwt-private.pem`, tylko do odczytu), `jwt-public.pem` |
| Konfiguracja w KV | `deploy/consul/config/<usługa>.yaml` → `config/<usługa>/data` |

`<s>` to krótka nazwa usługi, `<S>` – ta sama wielkimi literami. Bazy w PostgreSQL:

| Usługa | Baza | Użytkownik | Hasło w `deploy/.env` |
|---|---|---|---|
| auth-service | `auth_db` | `auth_service` | `AUTH_DB_PASSWORD` |
| user-service | `user_db` | `user_service` | `USER_DB_PASSWORD` |
| product-service | `product_db` | `product_service` | `PRODUCT_DB_PASSWORD` |
| inventory-service | `inventory_db` | `inventory_service` | `INVENTORY_DB_PASSWORD` |
| order-service | `order_db` | `order_service` | `ORDER_DB_PASSWORD` |
| shipping-service | `shipping_db` | `shipping_service` | `SHIPPING_DB_PASSWORD` |
| auth-service (tylko tworzenie migracji) | `auth_shadow_db` | `auth_service` | `AUTH_DB_PASSWORD` |

Każdy użytkownik jest właścicielem tylko swoich baz i nie może połączyć się z cudzą. `auth_shadow_db` to baza cieni dla `npx prisma migrate dev` w Auth Service (Prisma sprawdza na niej migracje); usługa jej nie używa.

Bazy w MongoDB (kontener `mongo`). Użytkownik jest zapisany w bazie usługi, więc w adresie połączenia `authSource` = baza usługi. Każdy użytkownik ma tylko rolę `readWrite` na swojej bazie: zapis do cudzej kończy się błędem `not authorized`, a lista baz pokazuje tylko własną. Konto `admin` służy tylko do administracji (np. skrypt z sekcji „MongoDB od zera…”), nie dla usług.

| Usługa | Baza | Użytkownik | Hasło w `deploy/.env` |
|---|---|---|---|
| review-service | `review_db` | `review_service` | `REVIEW_DB_PASSWORD` |
| notification-service | `notification_db` | `notification_service` | `NOTIFICATION_DB_PASSWORD` |

Cart Service ma osobny serwer Redis (`redis-cart`, hasło `REDIS_CART_PASSWORD`, zapis na dysk), niezależny od Redisa Gateway – żaden z nich nie zna hasła drugiego.

Konta w RabbitMQ (vhost `/`). Żadne konto usługi nie tworzy exchange, kolejek ani wiązań – robi to tylko `rabbitmq-setup`; odbiorca otwiera swoją kolejkę bez jej deklarowania. Szczegóły: [docs/events.md](../docs/events.md).

| Konto | Hasło w `deploy/.env` | Wysyła do `shop.events` | Czyta kolejkę |
|---|---|---|---|
| `admin` (panel) | `RABBITMQ_ADMIN_PASSWORD` | wszystko | wszystkie |
| `auth-service` | `AUTH_RABBITMQ_PASSWORD` | `user.registered` | – |
| `notification-service` | `NOTIFICATION_RABBITMQ_PASSWORD` | – | `notification.q` |
| `inventory-service` | `INVENTORY_RABBITMQ_PASSWORD` | – | `inventory.q` |
| `shipping-service` | `SHIPPING_RABBITMQ_PASSWORD` | `shipment.status_changed` | `shipping.q` |
| `order-service` | `ORDER_RABBITMQ_PASSWORD` | `order.created`, `order.cancelled` | `order.q` |

### Hasła w `deploy/.env`

Wszystkie 19 zmiennych tworzy `bash deploy/create-secrets.sh` (losowe, 48 znaków `0-9a-f`). Każdy kontener dostaje tylko hasła, których potrzebuje.

| Zmienna | Do czego | Kontener |
|---|---|---|
| `POSTGRES_PASSWORD` | superużytkownik PostgreSQL `postgres` (tylko administracja) | `postgres` |
| `AUTH_DB_PASSWORD` | użytkownik `auth_service` bazy `auth_db` | `postgres`, `auth-migrate`, `auth-service` |
| `USER_DB_PASSWORD`, `PRODUCT_DB_PASSWORD`, `INVENTORY_DB_PASSWORD`, `ORDER_DB_PASSWORD`, `SHIPPING_DB_PASSWORD` | użytkownicy `<s>_service` baz PostgreSQL usług zespołu | `postgres` (i usługa po scaleniu jej PR) |
| `REDIS_GATEWAY_PASSWORD` | Redis Gateway | `redis-gateway`, `api-gateway` |
| `ADMIN_PASSWORD` | pierwsze konto `ADMIN` w Auth (tylko przy pierwszym starcie) | `auth-service` |
| `RABBITMQ_ADMIN_PASSWORD` | konto `admin` RabbitMQ (panel; tylko przy pustym wolumenie) | `rabbitmq`, `rabbitmq-setup` |
| `AUTH_RABBITMQ_PASSWORD`, `NOTIFICATION_RABBITMQ_PASSWORD`, `INVENTORY_RABBITMQ_PASSWORD`, `SHIPPING_RABBITMQ_PASSWORD`, `ORDER_RABBITMQ_PASSWORD` | konta usług w RabbitMQ | `rabbitmq-setup` (i usługa: dziś `auth-service`) |
| `MONGO_ROOT_PASSWORD` | konto `admin` MongoDB (tylko administracja; tylko przy pustym wolumenie) | `mongo` |
| `REVIEW_DB_PASSWORD`, `NOTIFICATION_DB_PASSWORD` | użytkownicy `<s>_service` baz MongoDB | `mongo` (i usługa po scaleniu jej PR) |
| `REDIS_CART_PASSWORD` | Redis koszyka | `redis-cart` (i Cart po scaleniu PR) |

Hasło do własnej usługi uruchamianej z VS Code przenosi się z `deploy/.env` do lokalnego `.env` usługi bez wyświetlania – polecenie w [docs/patterns.md](../docs/patterns.md). Haseł nie wkleja się do czatu, issue ani do repo.

## Bezpieczeństwo

- Porty są wystawione tylko na `127.0.0.1` – z innych komputerów w sieci są niedostępne.
- Z usług sklepu porty mają tylko API Gateway (`127.0.0.1:8080`) i frontend (sekcja „Profil platform”), który przekazuje `/api/…` do Gateway. Pozostałe usługi (np. `auth-service`) nie mają portów na laptopie i są osiągalne tylko przez Gateway.
- Każdy kontener działa bez uprawnień roota i dostaje tylko swoje hasła (tabela „Hasła w `deploy/.env`”). Mailpit nie ma logowania – SMTP jest dostępny z laptopa i z sieci compose, panel i API tylko z laptopa (http://127.0.0.1:8025, http://localhost:8025).
- `deploy/.env` i `deploy/secrets/` **nigdy nie trafiają do repo** (`.gitignore` je pomija) i nie są przekazywane innym osobom – każdy generuje własne.

## Gdy coś nie działa

**Zajęty port 5432, 8500, 6379, 5672, 15672, 27017, 6380, 8025, 1025, 8080 albo 8090** (w komunikacie `port is already allocated` albo `address already in use`). Ten port zajmuje inny kontener albo program, np. compose z `services/user-service/dev/compose.yaml` albo lokalnie zainstalowany PostgreSQL lub MongoDB. Kontenery z ich portami:
```bash
docker ps --format '{{.Names}}  {{.Ports}}'
```
Kontenery o nazwach `k8s_…` to wewnętrzny Kubernetes Rancher Desktop – ich nie należy ruszać; szukaj nazwy z numerem portu (np. `5432`).
Zatrzymaj tamten zestaw (np. `docker compose -f services/user-service/dev/compose.yaml down`) albo pojedynczy kontener (`docker stop <nazwa>`), potem znowu `up -d --wait`.

**Pod adresem frontendu otwiera się inna aplikacja** (albo curl dostaje odpowiedź, która nie pochodzi ze sklepu, np. bez `{"status":"UP"}` z `/health/ready`). Inny program na laptopie może słuchać na tym samym porcie pod adresem IPv6 `[::1]`, a przeglądarka i curl dla `localhost` próbują najpierw IPv6; `docker compose` tego nie wykrywa, bo kontener sklepu używa tylko `127.0.0.1`. Sprawdzenie: `lsof -nP -iTCP:8090 -sTCP:LISTEN`. Otwieraj sklep pod adresem z `127.0.0.1` (jak w poleceniach tej instrukcji) albo zatrzymaj tamten program.

**Brak haseł:** `required variable … is missing a value: Run deploy/create-secrets.sh`. Nie ma pliku `deploy/.env`, ma puste wartości albo brakuje w nim zmiennej dodanej w nowszej wersji repo (np. `ADMIN_PASSWORD`). Rozwiązanie:
```bash
bash deploy/create-secrets.sh
```

**`01-service-databases.sh: No such file or directory`** przy `docker compose -f deploy/compose.yaml exec -T postgres bash /docker-entrypoint-initdb.d/01-service-databases.sh`. Kontener `postgres` powstał przed przełączeniem gałęzi albo odtworzeniem folderu `deploy/postgres/init`, a montowanie wskazuje stary, pusty katalog. Odtwórz kontener (dane w wolumenie zostają) i powtórz polecenie:
```bash
docker compose -f deploy/compose.yaml up -d --wait --force-recreate postgres
```

**`Permission denied` (w zsh: `permission denied`) przy `deploy/create-secrets.sh`.** Uruchamiaj zawsze przez `bash`, jak wyżej – wtedy działa także bez prawa wykonywania.

**`openssl not found. On Windows, run this script in Git Bash.`** (brak programu `openssl`). Na Windowsie skrypt uruchamia się w Git Bash (sekcja „Wymagania”), nie w PowerShell ani cmd.

**Consul: `No cluster leader`** (w UI albo w logach usługi). Consul zaraz po starcie wybiera lidera, co trwa ok. 10 sekund – potem odśwież. Z `--wait` polecenie `up` czeka na to samo.

**`service "consul-kv-seed" didn't complete successfully`** – nie udało się wgrać konfiguracji do Consula. Przyczyna w logach:
```bash
docker compose -f deploy/compose.yaml logs consul-kv-seed
```
Poprawny przebieg to linie `loaded config/<usługa>/data` – przy każdym `up` po jednej na plik z `deploy/consul/config/` (log zawiera wszystkie dotychczasowe uruchomienia, ostatnie są na końcu). Błąd zaczyna się od `Error!` (np. `Error! Failed writing data: …` – Consul nieosiągalny). Zwykle wystarcza ponowne `up -d --wait`. Uwaga: wgrywanie nie sprawdza składni YAML – plik z błędem trafi do Consula, a błąd zgłosi dopiero usługa przy starcie.

**`service "rabbitmq-setup" didn't complete successfully`** – nie udało się wgrać topologii albo kont do RabbitMQ. `up` zatrzymuje się na tym błędzie: nie startują wtedy `redis-gateway` ani API Gateway (czekają na udany `rabbitmq-setup`), a z profilem `platform` także `auth-service`. `redis-gateway` nie korzysta z RabbitMQ — czeka na `rabbitmq-setup` tylko po to, żeby `up --wait` zaczekał na zakończenie tego jednorazowego kontenera. Przyczyna w logach:
```bash
docker compose -f deploy/compose.yaml logs rabbitmq-setup
```
Najczęściej ostatnia linia to `Not_Authorized` (zamiast `imported definitions.json`): `RABBITMQ_ADMIN_PASSWORD` w `deploy/.env` różni się od hasła ustawionego przy pierwszym starcie RabbitMQ – rozwiązanie to czysty start RabbitMQ (sekcja „RabbitMQ od zera”). Linia `<USŁUGA>_RABBITMQ_PASSWORD: only letters, digits and . _ ~ - are allowed …` oznacza puste hasło konta usługi albo hasło z innym znakiem niż litery, cyfry i `. _ ~ -` – usuń ten wiersz z `deploy/.env`, uruchom `bash deploy/create-secrets.sh` (doda nowe hasło) i ponów `up -d --wait`; czysty start nie jest potrzebny.

**MongoDB: `Authentication failed`** przy logowaniu użytkownika usługi (np. `review_service`). Wolumen `sklep_mongo-data` powstał wcześniej, bez tego użytkownika albo z innym hasłem – sekcja „MongoDB od zera i ponowne utworzenie użytkowników”.

**Inne problemy:** logi wybranego kontenera:
```bash
docker compose -f deploy/compose.yaml logs postgres
```
(zamiast `postgres`: `consul`, `redis-gateway`, `consul-kv-seed`, `rabbitmq`, `rabbitmq-setup`, `mongo`, `redis-cart`, `mailpit`, `api-gateway`, `auth-service`, `frontend`).
