# Wspólna infrastruktura sklepu (Docker Compose)

Wspólna infrastruktura usług sklepu uruchamiana w Docker Compose: Consul (rejestr usług i konfiguracja w KV), PostgreSQL i Redis dla API Gateway. Uruchomienie: sekcja „Pierwsze uruchomienie”.

**Wszystkie polecenia uruchamia się z katalogu głównego repo** (tam, gdzie jest folder `deploy/`), nie z wnętrza `deploy/`.

## Co tu jest

| Kontener | Rola | Adres lokalny |
|---|---|---|
| `consul` | Rejestr usług (usługi zgłaszają się tu, żeby inne je znalazły) i konfiguracja usług (Key/Value). Ma interfejs WWW. | http://127.0.0.1:8500/ui |
| `consul-kv-seed` | Przy każdym starcie wgrywa do Consula pliki z `deploy/consul/config/` i kończy pracę (stan `Exited`). | – |
| `postgres` | PostgreSQL 17: osobna baza i osobny użytkownik dla 6 usług (lista w sekcji „Konwencje”). | `127.0.0.1:5432` |
| `redis-gateway` | Redis dla API Gateway (liczniki limitów żądań). Bez zapisu na dysk. | `127.0.0.1:6379` |

Pliki w folderze:
- `compose.yaml` – opis kontenerów;
- `create-secrets.sh` – tworzy lokalne hasła (`deploy/.env`) i klucze JWT (`deploy/secrets/`);
- `.env.example` – lista nazw haseł (bez wartości, tylko dla informacji);
- `consul/config/<usługa>.yaml` – konfiguracja usług wgrywana do Consula;
- `consul/seed-kv.sh` – skrypt, którym `consul-kv-seed` wgrywa konfigurację (nie uruchamia się go ręcznie);
- `postgres/init/01-service-databases.sh` – tworzy bazy i użytkowników przy pierwszym starcie;
- `k8s/`, `rabbitmq/` – na później. Kubernetes to ostatni etap projektu; do tego czasu infrastruktura i usługi działają w Docker Compose.

Usługi sklepu dojdą do tego samego `compose.yaml` w grupach (tzw. profilach): od etapu 2 profil `platform` (Auth, potem Gateway), w etapie 5 profil `full-shop` (cały sklep, w tym usługi z `platform`). Na razie startuje tylko infrastruktura z tabeli.

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
deploy/.env: created (8 variables)
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

**Krok 2.** Uruchom infrastrukturę:
```bash
docker compose -f deploy/compose.yaml up -d --wait
```
`-d` – działa w tle, `--wait` – polecenie kończy się dopiero, gdy kontenery są gotowe. Za pierwszym razem pobiera obrazy (kilka minut). Na końcu przy kontenerach jest `Healthy`, a przy `consul-kv-seed` – `Exited` (kontener kończy pracę po wgraniu konfiguracji).

**Krok 3.** Sprawdź stan:
```bash
docker compose -f deploy/compose.yaml ps
```
Wynik: trzy kontenery ze statusem `Up … (healthy)`. W skrócie (kolumny `SERVICE` i `STATUS`):
```
SERVICE         STATUS
consul          Up 12 minutes (healthy)
postgres        Up 12 minutes (healthy)
redis-gateway   Up 12 minutes (healthy)
```
`consul-kv-seed` nie ma na tej liście, bo już zakończył pracę. Jego stan (oczekiwany `exited 0`, czyli „zakończył się bez błędu”):
```bash
docker compose -f deploy/compose.yaml ps -a consul-kv-seed --format '{{.State}} {{.ExitCode}}'
```

## Jak sprawdzić, że działa

**Consul.** W przeglądarce http://127.0.0.1:8500/ui → zakładka **Key/Value** → folder `config/` → foldery `api-gateway/` i `auth-service/`, w każdym klucz `data` z treścią pliku z `deploy/consul/config/`.

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
Wynik: `PONG`. Redis ma hasło, dlatego zwykłe `redis-cli ping` odpowiada `NOAUTH Authentication required.`

## Codzienna praca

Zatrzymanie (kontenery zostają, start jest szybszy):
```bash
docker compose -f deploy/compose.yaml stop
```
Albo zatrzymanie i usunięcie kontenerów:
```bash
docker compose -f deploy/compose.yaml down
```
W obu przypadkach dane zostają: bazy w PostgreSQL i zawartość Consula przeżywają. Redis Gateway zaczyna zawsze pusty (celowo, bez zapisu na dysk).

Ponowny start – to samo polecenie co za pierwszym razem:
```bash
docker compose -f deploy/compose.yaml up -d --wait
```

**Zmiana konfiguracji usługi w Consulu:** edytuj plik `deploy/consul/config/<usługa>.yaml`, potem uruchom `docker compose -f deploy/compose.yaml up -d --wait`. Przy każdym `up` kontener `consul-kv-seed` wgrywa te pliki do Consula i nadpisuje to, co tam było. Zmiana zrobiona ręcznie w UI Consula działa więc tylko do następnego `up`. W tych plikach nie wpisuje się haseł.

## Reset od zera

```bash
docker compose -f deploy/compose.yaml down -v
docker compose -f deploy/compose.yaml up -d --wait
```
`-v` usuwa też dane: **wszystkie bazy w PostgreSQL (z tabelami i danymi) i całą zawartość Consula**. Po `up` bazy i użytkownicy powstają od nowa, puste. Plik `deploy/.env` i klucze w `deploy/secrets/` zostają.

Kiedy to potrzebne: po zmianie hasła w `deploy/.env` po pierwszym starcie. Bazy i użytkownicy powstają tylko przy pierwszym starcie na pustych danych, więc baza dalej ma stare hasło.

