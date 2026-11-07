# Lokalny zestaw User + Cart

Plik `compose.yaml` uruchamia dwa serwisy, ich lokalne magazyny danych i testowego Consula. Nie zastępuje wspólnych manifestów `deploy/` ani konfiguracji całego sklepu.

Z katalogu głównego repozytorium:

```sh
cp services/user-service/.env.example services/user-service/.env
# Ustaw DB_PASSWORD w services/user-service/.env.
docker compose --env-file services/user-service/.env -f services/user-service/dev/compose.yaml up --build -d
curl --fail http://localhost:8082/health/ready
curl --fail http://localhost:8085/health/ready
```

W PowerShell pierwsze polecenie: `Copy-Item services/user-service/.env.example services/user-service/.env`.

Porty lokalne: 5432, 6379, 8500, 8082 i 8085. Product i Inventory nie należą do tego zestawu. Dodawanie do koszyka wymaga Product podłączonego do tej samej sieci i zarejestrowanego w Consulu; testy automatyczne używają jego atrapy.

Wyłączenie bez usuwania danych:

```sh
docker compose --env-file services/user-service/.env -f services/user-service/dev/compose.yaml down
```

Opcja `-v` usuwa lokalne dane. Nie jest potrzebna do zwykłego wyłączenia.
