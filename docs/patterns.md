# Wzorce dla usług sklepu

Jak spełnić zasady z [decisions.md](decisions.md): praca nad usługą z VS Code przy infrastrukturze z Docker Compose, działający przykład w Pythonie (rejestracja w Consulu, konfiguracja z KV, logi, zdrowie), konfiguracja dla Javy, wywołanie innej usługi, wpis usługi w compose, migracje, outbox, pokaz load balancingu, Swagger i walidacja wejścia. Zdarzenia RabbitMQ (nadawca i odbiorca): [events.md](events.md). Infrastruktura (start, hasła, porty): [deploy/README.md](../deploy/README.md).

Wszystkie polecenia uruchamia się z katalogu głównego repo, chyba że opis mówi inaczej. Na Windowsie — w Git Bash.

## 1. Usługa z VS Code przy infrastrukturze z compose

Do czasu scalenia PR usługa nie ma wpisu w `deploy/compose.yaml` ([D6](decisions.md#d6--konwencje-deploy-i-zmienne-środowiskowe)). Pracuje się więc tak: infrastruktura (bazy, Consul, RabbitMQ, Mailpit) działa w Docker Compose, a usługa — na laptopie, uruchomiona z VS Code albo z terminala.

Start infrastruktury (pierwszy raz i po każdej aktualizacji repo — szczegóły w [deploy/README.md](../deploy/README.md)):

```bash
bash deploy/create-secrets.sh
docker compose -f deploy/compose.yaml up -d --wait
```

### Zmienne: compose i VS Code

Ta sama usługa dostaje inne wartości w compose (nazwy kontenerów w sieci `backend`) i na laptopie (`127.0.0.1` i porty z [deploy/README.md](../deploy/README.md)). Nazwy zmiennych to zalecenie z [D6](decisions.md#d6--konwencje-deploy-i-zmienne-środowiskowe); usługa może czytać inne.

| Zależność | Zmienne | W compose | Z VS Code |
|---|---|---|---|
| PostgreSQL (User, Product, Inventory, Order, Shipping) | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | `postgres`, `5432`, `<s>_db`, `<s>_service`, hasło `<S>_DB_PASSWORD` | `127.0.0.1`, `5432`, reszta bez zmian |
| MongoDB (Review, Notification) | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`; w adresie `authSource` = `DB_NAME` | `mongo`, `27017`, `<s>_db`, `<s>_service`, hasło `<S>_DB_PASSWORD` | `127.0.0.1`, `27017`, reszta bez zmian |
| Redis koszyka (Cart) | `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | `redis-cart`, `6379`, hasło `REDIS_CART_PASSWORD` | `127.0.0.1`, **`6380`**, to samo hasło |
| RabbitMQ (usługi ze zdarzeniami) | `RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD` | `rabbitmq`, `5672`, `<s>-service`, hasło `<S>_RABBITMQ_PASSWORD` | `127.0.0.1`, `5672`, reszta bez zmian |
| Consul | `CONSUL_HOST`, `CONSUL_PORT` | `consul`, `8500` | `127.0.0.1`, `8500` |
| SMTP (Notification) | `SMTP_HOST`, `SMTP_PORT` | `mailpit`, `1025` | `127.0.0.1`, `1025` |
| adres w Consulu | `SERVICE_ADDRESS` | pusty — usługa podaje własny IP | **`host.docker.internal`** |
| adres nasłuchu serwera HTTP | `HOST` (w przykładzie z sekcji 2; Spring Boot `server.address`, Node.js `host` w `listen`) | `0.0.0.0` | **`127.0.0.1`** |
| port usługi | `PORT` | port z tabeli usług (8082–8089) | ten sam |

`<s>` to krótka nazwa usługi (np. `review`), `<S>` — ta sama wielkimi literami. Hasła są w `deploy/.env` (poza repo); w compose wpis usługi podaje je przez zmienną, z VS Code trafiają do lokalnego `.env` usługi (niżej).

Dwie rzeczy różnią usługę na laptopie od usługi w kontenerze:

- **`SERVICE_ADDRESS=host.docker.internal`.** Consul działa w kontenerze i sprawdza `/health/ready` usługi pod adresem z rejestracji. `127.0.0.1` w kontenerze Consula to sam Consul, a `host.docker.internal` to laptop.
- **Serwer HTTP nasłuchuje na `127.0.0.1`**, nie na `0.0.0.0` (uvicorn: `--host 127.0.0.1`, w przykładzie z sekcji 2 domyślnie, bez ustawiania `HOST`; Spring Boot: `server.address=127.0.0.1`; Node.js: `host: '127.0.0.1'` w `listen`). To adres nasłuchu — co innego niż `SERVICE_ADDRESS`, czyli adres zapisany w Consulu. Rancher Desktop przekazuje połączenia z kontenerów na `host.docker.internal` do `127.0.0.1` laptopa, więc Consul i Gateway dochodzą do usługi (sprawdzone na Rancher Desktop). Przy `0.0.0.0` port usługi byłby osiągalny z sieci lokalnej: każdy w tej samej sieci Wi-Fi mógłby wysłać do usługi żądanie z dowolnym `X-User-Roles` (np. `ADMIN,SERVICE`), bo usługa ufa tym nagłówkom ([D11](decisions.md#d11--tożsamość-i-nagłówki)). Gdy check w Consulu zostaje `critical` mimo `127.0.0.1` (np. na Docker Desktop zamiast Rancher Desktop), zgłoś to Michałowi — nie zmieniaj adresu na `0.0.0.0`.

**Zapora macOS.** Jeśli macOS pyta, czy zezwolić aplikacji (`python3.12`, `java`, `node`) na połączenia przychodzące, usługa nasłuchuje na `0.0.0.0` — zamiast zezwalać, popraw adres na `127.0.0.1`.

Na czas pracy z VS Code instancja tej samej usługi z compose (po scaleniu PR) powinna być zatrzymana, np. `docker compose -f deploy/compose.yaml --profile full-shop stop review-service`. Inaczej obie są w Consulu pod tą samą nazwą i Gateway kieruje ruch na zmianę do jednej i drugiej.

### Hasła do lokalnego .env usługi

Hasło kopiuje się z `deploy/.env` do pliku `.env` w folderze usługi tak, żeby nie pojawiło się na ekranie ani w historii poleceń. Przykład dla Review, z folderu `services/review-service`:

```bash
printf 'DB_PASSWORD=%s\n' "$(grep '^REVIEW_DB_PASSWORD=' ../../deploy/.env | cut -d= -f2-)" >> .env
git check-ignore -q .env && echo IGNORED
```

Wynik drugiego polecenia: `IGNORED` (główny `.gitignore` wyklucza `.env` w każdym folderze). Pozostałe zmienne z tabeli dopisuje się zwykłym edytorem; w repo zostaje tylko `.env.example` z samymi nazwami. RabbitMQ — cztery linie według [events.md](events.md#konta-uprawnienia-i-zmienne). Hasło do jednorazowego uruchomienia w terminalu (bez pliku):

```bash
export DB_PASSWORD="$(grep '^REVIEW_DB_PASSWORD=' deploy/.env | cut -d= -f2-)"
```

To polecenie uruchamia się z katalogu głównego repo. Jak usługa wczytuje `.env` (biblioteka w kodzie albo `"envFile"` w `.vscode/launch.json`), wybiera jej właściciel. Hasła nie wkleja się do czatu, issue ani do repo.

### Sprawdzenie w Consulu

W przeglądarce http://127.0.0.1:8500/ui → **Services** → nazwa usługi. Instancja z VS Code ma adres `host.docker.internal` i port usługi, a jej check `/health/ready` — stan `passing` (zielony). Z terminala:

```bash
curl -s http://127.0.0.1:8500/v1/health/checks/review-service | grep -oE '"Status": ?"[a-z]+"'
```

Wynik: `"Status":"passing"` (jedna linia na instancję; przy kilku instancjach kilka linii). `critical` oznacza, że Consul nie dochodzi do usługi: sprawdź `SERVICE_ADDRESS=host.docker.internal`, port i to, czy usługa działa (`curl http://127.0.0.1:<port>/health/ready` na laptopie). Gdy to się zgadza, a check zostaje `critical`, zgłoś to Michałowi (punkt o `127.0.0.1` wyżej). Pusty wynik — usługa się nie zarejestrowała (log usługi).

### Ograniczenie: Gateway w kontenerze i usługa na laptopie

Oczekiwane zachowanie: Gateway z compose bierze z Consula adres `host.docker.internal:<port>` i przekazuje żądanie `/api/v1/<zasób>/…` do usługi na laptopie (nasłuch na `127.0.0.1`, w przykładzie domyślnie) — odpowiedź ma wtedy nagłówek `X-Instance-Id` usługi. Połączenie z kontenerów `consul` i `api-gateway` przez `host.docker.internal` do serwera na `127.0.0.1` laptopa sprawdzono na Rancher Desktop. **Cała droga przez Gateway do usługi zarejestrowanej z VS Code — niesprawdzona przy przygotowaniu tego dokumentu, sprawdzi Michał.**

Gdy Gateway odpowiada `502` (nie dochodzi do `host.docker.internal`), są dwa obejścia:

- Wołać usługę bezpośrednio, z nagłówkami, które normalnie dodaje Gateway ([D11](decisions.md#d11--tożsamość-i-nagłówki)), np.:

  ```bash
  curl -i -H 'X-User-Id: 0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e' -H 'X-User-Roles: CUSTOMER' http://127.0.0.1:8082/users/me
  ```

  (User Service na porcie 8082, ścieżka bez `/api/v1`).
- Uruchomić Gateway też z VS Code ([README Gateway, „Uruchomienie z VS Code”](../services/api-gateway/README.md#uruchomienie-z-vs-code)). Taki Gateway przekazuje ruch tylko do usług uruchomionych na laptopie.

## 2. Przykład w Pythonie: Consul, KV, logi, zdrowie

Działający przykład „kleju infrastruktury” usługi w FastAPI, bez logiki biznesowej ([D7](decisions.md#d7--format-i-kody-błędów), [D11](decisions.md#d11--tożsamość-i-nagłówki)–[D17](decisions.md#d17--kontener-i-zamykanie)). Co robi:

- przy starcie czyta konfigurację z Consul KV (`config/<usługa>/data`, YAML); kolejność: zmienne środowiskowe > KV > wartości domyślne; bez Consula albo bez klucza — wartości domyślne i ostrzeżenie w logu;
- uruchamia serwer HTTP, potem w tle rejestruje się w Consulu: ID `<usługa>-<hostname>`, adres = własny IP (albo `SERVICE_ADDRESS`), check `/health/ready` co 10 s; bez Consula działa dalej i ponawia rejestrację (po 1, 2, 4, 8, 15, 15 … s); co 15 s sprawdza, czy wpis istnieje z aktualnym adresem, i rejestruje się ponownie, gdy go nie ma;
- każda odpowiedź (także błąd) ma `X-Request-Id` (przyjęty, gdy pasuje do `^[A-Za-z0-9._-]{1,64}$`, inaczej nowy UUID) i `X-Instance-Id` (ID instancji);
- logi JSON na stdout (`time`, `level`, `service`, `requestId`, `userId`, `msg`), jedna linia na każde żądanie poza `/health/*`; `userId` z `X-User-Id`, tylko gdy to poprawny UUID; poziom `logLevel` dotyczy logów usługi i uvicorna, biblioteki (np. `httpx`, sterowniki baz) zapisują tylko ostrzeżenia i błędy; przy nieoczekiwanym wyjątku w logu jest jego typ i miejsca w kodzie, bez treści wyjątku;
- czyta tożsamość z `X-User-Id` i `X-User-Roles` w jednym miejscu — zależności FastAPI `identity`, `logged_in` (401 bez logowania) i `service_only` (403 bez roli `SERVICE`), opis niżej;
- błędy w formacie zespołu: walidacja 400 `VALIDATION_ERROR` (zamiast 422 FastAPI), nieznana ścieżka 404, zła metoda 405, nieoczekiwany wyjątek 500 bez szczegółów; bez przekierowań przy `/` na końcu; `HEAD` jak `GET`;
- po SIGTERM (np. `docker stop`) kończy żądania, wyrejestrowuje się z Consula i kończy pracę w ok. 1 s.

Endpointy: `GET /health/live`, `GET /health/ready` (zawsze `{"status":"UP"}` — w usłudze sprawdzenie bazy w `is_ready()`), `GET /example/config` (ustawienia po KV i zmiennych — do sprawdzenia odczytu KV), `GET /example/items/{item_id}` (tylko do pokazania walidacji: identyfikator, który nie jest UUID → 400, [D1](decisions.md#d1--identyfikatory)), `GET /example/me` (wymaga logowania: zwraca `userId` i role), `GET /example/internal` (endpoint wewnętrzny: tylko z rolą `SERVICE`), `/docs` (Swagger).

Zmienne środowiskowe (wszystkie opcjonalne, przykład nie ma sekretów):

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `SERVICE_NAME` | `example-service` | nazwa w Consulu i klucz KV `config/<nazwa>/data` |
| `HOST` | `127.0.0.1` | adres nasłuchu HTTP; domyślnie **`127.0.0.1`** — z VS Code usługa jest osiągalna tylko z laptopa (sekcja 1); obraz ustawia `ENV HOST=0.0.0.0` (`Dockerfile`), bo w kontenerze Consul i Gateway łączą się z innych kontenerów |
| `PORT` | `8090` | port HTTP |
| `CONSUL_HOST`, `CONSUL_PORT` | `consul`, `8500` | agent Consula |
| `SERVICE_ADDRESS` | pusty | adres w Consulu; pusty = własny IP (adres, przez który instancja łączy się z Consulem) |
| `INSTANCE_ID` | `<nazwa>-<hostname>` | ID instancji w Consulu i w `X-Instance-Id` |
| `LOG_LEVEL` | — | `debug`, `info`, `warning` albo `error`; nadpisuje `logLevel` z KV (domyślnie `info`); dotyczy logów usługi i uvicorna, nie bibliotek |

### Pliki przykładu

Cztery pliki w jednym folderze. Ten sam kod był uruchomiony i sprawdzony w kontenerze (rejestracja, KV, nagłówki, tożsamość i role, logi, start bez Consula, ponowna rejestracja, zatrzymanie, dwie instancje).

```python
# example_service.py: Consul registration, KV, logs, identity and health (docs/patterns.md)
"""Infrastructure code of a shop service, without business logic (Python 3.12, FastAPI).

Registration in Consul with the instance's own IP address (also when Consul starts later),
configuration from Consul KV, X-Request-Id and X-Instance-Id, JSON logs, X-User-Id and X-User-Roles,
/health/live and /health/ready, the error format of the team, deregistration on SIGTERM.
Settings from the environment: SERVICE_NAME, HOST, PORT, CONSUL_HOST, CONSUL_PORT, SERVICE_ADDRESS,
INSTANCE_ID, LOG_LEVEL. Start: python example_service.py
"""

import asyncio
import json
import logging
import os
import re
import socket
import sys
import time
import traceback
import uuid
from contextlib import asynccontextmanager, suppress
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from typing import Annotated

import httpx
import uvicorn
import yaml
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

SERVICE_NAME = os.environ.get("SERVICE_NAME", "example-service")
# 127.0.0.1 by default: started from VS Code, the service is reachable only from this laptop.
# On 0.0.0.0 the laptop's port is open to the local network, and anyone there could call the
# service directly with any X-User-Roles (e.g. ADMIN,SERVICE). The image sets HOST=0.0.0.0
# (Dockerfile): in a container Consul and the Gateway connect from other containers.
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8090"))
CONSUL_HOST = os.environ.get("CONSUL_HOST", "consul")
CONSUL_PORT = int(os.environ.get("CONSUL_PORT", "8500"))
# Empty: the IP address of this instance on the route to Consul (see own_address).
SERVICE_ADDRESS = os.environ.get("SERVICE_ADDRESS", "")
# Unique per instance: with --scale every container has its own hostname.
INSTANCE_ID = os.environ.get("INSTANCE_ID") or f"{SERVICE_NAME}-{socket.gethostname()}"

DEFAULT_SETTINGS = {"logLevel": "info"}
LOG_LEVELS = ("debug", "info", "warning", "error")
CONSUL_TIMEOUT = 2.0  # seconds; every call to another service has a 2 s timeout
REGISTRATION_CHECK_SECONDS = 15  # how often the entry in Consul is checked
MAX_RETRY_SECONDS = 15  # the longest pause between attempts while Consul is unreachable
REQUEST_ID_PATTERN = re.compile(r"[A-Za-z0-9._-]{1,64}")  # the same rule as in the Gateway
ERROR_CODES = {
    400: "VALIDATION_ERROR",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    415: "UNSUPPORTED_MEDIA_TYPE",
    429: "TOO_MANY_REQUESTS",
    500: "INTERNAL_ERROR",
    503: "SERVICE_UNAVAILABLE",
}

# Set by the middleware for each request: every log line written while handling it has them.
request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
user_id_var: ContextVar[str | None] = ContextVar("user_id", default=None)


class JsonFormatter(logging.Formatter):
    """One JSON line per log entry. Never log passwords, tokens or personal data."""

    def format(self, record: logging.LogRecord) -> str:
        line = {
            "time": datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "service": SERVICE_NAME,
            "requestId": request_id_var.get(),
            "userId": user_id_var.get(),
            "msg": record.getMessage(),
        }
        line |= getattr(record, "fields", {})
        if record.exc_info:
            # The type and the frames (file:line function), without the message of the exception and
            # without source lines: errors of database drivers contain the values (e.g. the e-mail
            # address that broke a unique index).
            _, exc, exc_traceback = record.exc_info
            line["reason"] = type(exc).__name__
            line["stack"] = [f"{f.filename}:{f.lineno} {f.name}" for f in traceback.extract_tb(exc_traceback)]
        return json.dumps(line, default=str)


handler = logging.StreamHandler(sys.stdout)
handler.setFormatter(JsonFormatter())
# Libraries log only warnings and errors, also when logLevel is debug: httpx and httpcore write a line for every
# request, database drivers (pymongo, sqlalchemy) whole commands with personal data.
logging.basicConfig(level=logging.WARNING, handlers=[handler])
logging.captureWarnings(True)  # warnings of libraries as JSON lines, too
# logLevel applies to these loggers only. A service whose modules use logging.getLogger(__name__)
# adds its package here (e.g. "app").
SERVICE_LOGGERS = (SERVICE_NAME, "uvicorn")
for name in SERVICE_LOGGERS:
    logging.getLogger(name).setLevel(logging.INFO)  # until the settings are loaded
logger = logging.getLogger(SERVICE_NAME)


def reason(exc: Exception) -> dict:
    """Log fields for an error of Consul or of the configuration: the class and the message, without
    a stack trace. Not for database errors: their message can contain personal data."""
    return {"fields": {"reason": f"{type(exc).__name__}: {exc}"}}


async def load_settings(consul: httpx.AsyncClient) -> dict:
    """Defaults < Consul KV (key config/<service>/data, YAML) < environment variables.
    Read once at startup; without Consul or without the key the service uses the defaults."""
    settings = dict(DEFAULT_SETTINGS)
    try:
        response = await consul.get(f"/v1/kv/config/{SERVICE_NAME}/data", params={"raw": "true"})
        if response.status_code == 404:
            logger.warning("No configuration in Consul KV, using defaults")
        else:
            response.raise_for_status()
            values = yaml.safe_load(response.text) or {}
            if not isinstance(values, dict):
                raise ValueError("the value is not a YAML mapping")
            settings |= values
    except (httpx.HTTPError, yaml.YAMLError, ValueError) as exc:
        logger.warning("Configuration from Consul KV not loaded, using defaults", extra=reason(exc))
    if os.environ.get("LOG_LEVEL"):
        settings["logLevel"] = os.environ["LOG_LEVEL"]

    level = str(settings["logLevel"]).lower()
    if level not in LOG_LEVELS:
        logger.warning("Unknown log level, using info", extra={"fields": {"logLevel": level}})
        level = "info"
    settings["logLevel"] = level
    for name in SERVICE_LOGGERS:
        logging.getLogger(name).setLevel(level.upper())
    return settings


def own_address() -> str:
    """The IP address of this instance that Consul can reach: the local address of the route
    to Consul. connect() of a UDP socket only chooses the route, no packet is sent.
    Not the service name from compose (all instances of --scale would share it) and not the
    first address of the container (a container in two networks has two)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.connect((CONSUL_HOST, CONSUL_PORT))
        address = sock.getsockname()[0]
    if address.startswith("127."):
        raise RuntimeError("the route to Consul uses a loopback address, set SERVICE_ADDRESS")
    return address


async def is_ready() -> bool:
    """Can this instance handle requests? In a real service: a short query to its own database
    (e.g. SELECT 1 with a 2 s timeout). Not the broker and not other services."""
    return True


async def is_registered(consul: httpx.AsyncClient, address: str) -> bool:
    response = await consul.get(f"/v1/agent/service/{INSTANCE_ID}")
    if response.status_code == 404:
        return False
    response.raise_for_status()
    service = response.json()
    # After a restart the same ID (same hostname) can still point to an old address.
    return service.get("Address") == address and service.get("Port") == PORT


async def register(consul: httpx.AsyncClient, address: str) -> None:
    # Consul runs a new check only after up to one interval: until then it has this status.
    status = "passing" if await is_ready() else "critical"
    response = await consul.put(
        "/v1/agent/service/register",
        json={
            "ID": INSTANCE_ID,
            "Name": SERVICE_NAME,
            "Address": address,
            "Port": PORT,
            "Check": {
                "HTTP": f"http://{address}:{PORT}/health/ready",
                "Interval": "10s",
                "Timeout": "2s",
                "DeregisterCriticalServiceAfter": "1m",
                "Status": status,
            },
        },
    )
    response.raise_for_status()
    logger.info("Registered in Consul", extra={"fields": {"instanceId": INSTANCE_ID, "address": address}})


async def keep_registered(consul: httpx.AsyncClient) -> None:
    """Background task: registers the instance, then every 15 s checks that the entry still
    exists with the current address (Consul restarted, entry removed) and registers it again.
    While Consul is unreachable: one warning, attempts after 1, 2, 4, 8, 15, 15 ... s."""
    consul_reachable = True
    retry_in = 1
    while True:
        try:
            # The DNS lookup inside connect() blocks, so it runs in a thread (at most 2 s).
            address = SERVICE_ADDRESS or await asyncio.wait_for(asyncio.to_thread(own_address), CONSUL_TIMEOUT)
            if not await is_registered(consul, address):
                await register(consul, address)
            if not consul_reachable:
                consul_reachable = True
                logger.info("Consul is reachable again")
            retry_in = 1
            await asyncio.sleep(REGISTRATION_CHECK_SECONDS)
        except Exception as exc:  # never ends the task: one warning per outage, then retries
            if consul_reachable:
                consul_reachable = False
                logger.warning("Consul is not reachable, will retry the registration", extra=reason(exc))
            await asyncio.sleep(retry_in)
            retry_in = min(retry_in * 2, MAX_RETRY_SECONDS)


async def deregister(consul: httpx.AsyncClient) -> None:
    try:
        response = await consul.put(f"/v1/agent/service/deregister/{INSTANCE_ID}")
        response.raise_for_status()
        logger.info("Deregistered from Consul", extra={"fields": {"instanceId": INSTANCE_ID}})
    except httpx.HTTPError as exc:
        logger.warning("Deregistration from Consul failed", extra=reason(exc))


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with httpx.AsyncClient(base_url=f"http://{CONSUL_HOST}:{CONSUL_PORT}", timeout=CONSUL_TIMEOUT) as consul:
        app.state.settings = await load_settings(consul)
        # In the background, so the service answers requests also while Consul is down.
        registration = asyncio.create_task(keep_registered(consul))
        yield
        # Shutdown (SIGTERM, Ctrl+C): uvicorn no longer accepts requests and has finished the current ones.
        registration.cancel()
        with suppress(asyncio.CancelledError):
            await registration
        await deregister(consul)


# redirect_slashes=False: /example/config/ is 404, not a redirect (the Gateway rejects a trailing /).
app = FastAPI(title=SERVICE_NAME, lifespan=lifespan, redirect_slashes=False)


def error_response(status: int, message: str, headers: dict[str, str] | None = None) -> JSONResponse:
    """The error format of the team: {"status", "error", "message", "requestId"}."""
    error = ERROR_CODES.get(status) or HTTPStatus(status).phrase.upper().replace(" ", "_").replace("-", "_")
    body = {"status": status, "error": error, "message": message, "requestId": request_id_var.get()}
    return JSONResponse(body, status_code=status, headers=headers)


def valid_uuid(value: str | None) -> str | None:
    """The value as a UUID in lowercase text, or None when it is missing or not a UUID."""
    try:
        return str(uuid.UUID(value)) if value else None
    except ValueError:
        return None


@app.middleware("http")
async def request_context(request: Request, call_next):
    """X-Request-Id and X-Instance-Id on every response (also errors), one log line per request."""
    received = request.headers.get("x-request-id", "")
    request_id = received if REQUEST_ID_PATTERN.fullmatch(received) else str(uuid.uuid4())
    request_id_var.set(request_id)
    # Only a valid UUID goes to the logs: a request that bypasses the Gateway can send any text.
    user_id_var.set(valid_uuid(request.headers.get("x-user-id")))
    started = time.monotonic()
    try:
        response = await call_next(request)
    except Exception:
        # Unexpected error: the client gets the team format without details, the log the type and
        # the stack trace (JsonFormatter). Expected errors (e.g. a duplicate: 409) are handled in endpoints.
        logger.exception("Unhandled error")
        response = error_response(500, "Internal server error")
    response.headers["X-Request-Id"] = request_id
    response.headers["X-Instance-Id"] = INSTANCE_ID
    if not request.url.path.startswith("/health/"):
        fields = {
            "method": request.method,
            "path": request.url.path,
            "status": response.status_code,
            "durationMs": round((time.monotonic() - started) * 1000),
        }
        logger.info("Request completed", extra={"fields": fields})
    return response


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    # FastAPI answers 422 by default; the team uses 400 VALIDATION_ERROR.
    message = "; ".join(f"{'.'.join(map(str, error['loc']))}: {error['msg']}" for error in exc.errors())
    return error_response(400, message)


@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    # 404 unknown path, 405 wrong method, and HTTPException raised in endpoints and dependencies.
    return error_response(exc.status_code, str(exc.detail), exc.headers)


@dataclass(frozen=True)
class Identity:
    """Who sends the request: X-User-Id and X-User-Roles, set only by the Gateway (D11)."""

    user_id: uuid.UUID | None  # None: an anonymous client or work in the background
    roles: frozenset[str]


async def identity(
    x_user_id: Annotated[uuid.UUID | None, Header()] = None,
    x_user_roles: Annotated[str, Header()] = "",
) -> Identity:
    """Reads the headers in one place. An X-User-Id that is not a UUID gives 400 VALIDATION_ERROR.
    X-User-Roles is a comma-separated list: check a role with `"ADMIN" in roles`, never compare
    the whole header or search it as text ("XSERVICE" and "CUSTOMER SERVICE" do not contain SERVICE).
    A public endpoint uses this dependency directly: it works without the headers."""
    roles = frozenset(role.strip() for role in x_user_roles.split(",") if role.strip())
    return Identity(x_user_id, roles)


async def logged_in(who: Annotated[Identity, Depends(identity)]) -> Identity:
    """An endpoint that requires login: without X-User-Id 401 UNAUTHORIZED."""
    if who.user_id is None:
        raise HTTPException(401, "Login required")
    return who


async def service_only(who: Annotated[Identity, Depends(identity)]) -> Identity:
    """An internal endpoint, called only by other services (D10): without SERVICE 403 FORBIDDEN.
    X-User-Id is not required: work in the background (e.g. an event consumer) sends only SERVICE.
    A dependency runs before the request body is validated, so a client gets 403, not 400."""
    if "SERVICE" not in who.roles:
        raise HTTPException(403, "Only for other services")
    return who


@app.get("/health/live")
async def health_live() -> dict:
    """The process works; no dependencies are checked."""
    return {"status": "UP"}


@app.get("/health/ready")
async def health_ready():
    if not await is_ready():
        return error_response(503, "Service is not ready")
    return {"status": "UP"}


# FastAPI does not answer HEAD on a GET route (405), so API routes get @app.head as well.
@app.head("/example/config")
@app.get("/example/config")
async def example_config(request: Request) -> dict:
    """Settings after defaults, Consul KV and environment variables."""
    return request.app.state.settings


@app.head("/example/items/{item_id}")
@app.get("/example/items/{item_id}")
async def example_item(item_id: uuid.UUID) -> dict:
    """Validation: an identifier that is not a UUID gives 400 VALIDATION_ERROR."""
    return {"id": str(item_id)}


@app.head("/example/me")
@app.get("/example/me")
async def example_me(who: Annotated[Identity, Depends(logged_in)]) -> dict:
    """The logged-in user. Ownership of data (D11): a customer sees and changes only own resources,
    so a query compares the owner with who.user_id (e.g. WHERE user_id = :user_id);
    with "ADMIN" in who.roles the endpoint may allow more."""
    return {"userId": who.user_id, "roles": sorted(who.roles)}


@app.head("/example/internal")
@app.get("/example/internal")
async def example_internal(who: Annotated[Identity, Depends(service_only)]) -> dict:
    """An internal endpoint: only with SERVICE in X-User-Roles, with or without X-User-Id."""
    return {"userId": who.user_id, "roles": sorted(who.roles)}


if __name__ == "__main__":
    # log_config=None: uvicorn's own lines go through the JSON format above.
    # timeout_graceful_shutdown: after SIGTERM requests get at most 5 s, so the stop takes < 10 s.
    uvicorn.run(app, host=HOST, port=PORT, log_config=None, access_log=False, timeout_graceful_shutdown=5)
```

```text
# requirements.txt
fastapi==0.162.0
uvicorn==0.54.0
httpx==0.28.1
PyYAML==6.0.3
```

```dockerfile
# Dockerfile
FROM python:3.12-slim
WORKDIR /app
# Dependencies first: this layer is rebuilt only when requirements.txt changes.
COPY requirements.txt .
RUN pip install --no-cache-dir --root-user-action=ignore -r requirements.txt
COPY example_service.py .
# A numeric user without root: Kubernetes (runAsNonRoot) can check it without /etc/passwd.
USER 10001
EXPOSE 8090
# All interfaces in a container: Consul and the Gateway connect from other containers.
# The code defaults to 127.0.0.1 (safe when started from VS Code).
ENV HOST=0.0.0.0
# Exec form: Python is process 1 and gets SIGTERM directly (no shell in between).
CMD ["python", "example_service.py"]
```

```text
# .dockerignore
# Local secrets, environments, caches and tests never go into the image.
# **/ matches in every folder of the build context, also in the top one (app/.env as well as .env).
**/.env
**/.env.*
**/.venv
**/venv
**/__pycache__
**/*.pyc
**/.pytest_cache
**/tests
.git
```

### Tożsamość i role

Nagłówki `X-User-Id` i `X-User-Roles` ustawia tylko Gateway ([D11](decisions.md#d11--tożsamość-i-nagłówki)). Usługa czyta je w jednym miejscu — w zależnościach FastAPI z przykładu, które endpoint dostaje przez `Depends`:

| Zależność | Do jakiego endpointu | Zachowanie |
|---|---|---|
| `identity` | publiczny, który może skorzystać z tożsamości | działa bez nagłówków (brak `user_id`, pusty zbiór ról); `X-User-Id`, który nie jest UUID → 400 `VALIDATION_ERROR` |
| `logged_in` | wymagający logowania | jak `identity`, a bez `X-User-Id` → 401 `UNAUTHORIZED` |
| `service_only` | wewnętrzny ([D10](decisions.md#d10--endpointy-wewnętrzne)) | jak `identity`, a bez roli `SERVICE` → 403 `FORBIDDEN`; `X-User-Id` nie jest wymagany (praca w tle, np. odbiorca zdarzeń, wysyła samo `SERVICE`) |

- **Role to zbiór** z `X-User-Roles` podzielonego po przecinku (spacje wokół nazw są pomijane). Rolę sprawdza się przez `"SERVICE" in who.roles`, nigdy porównaniem całego nagłówka (`== "SERVICE"` odrzuci `CUSTOMER,SERVICE` od usługi, która woła w imieniu klienta) ani szukaniem tekstu w nagłówku (przepuści `XSERVICE`). Wielkość liter ma znaczenie: `service` to nie `SERVICE`.
- **Najpierw rola, potem treść żądania.** Zależność wykonuje się przed walidacją treści, więc klient bez uprawnień dostaje 403, a nie 400 z opisem pól. Wyjątek: treść, która nie jest poprawnym JSON-em, FastAPI odrzuca (400) jeszcze przed zależnościami.
- **Własność danych** ([D11](decisions.md#d11--tożsamość-i-nagłówki)): klient widzi i zmienia tylko swoje zasoby — zapytanie porównuje właściciela z `who.user_id` (np. `WHERE user_id = :user_id`), a `"ADMIN" in who.roles` może pozwolić na więcej. Cudzy zasób → 403 albo 404.

Sprawdzenie: polecenia z `/example/me` i `/example/internal` w następnej części.

### Uruchomienie w kontenerze

Przy działającej infrastrukturze (sekcja 1). Utwórz folder roboczy poza repo: `mkdir -p /tmp/example-service` i zapisz w nim cztery bloki wyżej jako pliki o nazwach z pierwszej linii bloku (`example_service.py`, `requirements.txt`, `Dockerfile`, `.dockerignore`). Potem:

```bash
docker build -t example-service:dev /tmp/example-service
docker run --rm --entrypoint find example-service:dev /app -name '.env*'
curl -s -X PUT --data-binary 'logLevel: debug' http://127.0.0.1:8500/v1/kv/config/example-service/data
docker run -d --name example-1 --network sklep_backend -e CONSUL_HOST=consul example-service:dev
sleep 12
curl -s http://127.0.0.1:8500/v1/catalog/service/example-service | grep -oE '"Service(ID|Address|Port)": ?("[^"]*"|[0-9]+)'
curl -s http://127.0.0.1:8500/v1/health/checks/example-service | grep -oE '"Status": ?"[a-z]+"'
```

`find` sprawdza, że w obrazie nie ma plików `.env` (także z podfolderów — dlatego wzorce w `.dockerignore` zaczynają się od `**/`): wynik pusty. To samo sprawdzenie dla własnej usługi: `docker run --rm --entrypoint find <obraz> <katalog aplikacji> -name '.env*'`. `curl -X PUT` zapisuje w Consul KV przykładową konfigurację (wynik: `true`). `--network sklep_backend` to sieć `backend` z compose: tu jest Consul, a kontener nie ma portu na laptopie (jak usługi zespołu). Wynik dwóch ostatnich poleceń: `"ServiceID":"example-service-<hostname>"`, `"ServiceAddress":"<IP kontenera>"` (np. `172.18.0.12`), `"ServicePort":8090` i `"Status":"passing"`. Ten sam IP pokazuje:

```bash
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' example-1
```

Żądania do przykładu z kontenera Consula (ma `curl` i jest w tej samej sieci):

```bash
docker compose -f deploy/compose.yaml exec -T consul curl -s -i -H 'X-Request-Id: test-1' http://example-1:8090/example/config
docker compose -f deploy/compose.yaml exec -T consul curl -s -o /dev/null -w '%{http_code}\n' http://example-1:8090/example/config/
docker compose -f deploy/compose.yaml exec -T consul curl -s -X POST http://example-1:8090/example/config
docker compose -f deploy/compose.yaml exec -T consul curl -s http://example-1:8090/example/items/123
docker logs example-1 | grep test-1
```

Wyniki:

| Polecenie | Wynik |
|---|---|
| `GET /example/config` | `200`, nagłówki `x-request-id: test-1` i `x-instance-id: example-service-<hostname>`, treść `{"logLevel":"debug"}` (wartość z KV) |
| `GET /example/config/` | `404` (nie przekierowanie `307`) |
| `POST /example/config` | `{"status":405,"error":"METHOD_NOT_ALLOWED","message":"Method Not Allowed","requestId":"…"}` |
| `GET /example/items/123` | `{"status":400,"error":"VALIDATION_ERROR","message":"path.item_id: Input should be a valid UUID, …","requestId":"…"}` |
| `docker logs … \| grep test-1` | linia JSON: `"level": "info"`, `"service": "example-service"`, `"requestId": "test-1"`, `"msg": "Request completed"`, `"status": 200` |

Tożsamość i role (nagłówki, które normalnie ustawia Gateway). Funkcja `call_example` skraca polecenia i dopisuje kod odpowiedzi na końcu linii:

```bash
call_example() { docker compose -f deploy/compose.yaml exec -T consul curl -s -w ' %{http_code}\n' "$@"; }
U=0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e
call_example http://example-1:8090/example/me
call_example -H 'X-Request-Id: test-2' -H 'X-User-Id: not-a-uuid' http://example-1:8090/example/me
call_example -H "X-User-Id: $U" -H 'X-User-Roles: CUSTOMER' http://example-1:8090/example/me
call_example -H "X-User-Id: $U" -H 'X-User-Roles: CUSTOMER' http://example-1:8090/example/internal
call_example -H 'X-User-Roles: XSERVICE' http://example-1:8090/example/internal
call_example -H 'X-User-Roles: CUSTOMER SERVICE' http://example-1:8090/example/internal
call_example -H "X-User-Id: $U" -H 'X-User-Roles: CUSTOMER,SERVICE' http://example-1:8090/example/internal
call_example -H 'X-User-Roles: SERVICE' http://example-1:8090/example/internal
docker compose -f deploy/compose.yaml exec -T consul curl -s -I http://example-1:8090/example/me
docker logs example-1 | grep test-2
```

| Żądanie | Wynik |
|---|---|
| `/example/me` bez nagłówków | `{"status":401,"error":"UNAUTHORIZED","message":"Login required","requestId":"…"} 401` |
| `/example/me`, `X-User-Id: not-a-uuid` | `{"status":400,"error":"VALIDATION_ERROR","message":"header.x-user-id: Input should be a valid UUID, …","requestId":"test-2"} 400` |
| `/example/me`, UUID i `CUSTOMER` | `{"userId":"0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e","roles":["CUSTOMER"]} 200` |
| `/example/internal`, `CUSTOMER` | `{"status":403,"error":"FORBIDDEN","message":"Only for other services","requestId":"…"} 403` |
| `/example/internal`, `XSERVICE` albo `CUSTOMER SERVICE` (bez przecinka) | to samo `403` — żadna z tych wartości nie zawiera roli `SERVICE` |
| `/example/internal`, `CUSTOMER,SERVICE` | `{"userId":"0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e","roles":["CUSTOMER","SERVICE"]} 200` |
| `/example/internal`, samo `SERVICE` bez `X-User-Id` | `{"userId":null,"roles":["SERVICE"]} 200` |
| `curl -I` (`HEAD /example/me`) | `HTTP/1.1 401 Unauthorized`, nagłówki `x-request-id` i `x-instance-id`, bez treści |
| `docker logs … \| grep test-2` | linia JSON z `"userId": null` i `"status": 400` — wartość, która nie jest UUID, nie trafia do logu |

Zatrzymanie i sprzątanie:

```bash
time docker stop example-1
curl -s http://127.0.0.1:8500/v1/health/service/example-service
docker rm example-1 && docker rmi example-service:dev
curl -s -X DELETE 'http://127.0.0.1:8500/v1/kv/config/example-service?recurse'
```

`docker stop` trwa ok. 1 s (SIGTERM, wyrejestrowanie). Drugie polecenie zwraca `[]` — instancji nie ma już w Consulu. Ostatnie usuwa przykładowy klucz z KV (wynik: `true`).

Co jeszcze można sprawdzić: przykład uruchomiony przy zatrzymanym Consulu (`docker compose -f deploy/compose.yaml stop consul`) odpowiada na `/health/live`, a w logu ma jedno ostrzeżenie `Consul is not reachable, will retry the registration`; po `docker compose -f deploy/compose.yaml start consul` rejestruje się w ciągu kilkunastu sekund (`Registered in Consul`). Wpis usunięty ręcznie (`curl -s -X PUT http://127.0.0.1:8500/v1/agent/service/deregister/example-service-<hostname>`) wraca najpóźniej po ok. 15 s. Zatrzymanie Consula dotyczy całego lokalnego zestawu (Gateway, Auth) — po teście uruchom go z powrotem.

### Uruchomienie z VS Code

Potrzebny jest Python 3.12 (`python3.12 --version`). Z folderu z czterema plikami:

```bash
cd /tmp/example-service
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
CONSUL_HOST=127.0.0.1 SERVICE_ADDRESS=host.docker.internal .venv/bin/python example_service.py
```

Na Windowsie w Git Bash: `py -3.12` zamiast `python3.12` i `.venv/Scripts/` zamiast `.venv/bin/`. Bez `HOST` serwer nasłuchuje na `127.0.0.1` — tylko na laptopie, nie w sieci lokalnej (sekcja 1); w logu `Uvicorn running on http://127.0.0.1:8090`. Bez `SERVICE_ADDRESS` przykład nie zarejestruje się w Consulu: trasa do `127.0.0.1` prowadzi przez adres pętli zwrotnej, a w logu jest ostrzeżenie z powodem `the route to Consul uses a loopback address, set SERVICE_ADDRESS`.

W drugim terminalu: `curl -i http://127.0.0.1:8090/example/config`. W UI Consula (sekcja 1) instancja ma adres `host.docker.internal` i port `8090`. Zatrzymanie: Ctrl+C (przykład wyrejestrowuje się z Consula). Uruchomienie z laptopa nie było sprawdzane przy przygotowaniu dokumentu (sprawdzał go kontener); sprawdzi je Michał razem z [ograniczeniem z sekcji 1](#ograniczenie-gateway-w-kontenerze-i-usługa-na-laptopie).

### Co zmienić we własnej usłudze

- **Nazwa i port:** `SERVICE_NAME` i `PORT` (np. `review-service` i `8088`), w `Dockerfile` `EXPOSE` tego portu.
- **Adres nasłuchu:** w kodzie domyślnie `127.0.0.1`, w obrazie usługi `ENV HOST=0.0.0.0` (jak w `Dockerfile` przykładu) albo `--host 0.0.0.0` w `CMD` uvicorna. Bez tego usługa w kontenerze nie odpowiada innym kontenerom — check w Consulu zostaje `critical` (widoczny błąd, a nie otwarty port przy pracy z VS Code).
- **`is_ready()`:** krótkie zapytanie do własnej bazy z limitem 2 s (PostgreSQL `SELECT 1`, MongoDB `ping`, Redis `PING`); błąd → `False`, wtedy `/health/ready` odpowiada 503. Nie sprawdza brokera ani innych usług ([D15](decisions.md#d15--zdrowie-usługi)). Usługa z odbiorcą zdarzeń ([events.md](events.md#odbiorca-w-usłudze-fastapi)) uruchamia zadanie odbiorcy w `lifespan` przed zadaniem rejestracji (`app.state.consumer_task = asyncio.create_task(consumer.main())`, po `yield` — `app.state.consumer_task.cancel()`) i dopisuje jego warunek w `is_ready()`: `return <sprawdzenie bazy> and not app.state.consumer_task.done()`. Fragment z events.md robi to samo: warunek odbiorcy w `is_ready()`, a `health_ready` jak w przykładzie (503 w formacie [D7](decisions.md#d7--format-i-kody-błędów)).
- **Endpointy:** zamiast `/example/*` — własne. Każda trasa `GET` dostaje też `@app.head(...)`. Tożsamość tylko przez zależności `identity`, `logged_in` i `service_only` ([Tożsamość i role](#tożsamość-i-role)); endpoint publiczny nie dostaje `logged_in` — bez nagłówków działa dalej ([D11](decisions.md#d11--tożsamość-i-nagłówki)).
- **Ustawienia:** własne klucze w `DEFAULT_SETTINGS` i w pliku KV usługi `deploy/consul/config/<usługa>.yaml` (zmienia Michał). W KV nigdy haseł. Usługa z biblioteką **pydantic-settings** nie przekazuje wartości z KV przez `Settings(**kv)` przy domyślnej kolejności źródeł: wartości podane w konstruktorze wygrywają wtedy ze zmiennymi środowiskowymi (odwrotnie niż [D14](decisions.md#d14--konfiguracja-z-consul-kv)). Kolejność zmienia `settings_customise_sources`:

  ```python
  # Sketch: Consul KV behind environment variables in pydantic-settings (D14).
  from pydantic import AliasChoices, Field
  from pydantic_settings import BaseSettings


  class Settings(BaseSettings):
      # Environment variable LOG_LEVEL, key logLevel in Consul KV.
      log_level: str = Field("info", validation_alias=AliasChoices("LOG_LEVEL", "logLevel"))

      @classmethod
      def settings_customise_sources(
          cls, settings_cls, init_settings, env_settings, dotenv_settings, file_secret_settings
      ):
          # The first source wins: environment > .env file > values given to Settings(...) > defaults.
          return env_settings, dotenv_settings, init_settings


  settings = Settings(**kv)  # kv: the YAML mapping from config/<service>/data ({} without Consul)
  ```

  Sprawdzone w kontenerze (pydantic-settings 2.16.1): `LOG_LEVEL=debug` i `logLevel: warning` w KV → `debug`; bez `LOG_LEVEL` → `warning`; bez obu → `info`. `AliasChoices` łączy nazwę zmiennej środowiskowej (`LOG_LEVEL`) z kluczem w KV (`logLevel`).
- **Logi:** `logLevel` ustawia poziom tylko loggerów z `SERVICE_LOGGERS` (usługa i uvicorn). Usługa, której moduły tworzą logger przez `logging.getLogger(__name__)`, dopisuje tam nazwę swojego pakietu (np. `app`) — inaczej ich linie `info` nie trafią do logu. Logów bibliotek nie włącza się na `debug`, także przy szukaniu błędu: sterowniki baz (np. `pymongo`, `sqlalchemy`) zapisują wtedy całe polecenia z danymi osobowymi ([D16](decisions.md#d16--logi)).
- **Błędy bazy:** błąd, którego można się spodziewać (np. naruszenie unikalności — ten sam e-mail, błąd walidacji w sterowniku), obsługuje endpoint: np. `IntegrityError` (SQLAlchemy) albo `DuplicateKeyError` (pymongo) → 409 `CONFLICT` albo kod domenowy. Nie zostawia się go handlerowi 500. Treść takich wyjątków zawiera wartości (np. e-mail), dlatego przykład przy nieoczekiwanym wyjątku zapisuje w logu tylko jego typ (`reason`) i miejsca w kodzie (`stack`: plik, linia, funkcja), bez treści. Treści wyjątku (`str(exc)`) nie wpisuje się do logu ani do `message` odpowiedzi; funkcja `reason()` z przykładu (typ i treść) służy tylko do błędów Consula i konfiguracji.
- **Zależności:** `requirements.txt` przykładu przypina tylko pakiety używane wprost. W usłudze zamraża się pełną listę razem z zależnościami pośrednimi (np. `starlette`, `pydantic`): `pip-compile` z pakietu `pip-tools` (`requirements.in` → `requirements.txt`) albo `pip freeze > requirements.txt` w czystym venv po instalacji. Inaczej nowe wydanie zależności pośredniej zmienia obraz bez żadnej zmiany w repo.
- **Kody domenowe** ([rejestr](decisions.md#rejestr-kodów-domenowych), nowe zgłasza się Michałowi): `error_response` w przykładzie bierze kod ze statusu HTTP; usługa z kodem domenowym dodaje mu parametr na kod, np. `error_response(409, "Not enough stock", error="INSUFFICIENT_STOCK")`.
- **Podział na pliki:** dowolny (np. osobny moduł na Consul i logi) — struktura wnętrza usługi należy do jej właściciela.

Czego nie kopiować: `example-service` i portu `8090`, endpointów `/example/*` (`/example/config` pokazuje całą konfigurację — w usłudze niepotrzebne), `is_ready()` zawsze zwracającego `True`.

## 3. Java i Spring Boot (niesprawdzone)

Niesprawdzone w tym repo — do potwierdzenia przy pierwszej usłudze w Javie. Poniższa konfiguracja opisuje, jak spełnić [D13](decisions.md#d13--consul-rejestracja-i-wyszukiwanie)–[D17](decisions.md#d17--kontener-i-zamykanie) w Spring Boot; nie była uruchomiona.

Wersje: Java 21, Spring Boot 4.0.x, Spring Cloud 2025.1.x (nie Spring Boot 4.1). Zależności (Maven, wersje z BOM Spring Boot i Spring Cloud):

```xml
<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-actuator</artifactId></dependency>
<dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-validation</artifactId></dependency>
<dependency><groupId>org.springframework.cloud</groupId><artifactId>spring-cloud-starter-consul-discovery</artifactId></dependency>
<dependency><groupId>org.springframework.cloud</groupId><artifactId>spring-cloud-starter-consul-config</artifactId></dependency>
<dependency><groupId>io.micrometer</groupId><artifactId>micrometer-registry-prometheus</artifactId></dependency>
```

`application.yml` (przykład dla Product; hasła tylko ze zmiennych środowiskowych):

```yaml
server:
  port: ${PORT:8083}
  shutdown: graceful                  # after SIGTERM: finish current requests, then stop
spring:
  application:
    name: product-service             # name in Consul and the KV key config/product-service/data
  lifecycle:
    timeout-per-shutdown-phase: 5s    # whole stop < 10 s
  config:
    import: "optional:consul:"        # start also without Consul
  cloud:
    consul:
      host: ${CONSUL_HOST:consul}
      port: ${CONSUL_PORT:8500}
      config:
        format: YAML                  # the value of config/<name>/data is one YAML document
        fail-fast: false
      discovery:
        instance-id: ${spring.application.name}-${HOSTNAME:${random.value}}
        prefer-ip-address: true       # IP of the container, not the service name
        health-check-path: /health/ready
        health-check-interval: 10s
        health-check-timeout: 2s
        health-check-critical-timeout: 1m
        fail-fast: false
  datasource:
    url: jdbc:postgresql://${DB_HOST:postgres}:${DB_PORT:5432}/${DB_NAME:product_db}
    username: ${DB_USER:product_service}
    password: ${DB_PASSWORD}
logging:
  level:
    root: ${LOG_LEVEL:${logLevel:info}}   # environment > KV (logLevel) > info; Spring uses warn, not warning
  structured:
    format:
      console: ecs                    # JSON logs on stdout
management:
  endpoints:
    web:
      exposure:
        include: health,prometheus    # /actuator/prometheus
  endpoint:
    health:
      probes:
        enabled: true
      group:
        live:
          include: livenessState
          additional-path: "server:/health/live"
        ready:
          include: readinessState,db
          additional-path: "server:/health/ready"
```

Do sprawdzenia przy pierwszej usłudze:

- **Nazwa startera web:** w Spring Boot 4 starter MVC może się nazywać `spring-boot-starter-webmvc`, a `spring-boot-starter-web` może być oznaczony jako przestarzały. Właściwą nazwę pokazuje projekt wygenerowany w https://start.spring.io dla Spring Boot 4.0.x.
- **Start bez Consula:** przy `fail-fast: false` usługa startuje bez Consula, ale Spring Cloud Consul prawdopodobnie nie ponawia rejestracji, która nie udała się przy starcie — usługa nie pojawi się w Consulu do restartu ([D13](decisions.md#d13--consul-rejestracja-i-wyszukiwanie) wymaga ponawiania). Do sprawdzenia razem z ponowną rejestracją (punkt niżej).
- **Adres instancji:** przy `prefer-ip-address: true` Spring zapisuje adres IP wybrany automatycznie (pierwszy adres sieciowy; kontener usługi jest tylko w sieci `backend`, więc ma jeden). Z VS Code adres podaje zmienna `SPRING_CLOUD_CONSUL_DISCOVERY_IP_ADDRESS=host.docker.internal` (odpowiednik `SERVICE_ADDRESS`).
- **Ponowna rejestracja** ([D13](decisions.md#d13--consul-rejestracja-i-wyszukiwanie)): Spring Cloud Consul z checkiem HTTP rejestruje się tylko przy starcie aplikacji — wpis, który zniknie z Consula (np. Consul uruchomiony z pustymi danymi), nie wraca do restartu usługi. Ponowną rejestrację daje tryb `heartbeat` (`discovery.heartbeat.enabled: true`, `reregister-service-on-failure: true`), ale wtedy check jest typu TTL, a nie HTTP `/health/ready`. Wybór do ustalenia z Michałem.
- **Treść `/health/ready` przy niegotowości:** Spring zwraca 503 z `{"status":"DOWN"}`, nie w formacie [D7](decisions.md#d7--format-i-kody-błędów). Consul i k8s patrzą tylko na kod 503.
- **`X-Request-Id` i `X-Instance-Id`:** filtr (`OncePerRequestFilter`) ustawia oba nagłówki odpowiedzi i wpisuje `requestId` oraz `userId` do MDC — format `ecs` dopisuje MDC do każdej linii logu.
- **Błędy:** `@RestControllerAdvice` w formacie D7, także dla `NoResourceFoundException` (404), `HttpRequestMethodNotSupportedException` (405), `MethodArgumentNotValidException` i `MethodArgumentTypeMismatchException` (np. zły UUID — 400 `VALIDATION_ERROR`). `/` na końcu ścieżki Spring Boot 4 domyślnie nie dopasowuje (404), a `HEAD` obsługuje sam.
- **Kwoty:** `BigDecimal` z `@JsonFormat(shape = JsonFormat.Shape.STRING)` ([D3](decisions.md#d3--kwoty)).
- **Obraz:** np. `eclipse-temurin:21-jre`, `USER` z numerycznym UID, `CMD ["java", "-jar", "/app/app.jar"]` w formie listy ([D17](decisions.md#d17--kontener-i-zamykanie)).
- Fragmenty Springa dla RabbitMQ: [events.md](events.md#spring-amqp-java) (też niesprawdzone).

## 4. Wywołanie innej usługi

Zasady: [D2](decisions.md#d2--wyłącznik-i-ponowienia) (wyłącznik i ponowienia), [D5](decisions.md#d5--budżet-czasu) (termin), [D11](decisions.md#d11--tożsamość-i-nagłówki) (nagłówki), [D13](decisions.md#d13--consul-rejestracja-i-wyszukiwanie) (wyszukiwanie). Kod klienta i wyłącznika pisze właściciel usługi. Biblioteki:

- **Python:** `httpx` z `timeout=2.0` i własna mała klasa wyłącznika według opisu zachowania z D2. Klasa pamięta stan (zamknięty, otwarty do określonej chwili, półotwarty) i wyniki ostatnich 10 wywołań; przed wywołaniem sprawdza stan, po wywołaniu zapisuje wynik według tabeli niżej. W stanie półotwartym przepuszcza jedno wywołanie próbne, pozostałe dostają od razu fallback albo 503. Blokady (lock) nie trzyma przez czas wywołania: w kodzie `async` fragment bez `await` wykonuje się bez przerwy, więc zmiana stanu nie potrzebuje blokady; w kodzie z wątkami blokada obejmuje tylko zmianę stanu, nie samo wywołanie.
- **`pybreaker` jest niedozwolony** ([D2](decisions.md#d2--wyłącznik-i-ponowienia)): `call()` trzyma blokadę przez całe wywołanie, więc wywołania przez jeden wyłącznik idą po kolei; `call()` z funkcją `async` nie widzi jej błędów (wyłącznik się nie otwiera), a `call_async` wymaga biblioteki Tornado.
- **Java:** Resilience4j; wyjątki dla odpowiedzi 4xx poza 408 i 429 w `ignoreExceptions` (408 i 429 to awarie).
- **Node.js:** opossum (jak Auth).

Kolejność kroków przy jednym wywołaniu:

1. **Termin.** Na początku obsługi żądania klienta: termin = teraz + 8 s, wspólny dla wszystkich wywołań w tym żądaniu.
2. **Instancja z Consula.** `GET /v1/health/service/<nazwa>?passing`; lista trzymana 10 s, instancje po kolei (round robin); gdy Consul nie odpowiada — ostatnia znana lista. Brak instancji → fallback albo 503 `SERVICE_UNAVAILABLE`, bez wywołania.
3. **Wyłącznik.** Otwarty → od razu fallback albo 503, bez wywołania.
4. **Żądanie** z timeoutem 2 s (albo krótszym, jeśli do terminu zostało mniej) i nagłówkami: `X-User-Id` (gdy działasz w imieniu klienta), `X-User-Roles` = otrzymane role + `SERVICE` (np. `CUSTOMER,SERVICE`; praca w tle — samo `SERVICE`), `X-Request-Id` = bieżący.
5. **Wynik** — według tabeli niżej: liczy się do wyłącznika jako awaria albo sukces.
6. **Ponowienie** tylko `GET`/`HEAD`, najwyżej 2 razy, po 200 ms i 400 ms, i tylko gdy kolejna próba zmieści się w terminie. Instancja bez połączenia wypada z listy do następnego odświeżenia — ponowienie idzie do innej instancji, jeśli jest.
7. **Po terminie** albo po wyczerpaniu prób → fallback albo 503.

### Kiedy awaria i kiedy ponowienie

| Wynik próby | Awaria dla wyłącznika? | Ponowić (`GET`, `HEAD`)? | Co dalej |
|---|---|---|---|
| brak połączenia (odmowa, nieznany host) | tak | tak | po ostatniej próbie fallback albo 503 |
| timeout 2 s | tak | tak | jw. |
| 502, 503, 504 | tak | tak | jw. |
| 500 i inne 5xx | tak | nie | fallback albo 503 |
| 408, 429 | tak | nie | fallback albo 503 |
| 400, 401, 403, 404, 409 i inne 4xx | nie | nie | odpowiedź usługi, obsługa według kontraktu (np. 404 → „brak produktu”) |
| 2xx zgodne z kontraktem | nie (sukces) | — | wynik |
| 2xx niezgodne z kontraktem (brak pola, zły typ) | nie liczy się | nie | jak brak danych (fallback) + log `error` |
| wyłącznik otwarty | — (bez wywołania) | nie | fallback albo 503 |

`POST`, `PUT`, `PATCH`, `DELETE` — jedna próba. Wyjątek: `POST /users` z tym samym `id` ([D8](decisions.md#d8--profil-użytkownika-przy-rejestracji)).

Szkic nagłówków wywołania w Pythonie (tylko szkic, nie kompletny klient):

```python
# Sketch: headers of a call to another service on behalf of the client (D11).
def call_headers(user_id: str | None, roles: list[str], request_id: str) -> dict[str, str]:
    headers = {"X-User-Roles": ",".join([*roles, "SERVICE"]), "X-Request-Id": request_id}
    if user_id:
        headers["X-User-Id"] = user_id
    return headers
```

Wzorce w repo:

- Auth → User (Node.js, opossum, jedno ponowienie `POST` z tym samym `id`): [services/auth-service/src/user-client/user-client.service.ts](../services/auth-service/src/user-client/user-client.service.ts), opis: [README Auth](../services/auth-service/README.md#rejestracja-i-user-service). Auth (opossum) otwiera wyłącznik przy ponad połowie awarii, a D2 — przy co najmniej połowie; różnica bez znaczenia.
- Gateway ma **inne** reguły (awarią są dla niego tylko błędy sieci, 502 i 504; `GET` ponawia raz, od razu, do innej instancji): [README Gateway, „Circuit breaker”](../services/api-gateway/README.md#circuit-breaker). Usługa ich nie kopiuje.

## 5. Wpis usługi w Docker Compose

Wpis usługi w `deploy/compose.yaml` dopisuje Michał przy scaleniu jej PR ([D6](decisions.md#d6--konwencje-deploy-i-zmienne-środowiskowe)) — na podstawie informacji z opisu PR (lista niżej). Wzory poniżej pokazują, jak taki wpis wygląda; nazwy zmiennych w `environment:` Michał dopasowuje do tych, które czyta usługa.

Wzory są wcięte, bo w `deploy/compose.yaml` stoją pod kluczem `services:` obok innych usług.

Zasady wpisu:

- `build: ../services/<usługa>`, `image: <usługa>:dev`, `profiles: [full-shop]`;
- tylko sieć `backend`, **bez `ports:`** — z zewnątrz usługa jest dostępna tylko przez Gateway;
- `user:` tylko wtedy, gdy obraz sam nie przełącza się na użytkownika bez roota;
- hasła tylko przez `${<ZMIENNA>:?Run deploy/create-secrets.sh}` z `deploy/.env`, nigdy `env_file`;
- `depends_on` z warunkami: baza `service_healthy`, `consul-kv-seed` i `rabbitmq-setup` `service_completed_successfully`, migracja `service_completed_successfully`;
- healthcheck `/health/ready` narzędziem, które jest w obrazie (w `python:3.12-slim` nie ma `curl` ani `wget`, jest `python`).

### Wzór: Python, PostgreSQL i odbiorca zdarzeń

Przykład dla Inventory (port 8084, baza `inventory_db`, kolejka `inventory.q`), z migracją jako osobnym kontenerem (sekcja 6):

```yaml
  # One-off: applies the Inventory Service database migrations, then exits.
  # inventory-service starts only after it succeeds, so with --scale the migration still runs once.
  inventory-migrate:
    image: inventory-service:dev
    build: ../services/inventory-service
    profiles: [full-shop]
    command: ["alembic", "upgrade", "head"]
    environment:
      DB_HOST: postgres
      DB_PORT: "5432"
      DB_NAME: inventory_db
      DB_USER: inventory_service
      DB_PASSWORD: ${INVENTORY_DB_PASSWORD:?Run deploy/create-secrets.sh}
    networks: [backend]
    restart: "no"
    depends_on:
      postgres:
        condition: service_healthy

  # No ports: reachable only inside the backend network, from outside through the Gateway.
  inventory-service:
    image: inventory-service:dev
    build: ../services/inventory-service
    profiles: [full-shop]
    environment:
      PORT: "8084"
      CONSUL_HOST: consul
      CONSUL_PORT: "8500"
      DB_HOST: postgres
      DB_PORT: "5432"
      DB_NAME: inventory_db
      DB_USER: inventory_service
      DB_PASSWORD: ${INVENTORY_DB_PASSWORD:?Run deploy/create-secrets.sh}
      RABBITMQ_HOST: rabbitmq
      RABBITMQ_PORT: "5672"
      RABBITMQ_USER: inventory-service
      RABBITMQ_PASSWORD: ${INVENTORY_RABBITMQ_PASSWORD:?Run deploy/create-secrets.sh}
    networks: [backend]
    depends_on:
      postgres:
        condition: service_healthy
      consul:
        condition: service_healthy
      consul-kv-seed:
        condition: service_completed_successfully
      rabbitmq-setup:
        condition: service_completed_successfully
      inventory-migrate:
        condition: service_completed_successfully
    healthcheck:
      # python:3.12-slim has neither curl nor wget; urlopen fails on an error status.
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8084/health/ready', timeout=2)"]
      interval: 5s
      timeout: 3s
      retries: 20
      start_period: 10s
```

Usługa bez zdarzeń nie ma zmiennych `RABBITMQ_*` ani zależności `rabbitmq-setup`. Usługa, która tworzy tabele sama przy starcie (bezpiecznie przy kilku instancjach), nie ma kontenera `-migrate`.

### Wariant: MongoDB albo Redis

Review (MongoDB, port 8088) — zmienne `DB_*` jak przy PostgreSQL, a dla usługi, która czyta jeden adres połączenia, wpis buduje go z hasła:

```yaml
  review-service:
    image: review-service:dev
    build: ../services/review-service
    profiles: [full-shop]
    environment:
      PORT: "8088"
      CONSUL_HOST: consul
      CONSUL_PORT: "8500"
      DB_HOST: mongo
      DB_PORT: "27017"
      DB_NAME: review_db
      DB_USER: review_service
      DB_PASSWORD: ${REVIEW_DB_PASSWORD:?Run deploy/create-secrets.sh}
      # Alternative for a service that reads one connection string (authSource = its own database).
      # It contains the password: the service passes it only to the driver, never logs it or returns it in errors.
      # MONGODB_URL: mongodb://review_service:${REVIEW_DB_PASSWORD:?Run deploy/create-secrets.sh}@mongo:27017/review_db?authSource=review_db
    networks: [backend]
    depends_on:
      mongo:
        condition: service_healthy
      consul:
        condition: service_healthy
      consul-kv-seed:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8088/health/ready', timeout=2)"]
      interval: 5s
      timeout: 3s
      retries: 20
      start_period: 10s
```

Adres połączenia z hasłem (np. `MONGODB_URL`, `DATABASE_URL`) jest tylko dla biblioteki: usługa go nie loguje i nie zwraca w błędach ([D16](decisions.md#d16--logi)). RabbitMQ — zawsze cztery osobne zmienne, bez adresu z hasłem ([events.md](events.md#konta-uprawnienia-i-zmienne)).

Cart (Redis koszyka, port 8085) — zamiast `DB_*` i `mongo`:

```yaml
    environment:
      REDIS_HOST: redis-cart
      REDIS_PORT: "6379"
      REDIS_PASSWORD: ${REDIS_CART_PASSWORD:?Run deploy/create-secrets.sh}
    depends_on:
      redis-cart:
        condition: service_healthy
```

Notification (MongoDB i SMTP) — dodatkowo `SMTP_HOST: mailpit`, `SMTP_PORT: "1025"` i zależność `mailpit` (`service_healthy`).

### Co podać Michałowi w opisie PR

W opisie PR (sekcja „Potrzebna zmiana w `deploy/` lub Gateway” szablonu) właściciel usługi podaje:

1. **Zmienne środowiskowe** usługi: nazwy (jak w `.env.example`), które są wymagane, wartości domyślne; które zawierają hasło.
2. **Baza:** rodzaj; migracje — polecenie (np. `alembic upgrade head`) i czy uruchamia je usługa przy starcie, czy osobny kontener.
3. **Zależności:** RabbitMQ (wysyłane i odbierane zdarzenia), SMTP, inne usługi, które woła (nazwy i endpointy).
4. **Obraz:** port, czy `Dockerfile` ma `USER` z numerycznym UID, czym sprawdzić `/health/ready` w obrazie (`python`, `wget`, `curl`).
5. **Gateway:** zasób (pierwszy segment ścieżki, np. `reviews` → `review-service`) oraz endpointy publiczne, tylko dla `ADMIN` i wewnętrzne (metoda i ścieżka, [D10](decisions.md#d10--endpointy-wewnętrzne)).
6. **Konfiguracja w KV:** klucze do dopisania w `deploy/consul/config/<usługa>.yaml` z wartościami (bez haseł).
7. **Zmiana kontraktu** (jeśli jest) i zgoda usług, które wołają ([D9](decisions.md#d9--własność-kodu-pr-i-dokumenty)).

### Test po scaleniu

Po dopisaniu wpisu (z katalogu głównego repo):

```bash
docker compose -f deploy/compose.yaml --profile full-shop up -d --wait --build
docker compose -f deploy/compose.yaml --profile full-shop ps -a --format '{{.Service}} {{.State}} {{.Health}} {{.ExitCode}}'
curl -s http://127.0.0.1:8500/v1/health/checks/review-service | grep -oE '"Status": ?"[a-z]+"'
curl -s -i http://localhost:8080/api/v1/reviews/00000000-0000-4000-8000-000000000000 | grep -iE '^HTTP|^x-instance-id'
docker compose -f deploy/compose.yaml --profile full-shop logs --tail 20 review-service
time docker compose -f deploy/compose.yaml --profile full-shop stop review-service
```

Oczekiwane: `up` kończy się bez błędu; usługa `running healthy`, migracja `exited … 0`; check w Consulu `passing`; odpowiedź przez Gateway pochodzi od usługi (ma `x-instance-id: review-service-<hostname>`; kod zależy od usługi, np. 404 dla nieistniejącej opinii — ważne, że nie `503` ani `502` z Gateway); logi w JSON; `stop` < 10 s. Potem `docker compose -f deploy/compose.yaml --profile full-shop up -d --wait` uruchamia ją z powrotem. `--profile full-shop` obejmuje też Gateway i Auth.

## 6. Migracje bazy

Zasada: [D6](decisions.md#d6--konwencje-deploy-i-zmienne-środowiskowe).

- **Narzędzie** wybiera właściciel: Alembic (Python, SQLAlchemy), Flyway albo Liquibase (Java), Prisma (Node.js — tak jak Auth, [README Auth, „Migracje bazy”](../services/auth-service/README.md#migracje-bazy)). Migracje są plikami w repo usługi i przechodzą przegląd jak kod.
- **Uruchomienie:** osobny jednorazowy kontener `<usługa>-migrate` z tego samego obrazu, z innym `command:` (wzór w sekcji 5). Usługa startuje dopiero po jego udanym zakończeniu (`service_completed_successfully`), więc przy `--scale` migracja działa raz, a nie w każdej instancji naraz. Migracja przy starcie usługi jest dozwolona tylko wtedy, gdy narzędzie bezpiecznie obsługuje kilka instancji startujących równocześnie (np. blokada w bazie).
- **Uprawnienia:** użytkownik `<usługa>_service` jest właścicielem swojej bazy, więc może tworzyć i zmieniać w niej tabele. Do cudzej bazy nie ma dostępu.
- **Automatyczne tworzenie schematu** (`Base.metadata.create_all()`, `spring.jpa.hibernate.ddl-auto=create`) jest dopuszczalne tylko do pierwszego utworzenia tabel ([D6](decisions.md#d6--konwencje-deploy-i-zmienne-środowiskowe)): w jednorazowym kontenerze `<usługa>-migrate` albo przy starcie usługi, jeśli jest bezpieczne przy kilku instancjach uruchomionych naraz. `create_all` najpierw sprawdza, czy tabela istnieje, a potem ją tworzy — dwie instancje startujące równocześnie mogą obie próbować utworzyć tę samą tabelę, dlatego przy starcie usługi potrzebna jest blokada w bazie (np. `pg_advisory_lock` w PostgreSQL) albo kontener `-migrate`. **Zmiana schematu po pierwszym wdrożeniu** (nowa kolumna, indeks, zmiana typu) — tylko narzędziem migracji (Alembic, Flyway): `create_all` nie zmienia istniejących tabel, a `ddl-auto=update` zmienia je bez kontroli i bez historii.
- **Z VS Code:** migrację uruchamia się z laptopa tymi samymi zmiennymi co usługę (sekcja 1), np. `DB_HOST=127.0.0.1 … alembic upgrade head` w folderze usługi.
- **MongoDB** nie ma schematu tabel. Indeksy (np. unikalny indeks na `eventId` odbiorcy zdarzeń) usługa zakłada przy starcie (`create_index` jest bezpieczne przy powtórzeniu i przy kilku instancjach).

## 7. Outbox

Outbox to zalecany sposób publikacji zdarzeń przez usługę z bazą PostgreSQL (nadawcy: Order, Shipping; tak działa Auth). Zasady nadawcy i wersja minimalna bez outboxu: [events.md, „Jak publikować”](events.md#jak-publikować). Implementacja wzorcowa (Node.js): [services/auth-service/src/events/](../services/auth-service/src/events/), opis działania: [README Auth, „Zdarzenia”](../services/auth-service/README.md#zdarzenia). Ta sekcja opisuje elementy, bez kodu.

- **Tabela** `outbox_events` w bazie usługi: `id` (UUID = `eventId`), `routing_key`, `envelope` (cała koperta, JSON), `created_at`, `attempts`, `next_attempt_at`, `published_at` (puste = do wysłania), `last_error`; indeks na `(published_at, next_attempt_at)`.
- **Zapis w tej samej transakcji** co zmiana danych. Wycofana transakcja nie zostawia zdarzenia, a zatwierdzona zawsze je ma — także gdy RabbitMQ nie działa albo usługa padnie zaraz po odpowiedzi. Odpowiedź HTTP nie czeka na brokera.
- **Przekaźnik** — pętla w usłudze (co kilka sekund, zaraz po zapisie i po połączeniu z RabbitMQ):
  - bierze naraz kilka–kilkadziesiąt zaległych wierszy (Auth: 20) (`published_at` puste, `next_attempt_at` minął), od najstarszego, **jednym poleceniem**: wybór z `FOR UPDATE SKIP LOCKED` i od razu przesunięcie `next_attempt_at` o czas **dzierżawy** (np. 30 s). Dzięki temu każdy wiersz przejmuje naraz jedna instancja, a wiersze instancji, która padła, wracają po 30 s. Kolejność od najstarszego trzeba podać i w wyborze wierszy, i w wyniku (polecenie `UPDATE … RETURNING` w CTE nie zachowuje kolejności);
  - **limit czasu partii krótszy niż dzierżawa** (np. 20 s przy dzierżawie 30 s): nowy wiersz zaczyna się tylko w tym czasie, a niezaczęta reszta wraca do kolejki od razu — dzierżawa nie wygasa w trakcie wysyłki, więc druga instancja nie wyśle tego samego wiersza;
  - publikuje z potwierdzeniem brokera (limit np. 5 s). Potwierdzone → `published_at` (tylko dla wiersza jeszcze niewysłanego). Błąd albo brak potwierdzenia → `last_error` (bez koperty i bez danych osobowych) i kolejna próba z rosnącym odstępem (np. 1, 2, 4, 8, 16 s, potem co 30 s); pierwszy błąd kończy partię.
- **Stan „broker nie odpowiada”:** po braku potwierdzenia przekaźnik nie bierze kolejnych partii, dopóki broker nie da znaku życia (spóźnione potwierdzenie, nowe połączenie), najdłużej np. 30 s — potem **sonda**: próba z jednym zdarzeniem. Blokada publikacji przez broker (alarm pamięci albo dysku, `connection.blocked`) — tak samo: bez nowych partii do zdjęcia blokady.
- **Zaległość** (ile zdarzeń czeka): `select count(*) from outbox_events where published_at is null`. Rosnąca liczba = problem z brokerem albo z przekaźnikiem.
- **Sprzątanie:** okresowe usuwanie wierszy wysłanych dawniej niż np. 7 dni (`published_at` starsze niż próg). W Auth jeszcze go nie ma (retencja — etap 7).
- **Duplikaty:** ten sam wiersz może zostać wysłany dwa razy (np. potwierdzenie zaginęło), dlatego odbiorcy rozpoznają duplikaty po `eventId` ([D19](decisions.md#d19--zdarzenia)).
- **Zamykanie:** po SIGTERM przekaźnik nie bierze nowych wierszy i czeka na bieżącą publikację najwyżej kilka sekund, tak żeby cała usługa zakończyła się w < 10 s ([D17](decisions.md#d17--kontener-i-zamykanie)).

## 8. Pokaz load balancingu

Kilka instancji jednej usługi za Gateway. Warunki ([D13](decisions.md#d13--consul-rejestracja-i-wyszukiwanie)): usługa jest w compose (po scaleniu PR), rejestruje się z **własnym IP** (nie nazwą usługi z compose) i **unikalnym ID** (`<usługa>-<hostname>`), a każda odpowiedź ma `X-Instance-Id`. Przykład dla Review, przy działającym profilu `full-shop`:

```bash
docker compose -f deploy/compose.yaml --profile full-shop up -d --wait --scale review-service=3
sleep 12   # Gateway refreshes the list of instances from Consul every 10 s
for i in $(seq 1 9); do
  curl -s -D - -o /dev/null http://localhost:8080/api/v1/reviews/00000000-0000-4000-8000-000000000000 | grep -i '^x-instance-id' | tr -d '\r'
done | sort | uniq -c
```

Wynik: trzy różne wartości `x-instance-id: review-service-<hostname>`, każda po 3 razy (Gateway wybiera instancje po kolei). Nagłówek ma każda odpowiedź usługi, także `404`, więc do pokazu nadaje się dowolny `GET`, który Gateway przepuszcza bez logowania (tu reguła publiczna `/reviews/**`). W UI Consula usługa ma trzy instancje z różnymi adresami IP.

Powrót do jednej instancji:

```bash
docker compose -f deploy/compose.yaml --profile full-shop up -d --wait --scale review-service=1
sleep 12   # Gateway refreshes the list of instances from Consul every 10 s
```

Usunięte instancje wyrejestrowują się przy zatrzymaniu (SIGTERM). Instancja zabita bez SIGTERM (`docker kill`, `docker rm -f`) zostaje w Consulu, dopóki jej check nie jest przez minutę `critical`; gdy jej adres IP dostanie nowa instancja tej samej usługi, stary wpis przechodzi check i zostaje — wtedy usuwa się go ręcznie: `curl -s -X PUT http://127.0.0.1:8500/v1/agent/service/deregister/<ID instancji>`. Ten sam pokaz dla Auth (już dziś): [README Gateway, „Pokaz load balancingu”](../services/api-gateway/README.md#pokaz-load-balancingu).

## 9. Swagger i dokumentacja API

Zasada: [D18](decisions.md#d18--dokumentacja-api).

- Ścieżki domyślne biblioteki: FastAPI — `/docs` (Swagger UI), `/redoc`, `/openapi.json`; springdoc — `/swagger-ui.html`, `/v3/api-docs`; NestJS — ścieżka podana w kodzie (`SwaggerModule.setup`).
- Gateway ich nie przepuszcza (przekazuje tylko `/api/v1/<zasób>/…`), a usługa w compose nie ma portu na laptopie. Tak ma zostać: dokumentacja pokazuje też endpointy wewnętrzne.
- **Pokaz z VS Code:** usługa uruchomiona na laptopie (sekcja 1) → http://127.0.0.1:8088/docs (port usługi; przykład z sekcji 2: http://127.0.0.1:8090/docs).
- **Pokaz w k8s** (etap 7): `kubectl -n shop port-forward svc/review-service 8088:8088`, potem http://127.0.0.1:8088/docs.
- Żeby w Swagger UI dało się wywołać endpoint wymagający logowania, usługa deklaruje `X-User-Id` i `X-User-Roles` jako parametry nagłówka (FastAPI: `Header()` w zależności, która je czyta — jak `identity` w przykładzie z sekcji 2) — wtedy formularz „Try it out” ma na nie pola.

## 10. Walidacja wejścia

Zasady: [D1](decisions.md#d1--identyfikatory) (identyfikatory jako UUID), [D7](decisions.md#d7--format-i-kody-błędów) (400 `VALIDATION_ERROR`), [D11](decisions.md#d11--tożsamość-i-nagłówki) (nagłówki tylko od Gateway). Wszystko, co przychodzi od klienta — treść żądania, parametry ścieżki i query — przechodzi przez model z typami prostymi, zanim trafi do logiki albo do bazy.

- **Model wejścia z typami prostymi i ograniczeniami.** FastAPI: model Pydantic (`str` z `max_length`, `int` z `ge` i `le`, `uuid.UUID`, `Literal` albo `Enum` dla kodów, np. `COURIER`); Spring: Bean Validation (`@Size`, `@Min`, `@Max`, `@NotNull`, typ `UUID`) z `@Valid`. Błąd → 400 `VALIDATION_ERROR` (w przykładzie z sekcji 2 zamienia go handler `RequestValidationError`). Pole typu `dict`, `Any` albo `Object` od klienta — tylko wtedy, gdy kontrakt naprawdę go wymaga.
- **MongoDB: nigdy słownik od klienta jako filtr.** Filtr buduje usługa z pól o sprawdzonym typie, np. `{"productId": str(body.product_id), "userId": str(who.user_id)}`. Przykład ataku: `find({"userId": body["userId"]})` z treścią `{"userId": {"$ne": null}}` zwraca dokumenty wszystkich użytkowników, a operator `$where` uruchamia w bazie kod JavaScript. Model Pydantic z polem `str` albo `uuid.UUID` odrzuca taki obiekt (400).
- **SQL tylko z parametrami.** SQLAlchemy: ORM albo `text("SELECT … WHERE id = :id")` z wartością w parametrze; Spring: JPA albo `JdbcTemplate` z parametrami (`?`, `:name`). Nigdy f-string, `+` ani `format()` z wartością od klienta w treści zapytania. Nazwę kolumny do sortowania (`ORDER BY`) wybiera się z listy dozwolonych.
- **Tożsamość** tylko z nagłówków od Gateway, przez zależności z sekcji 2 ([Tożsamość i role](#tożsamość-i-role)). Pole `userId` w treści żądania nie decyduje, czyj jest zasób.