Bez utraty danych – zamiast `down -v` ustaw nowe hasła w bazie:
```bash
docker compose -f deploy/compose.yaml up -d --wait
docker compose -f deploy/compose.yaml exec -T postgres bash /docker-entrypoint-initdb.d/01-service-databases.sh
```
Pierwsze polecenie odtwarza kontener `postgres` z nowymi wartościami z `deploy/.env` (dane zostają). Drugie ustawia użytkownikom hasła według `deploy/.env` i tworzy brakujące bazy; istniejących baz nie rusza. Skrypt wypisuje najpierw linie `SET`, `ALTER ROLE`, `REVOKE` (wyniki kolejnych poleceń SQL), a na końcu `01-service-databases.sh: done (auth user product inventory order shipping)`.

## Konwencje

Obowiązują w kolejnych etapach (Auth, Gateway, usługi zespołu).

| Co | Wartość |
|---|---|
| Hosty w sieci compose (i później w k8s) | `consul`, `postgres`, `redis-gateway`; później `rabbitmq`, `mongo`, `redis-cart`, `mailpit` |
| Nazwa usługi w Consulu | = nazwa usługi w compose = nazwa obrazu (`auth-service`, `api-gateway`, …) |
| Zmienne usług – Consul | `CONSUL_HOST` (`consul`, lokalnie `127.0.0.1`), `CONSUL_PORT` (`8500`) |
| Zmienne usług – baza | `DB_HOST` (`postgres`), `DB_PORT` (`5432`), `DB_NAME` (`<s>_db`), `DB_USER` (`<s>_service`), `DB_PASSWORD` (w compose: `${<S>_DB_PASSWORD}`) |
| Zmienne Gateway – Redis | `REDIS_HOST` (`redis-gateway`), `REDIS_PORT` (`6379`), `REDIS_PASSWORD` (w compose: `${REDIS_GATEWAY_PASSWORD}`) |
| Usługa uruchomiona z VS Code (poza kontenerem) | łączy się z infrastrukturą przez `127.0.0.1` i porty z tabeli „Co tu jest” (5432, 8500, 6379); rejestruje się w Consulu z adresem `host.docker.internal` |
| Klucze JWT | `deploy/secrets/jwt-private.pem` (tylko Auth), `jwt-public.pem` |
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

Każdy użytkownik jest właścicielem tylko swojej bazy i nie może połączyć się z cudzą. Review i Notification dostaną MongoDB, Cart – osobny Redis (etap 5).

## Bezpieczeństwo

- Porty są wystawione tylko na `127.0.0.1` – z innych komputerów w sieci są niedostępne.
- `deploy/.env` i `deploy/secrets/` **nigdy nie trafiają do repo** (`.gitignore` je pomija) i nie są przekazywane innym osobom – każdy generuje własne.
- Usługi sklepu (od etapu 2/3) nie dostaną portów lokalnych. Z zewnątrz będzie dostępny tylko API Gateway.

## Gdy coś nie działa

**Zajęty port 5432, 8500 albo 6379** (w komunikacie `port is already allocated` albo `address already in use`). Ten port zajmuje inny kontener albo program, np. compose z `services/user-service/dev/compose.yaml` albo lokalnie zainstalowany PostgreSQL. Kontenery z ich portami:
```bash
docker ps --format '{{.Names}}  {{.Ports}}'
```
Kontenery o nazwach `k8s_…` to wewnętrzny Kubernetes Rancher Desktop – ich nie należy ruszać; szukaj nazwy z numerem portu (np. `5432`).
Zatrzymaj tamten zestaw (np. `docker compose -f services/user-service/dev/compose.yaml down`) albo pojedynczy kontener (`docker stop <nazwa>`), potem znowu `up -d --wait`.

**Brak haseł:** `required variable … is missing a value: Run deploy/create-secrets.sh`. Nie ma pliku `deploy/.env` albo ma puste wartości. Rozwiązanie:
```bash
bash deploy/create-secrets.sh
```

**`Permission denied` (w zsh: `permission denied`) przy `deploy/create-secrets.sh`.** Uruchamiaj zawsze przez `bash`, jak wyżej – wtedy działa także bez prawa wykonywania.

**`openssl not found. On Windows, run this script in Git Bash.`** (brak programu `openssl`). Na Windowsie skrypt uruchamia się w Git Bash (sekcja „Wymagania”), nie w PowerShell ani cmd.

**Consul: `No cluster leader`** (w UI albo w logach usługi). Consul zaraz po starcie wybiera lidera, co trwa ok. 10 sekund – potem odśwież. Z `--wait` polecenie `up` czeka na to samo.

**`service "consul-kv-seed" didn't complete successfully`** – nie udało się wgrać konfiguracji do Consula. Przyczyna w logach:
```bash
docker compose -f deploy/compose.yaml logs consul-kv-seed
```
Poprawny przebieg to linie `loaded config/<usługa>/data` – przy każdym `up` po jednej na plik z `deploy/consul/config/` (log zawiera wszystkie dotychczasowe uruchomienia, ostatnie są na końcu). Błąd zaczyna się od `Error!` (np. `Error! Failed writing data: …` – Consul nieosiągalny). Zwykle wystarcza ponowne `up -d --wait`. Uwaga: wgrywanie nie sprawdza składni YAML – plik z błędem trafi do Consula, a błąd zgłosi dopiero usługa przy starcie.

**Inne problemy:** logi wybranego kontenera:
```bash
docker compose -f deploy/compose.yaml logs postgres
```
(zamiast `postgres`: `consul`, `redis-gateway`, `consul-kv-seed`).
