# Notification Service

Słucha zdarzeń z RabbitMQ i wysyła klientom e-maile: powitanie, potwierdzenie zamówienia, anulowanie, wysyłka i dostawa. Lokalnie e-maile trafiają do Mailpit (podgląd w przeglądarce), nie do prawdziwych skrzynek.

| | |
|---|---|
| Właściciel | Michał Banaszak ([@micbanavio](https://github.com/micbanavio)) |
| Technologia | Python 3.12 · FastAPI · aio-pika (RabbitMQ) · pymongo (MongoDB) · Jinja2 |
| Port | 8087 |
| Nazwa w Consulu, Kubernetesie i obrazie Docker | `notification-service` |
| Baza | MongoDB `notification_db`, użytkownik `notification_service` |
| Kolejka | `notification.q` (konto RabbitMQ `notification-service`), błędy w `notification.dlq` |
| Health checki | `/health/live`, `/health/ready` |
| Dokumentacja API | `/docs`, `/openapi.json` (tylko bezpośrednio, nie przez Gateway, D18) |

Kontrakt zdarzeń: [docs/events.md](../../docs/events.md). Zasady wspólne: [docs/decisions.md](../../docs/decisions.md).

## Co robi

| Zdarzenie | E-mail | Adres e-mail z |
|---|---|---|
| `user.registered` | „Witamy w sklepie” | samego zdarzenia |
| `order.created` | „Potwierdzenie zamówienia” z pozycjami, dostawą i sumą | User Service (`GET /users/{userId}`) |
| `order.cancelled` | „Zamówienie anulowane” | User Service |
| `shipment.status_changed` | „Twoja paczka jest w drodze” (`SHIPPED`, z numerem przesyłki), „Paczka dostarczona” (`DELIVERED`); inne statusy bez e-maila | User Service |

Zdarzenia o zamówieniach i przesyłkach mają tylko `userId`, bez danych osobowych, więc adres i imię Notification pobiera z User Service. Robi to z rolą `SERVICE`, `X-User-Id` = `userId` zdarzenia i `X-Request-Id` = `requestId` zdarzenia (events.md, zasada 9).

### API

| Metoda | Ścieżka | Dostęp | Odpowiedź |
|---|---|---|---|
| GET | `/notifications/me?page=&size=` | zalogowany | 200 strona `{items: [{id, type, subject, sentAt}], page, size, total}`, najnowsze pierwsze, tylko własne |
| GET | `/health/live`, `/health/ready` | — | 200 albo 503 |

Przez Gateway: `GET /api/v1/notifications/me`. Trasa `notifications` jest już w `api-gateway.yaml` i domyślnie wymaga logowania.

## Jak to działa

### Odbiorca zdarzeń (zgodnie z docs/events.md)

- Kolejkę `notification.q` otwiera **pasywnie**: exchange, kolejki, wiązania i DLQ zakłada platforma. `prefetch = 10`, potwierdzanie ręczne.
- Wiadomość, której nie da się przetworzyć, idzie od razu do `notification.dlq` przez `nack(requeue=False)`. Dotyczy to: złego JSON, złej koperty, `type` innego niż klucz routingu, nieznanej `version` i złych pól `payload`. Nigdy nie ma `requeue=True`.
- `eventId` musi być UUID (inaczej DLQ). `requestId` spoza reguły `[A-Za-z0-9._-]{1,64}` (np. ze znakami spoza ASCII) usługa zastępuje nowym UUID, bo trafia on do nagłówka `X-Request-Id` wywołania User.
- Usługa wymaga tylko pól `payload`, których używa w e-mailach (tabela „Pola, których używają odbiorcy” w `docs/events.md`). Nowe wymagane pole trzeba dopisać też tam.
- Błąd chwilowy (User, SMTP albo MongoDB nie działa) daje 3 próby w procesie, z odstępem 5 s, a potem 30 s, każdy z losowym dodatkiem do 50 % (żeby seria zdarzeń nie wracała w tej samej chwili). Po trzeciej nieudanej wiadomość trafia do DLQ.
- Trwała odmowa User (4xx poza 404, 408 i 429 albo odpowiedź niezgodna z kontraktem) to od razu DLQ z logiem `error`, bez ponowień.
- Co 15 s odbiorca sprawdza, czy kolejka jeszcze istnieje. Usunięta kolejka kończy odbiorcę: log `Event consumer stopped` z przyczyną i `/health/ready` 503 do restartu usługi. Przerwa w działaniu RabbitMQ go nie kończy, bo połączenie wznawia się samo.
- Nieznany typ zdarzenia albo status przesyłki bez e-maila kończy się `ack` bez działania.
- **Idempotencja:** przed wysłaniem usługa sprawdza, czy `eventId` jest już w bazie. Po wysłaniu zapisuje go w kolekcji `notifications` z unikalnym indeksem. To kolejność „najpierw e-mail, potem `eventId`” z events.md: w rzadkim przypadku klient dostanie drugi e-mail, ale żaden nie zginie. Gdy po wysłaniu nie uda się zapisać `eventId`, usługa **nie** wysyła ponownie, tylko zapisuje błąd w logu.
- Logi zawierają `eventId`, `type`, `requestId` i `userId`, ale nigdy adresu e-mail ani treści zdarzenia.

### E-maile

Treść powstaje z szablonów Jinja2 z automatycznym escapowaniem HTML, a nagłówki ustawia `email.message.EmailMessage`. Imię wpisane przez klienta przy rejestracji (np. `<a href=…>`) zostaje zwykłym tekstem, a temat nie zawiera danych klienta (events.md, „Czego nie robić”). Każdy e-mail ma wersję tekstową i HTML.

### Gotowość (`/health/ready`)

503, gdy nie odpowiada MongoDB albo gdy zadanie odbiorcy się zakończyło (błąd w kodzie, brak dostępu do kolejki). Przerwa w RabbitMQ **nie** zmienia gotowości, bo odbiorca sam wznawia połączenie (D15). Bez zmiennej `RABBITMQ_HOST` odbiorca jest wyłączony, a w logu jest ostrzeżenie. Ten tryb jest dozwolony tylko lokalnie i w testach.

### Pliki

| Plik | Co robi |
|---|---|
| `app/consumer.py` | odbiorca `notification.q`: sprawdzenie koperty, ponowienia, DLQ, wybór e-maila |
| `app/mailer.py` | szablony e-maili i wysyłka SMTP |
| `app/users.py` | pobieranie adresu z User Service (wyłącznik i ponowienia, D2) |
| `app/store.py` | MongoDB: historia wysłanych e-maili = przetworzone `eventId` |
| `app/main.py` | składa aplikację: Consul, odbiorca w tle, `/notifications/me`, `/health/*` |
| `app/consul.py`, `app/web.py`, `app/logs.py`, `app/breaker.py`, `app/config.py` | Consul i KV, format błędów i nagłówki, logi JSON, wyłącznik, ustawienia (te same wzorce co Product) |
| `tests/` | testy pytest z atrapami RabbitMQ, MongoDB, SMTP i User |
| `postman/` | kolekcja Postman: wysyła testowe zdarzenie i sprawdza e-mail w Mailpit |
| `k8s/` | manifesty Kubernetes (Deployment, Service) i instrukcja w `k8s/README.md` |

## Uruchomienie z VS Code (Windows)

Wymagania: Python 3.12 i działająca wspólna infrastruktura (`docker compose -f deploy/compose.yaml up -d --wait`). Polecenia wpisuje się w **Git Bash**, w folderze `services/notification-service`.

**1. Środowisko Pythona** (raz):

```bash
py -3.12 -m venv .venv
.venv/Scripts/python -m pip install -r requirements-dev.txt
```

**2. Plik `.env` z hasłami** (hasła nie pojawiają się na ekranie):

```bash
cp .env.example .env
sed -i '/^DB_PASSWORD=/d; /^RABBITMQ_PASSWORD=/d' .env
printf 'DB_PASSWORD=%s\n' "$(grep '^NOTIFICATION_DB_PASSWORD=' ../../deploy/.env | cut -d= -f2-)" >> .env
printf 'RABBITMQ_PASSWORD=%s\n' "$(grep '^NOTIFICATION_RABBITMQ_PASSWORD=' ../../deploy/.env | cut -d= -f2-)" >> .env
git check-ignore -q .env && echo IGNORED
```

**3. Start:**

```bash
.venv/Scripts/python -m app
```

W logu mają się pojawić `Registered in Consul` i `Consumer started` z `"queue": "notification.q"`. Usługa nie ma migracji: indeksy w MongoDB zakłada sama przy starcie.

## Jak sprawdzić, że działa

**Testy** (bez Dockera):

```bash
.venv/Scripts/python -m pytest
```

**Zdarzenie z panelu RabbitMQ.** Wejdź na http://127.0.0.1:15672 i zaloguj się jako `admin` z hasłem `RABBITMQ_ADMIN_PASSWORD` z `deploy/.env`. Potem **Exchanges** → `shop.events` → **Publish message**:

- Routing key: `user.registered`
- Properties: `content_type` = `application/json`
- Payload (zmień `eventId` przy każdej próbie, bo powtórzony `eventId` jest pomijany jako duplikat):

```json
{"eventId": "11111111-1111-4111-8111-000000000001", "type": "user.registered", "version": 1, "occurredAt": "2026-11-13T10:00:00.000Z", "requestId": "test-1", "payload": {"userId": "b0000000-0000-4000-8000-000000000001", "email": "anna@example.com", "firstName": "Anna"}}
```

E-mail „Witamy w sklepie” pojawi się w Mailpit: http://127.0.0.1:8025.

**Postman.** Kolekcja z `postman/` robi to samo automatycznie: wysyła zdarzenie, sprawdza e-mail w Mailpit i historię klienta. W środowisku „notification-service local” wpisz w zmiennej `rabbitmqAdminPassword` hasło `RABBITMQ_ADMIN_PASSWORD`. Wpisuj je tylko u siebie, nigdy w pliku w repo.

**Cały sklep.** Z profilem `platform` (Gateway, Auth, frontend: `docker compose -f deploy/compose.yaml --profile platform up -d --wait`) rejestracja nowego konta na http://127.0.0.1:8090 wysyła prawdziwe `user.registered` z Auth, a e-mail powitalny trafia do Mailpit.

Zdarzenia o zamówieniach i przesyłkach wymagają działającego User Service z profilem klienta. Bez niego zdarzenie po 3 próbach (ok. 35 s) trafia do `notification.dlq`. To też jest poprawne zachowanie i można je pokazać w panelu RabbitMQ.

## Obraz Docker

```bash
docker build -t notification-service:dev .
docker inspect -f '{{.Config.User}}' notification-service:dev    # 10001, nie root
```

## Dla Michała: wpis w `deploy/`

1. **Zmienne:** `PORT` (8087), `CONSUL_HOST`, `CONSUL_PORT`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (**hasło**, `NOTIFICATION_DB_PASSWORD`), `RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD` (**hasło**, `NOTIFICATION_RABBITMQ_PASSWORD`), `SMTP_HOST`, `SMTP_PORT`; opcjonalnie `LOG_LEVEL`, `MAIL_FROM`.
2. **Baza:** MongoDB `notification_db` (użytkownik już jest w `deploy/mongo/init`), bez migracji, indeksy zakłada usługa.
3. **Zależności:** odbiera z `notification.q` (wszystkie 4 zdarzenia), niczego nie publikuje; SMTP `mailpit:1025`; woła `user-service` (`GET /users/{id}`, rola `SERVICE`).
4. **Obraz:** port 8087, `USER 10001`, `/health/ready` sprawdzane przez `python`.
5. **Gateway:** trasa `notifications` już jest; `GET /notifications/me` wymaga logowania (reguła domyślna). Brak endpointów wewnętrznych.
6. **KV:** bez zmian (`logLevel`, `mail.from` są już w `notification-service.yaml`).
7. **Zmiana kontraktu:** brak.

```yaml
  # No ports: reachable only inside the backend network, from outside through the Gateway.
  notification-service:
    image: notification-service:dev
    build: ../services/notification-service
    profiles: [full-shop]
    environment:
      PORT: "8087"
      CONSUL_HOST: consul
      CONSUL_PORT: "8500"
      DB_HOST: mongo
      DB_PORT: "27017"
      DB_NAME: notification_db
      DB_USER: notification_service
      DB_PASSWORD: ${NOTIFICATION_DB_PASSWORD:?Run deploy/create-secrets.sh}
      RABBITMQ_HOST: rabbitmq
      RABBITMQ_PORT: "5672"
      RABBITMQ_USER: notification-service
      RABBITMQ_PASSWORD: ${NOTIFICATION_RABBITMQ_PASSWORD:?Run deploy/create-secrets.sh}
      SMTP_HOST: mailpit
      SMTP_PORT: "1025"
    networks: [backend]
    depends_on:
      mongo:
        condition: service_healthy
      consul:
        condition: service_healthy
      consul-kv-seed:
        condition: service_completed_successfully
      rabbitmq-setup:
        condition: service_completed_successfully
      mailpit:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8087/health/ready', timeout=2)"]
      interval: 5s
      timeout: 3s
      retries: 20
      start_period: 10s
```
