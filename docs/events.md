# Zdarzenia (RabbitMQ)

Jak usługi sklepu publikują i odbierają zdarzenia: exchange, koperta, cztery zdarzenia w wersji 1, kolejki, konta, wzorzec nadawcy i odbiorcy, sprawdzanie i kolejki błędów (DLQ).

## Spis treści

1. [Przegląd](#przegląd)
2. [Koperta](#koperta)
3. [Zdarzenia w wersji 1](#zdarzenia-w-wersji-1)
4. [Kolejki, wiązania i DLQ](#kolejki-wiązania-i-dlq)
5. [Konta, uprawnienia i zmienne](#konta-uprawnienia-i-zmienne)
6. [Jak publikować](#jak-publikować)
7. [Jak odbierać](#jak-odbierać)
8. [Czego nie robić](#czego-nie-robić)
9. [Jak sprawdzić](#jak-sprawdzić)
10. [Co zostaje w DLQ](#co-zostaje-w-dlq)
11. [Zmiana kontraktu](#zmiana-kontraktu)
12. [Otwarte kwestie kontraktu v1](#otwarte-kwestie-kontraktu-v1)

## Przegląd

- Broker: **RabbitMQ 4.3**, kontener `rabbitmq` w `deploy/compose.yaml`, vhost `/`. Z laptopa: AMQP `127.0.0.1:5672`, panel `http://127.0.0.1:15672`.
- Zdarzenie informuje, że coś **już się stało** (np. zamówienie zostało opłacone). Nikt nie czeka na odpowiedź. Gdy wołający potrzebuje odpowiedzi (np. rezerwacja towaru przed zapisem zamówienia) — REST, nie zdarzenie.
- Wszystkie zdarzenia trafiają do jednego exchange **`shop.events`** typu `topic`. **Klucz routingu = pole `type`** zdarzenia, np. `order.created`.
- Każda usługa, która odbiera zdarzenia, ma jedną kolejkę `<usługa>.q` (np. `inventory.q`) i kolejkę błędów `<usługa>.dlq`.
- Exchange, kolejki, wiązania, konta i uprawnienia zakłada **platforma** (`deploy/rabbitmq/`, kontener `rabbitmq-setup` przy każdym `docker compose … up`). Usługa niczego nie deklaruje: nadawca tylko publikuje, odbiorca tylko czyta swoją kolejkę.

| Zdarzenie (`type`) | Nadawca | Kolejki odbiorców |
|---|---|---|
| `user.registered` | Auth | `notification.q` |
| `order.created` | Order | `notification.q`, `shipping.q` |
| `order.cancelled` | Order | `notification.q`, `inventory.q`, `shipping.q` |
| `shipment.status_changed` | Shipping | `notification.q`, `inventory.q`, `order.q` |

Kilka instancji jednej usługi czyta tę samą kolejkę. Broker rozdziela wiadomości między nie (konkurujący konsumenci), więc każde zdarzenie przetwarza jedna instancja.

## Koperta

Każde zdarzenie ma tę samą kopertę (wersja 1). Treść wiadomości to JSON w UTF-8:

```json
{
  "eventId": "6f1c2b9e-3d4a-4f6b-9a51-2c8e7d0b1a23",
  "type": "user.registered",
  "version": 1,
  "occurredAt": "2026-11-09T07:12:45.123Z",
  "requestId": "6e0f8a7c-1b2d-4e3f-8a9b-0c1d2e3f4a5b",
  "payload": { "userId": "0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e", "email": "anna.nowak@example.com", "firstName": "Anna" }
}
```

| Pole | Znaczenie |
|---|---|
| `eventId` | UUID v4 małymi literami, nowy dla każdego zdarzenia. Odbiorca rozpoznaje po nim duplikaty. |
| `type` | Typ zdarzenia = klucz routingu. |
| `version` | Wersja kontraktu danego typu, liczba całkowita od 1 (osobno dla każdego typu). |
| `occurredAt` | Chwila zdarzenia, ISO 8601 w UTC z milisekundami i `Z`. |
| `requestId` | `X-Request-Id` żądania HTTP, które wywołało zdarzenie. Praca w tle bez żądania: nowy UUID. |
| `payload` | Dane zdarzenia, różne dla każdego typu (niżej). |

Kolejność pól w JSON nie ma znaczenia (Auth przechowuje kopertę w kolumnie `jsonb`, więc w panelu pola bywają w innej kolejności niż w przykładach) — odbiorca parsuje JSON, a nie porównuje tekstu.

Kopertę tworzą dokładnie te pola. Odbiorca **ignoruje nieznane pola w `payload`** — nadawca może dodać pole opcjonalne bez zmiany wersji. Nowe pole wymagane albo zmiana znaczenia pola = nowa `version`.

Właściwości wiadomości AMQP ustawia nadawca:

| Właściwość | Wartość |
|---|---|
| `content_type` | `application/json` |
| `delivery_mode` | `2` (wiadomość trwała, przetrwa restart brokera) |
| `message_id` | `eventId` |
| `type` | `type` |
| `timestamp` | `occurredAt` w sekundach |
| `app_id` | nazwa usługi nadawcy, np. `auth-service` |

## Zdarzenia w wersji 1

Identyfikatory to UUID zapisane tekstem. Kwoty to tekst z dwoma miejscami po przecinku (np. `"19.99"`) razem z polem `currency`.

### `user.registered`

Nadawca: **Auth**, po udanej rejestracji konta. Odbiorca: Notification (e-mail powitalny).

```json
{
  "eventId": "6f1c2b9e-3d4a-4f6b-9a51-2c8e7d0b1a23",
  "type": "user.registered",
  "version": 1,
  "occurredAt": "2026-11-09T07:12:45.123Z",
  "requestId": "6e0f8a7c-1b2d-4e3f-8a9b-0c1d2e3f4a5b",
  "payload": {
    "userId": "0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e",
    "email": "anna.nowak@example.com",
    "firstName": "Anna"
  }
}
```

`payload` ma dokładnie te trzy pola: `userId`, `email` (po normalizacji, małymi literami), `firstName`. Bez nazwiska i hasła.

### `order.created`

Nadawca: **Order**, po opłaceniu zamówienia. Odbiorcy: Notification, Shipping.

```json
{
  "eventId": "3b9d2f64-8c1e-4a57-b0d3-5e6f7a8b9c0d",
  "type": "order.created",
  "version": 1,
  "occurredAt": "2026-11-09T08:30:12.457Z",
  "requestId": "a1b2c3d4-e5f6-4789-8abc-def012345678",
  "payload": {
    "orderId": "5d7e9f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a",
    "userId": "0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e",
    "items": [
      { "productId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "name": "Kubek ceramiczny", "quantity": 2, "unitPrice": "19.99" }
    ],
    "total": "54.97",
    "currency": "PLN",
    "shippingMethod": "COURIER",
    "shippingCost": "14.99",
    "shippingAddress": {
      "firstName": "Anna",
      "lastName": "Nowak",
      "street": "ul. Prosta 1/2",
      "postalCode": "00-001",
      "city": "Warszawa",
      "countryCode": "PL"
    }
  }
}
```

`total` = suma `quantity × unitPrice` wszystkich pozycji + `shippingCost`.

### `order.cancelled`

Nadawca: **Order**, po anulowaniu zamówienia. Odbiorcy: Notification, Inventory, Shipping.

```json
{
  "eventId": "c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e7f",
  "type": "order.cancelled",
  "version": 1,
  "occurredAt": "2026-11-09T09:05:40.010Z",
  "requestId": "b2c3d4e5-f6a7-4890-9bcd-ef0123456789",
  "payload": {
    "orderId": "5d7e9f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a",
    "userId": "0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e",
    "items": [
      { "productId": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "quantity": 2 }
    ]
  }
}
```

Nadawca wysyła zawsze wszystkie trzy pola: `orderId`, `userId` i `items` (każda pozycja z `productId` i `quantity`). Odbiorca wpisuje w `HANDLED` przykładu (sekcja [Jak odbierać](#jak-odbierać)) tylko pola, których używa — np. Inventory: `orderId`.

Zasady anulowania:

- Order anuluje zamówienie **tylko przed wysyłką** — dopóki przesyłka nie ma statusu `SHIPPED`. Wysłanego zamówienia nie da się anulować.
- Dla Inventory `order.cancelled` oznacza **zwolnienie rezerwacji** zamówienia `orderId`: `reserved −= n` dla każdej pozycji rezerwacji, rezerwacja przestaje być aktywna. Ilości bierze z własnej rezerwacji (po `orderId`), tak samo jak przy wydaniu towaru; `items` służy pozostałym odbiorcom (np. treść e-maila w Notification). Zwalnia tylko rezerwację aktywną — rezerwacja już wydana (po `SHIPPED`) albo zwolniona zostaje bez zmian, a zdarzenie kończy się `ack`.

### `shipment.status_changed`

Nadawca: **Shipping**, przy każdej zmianie statusu przesyłki. Odbiorcy: Notification, Inventory, Order.

```json
{
  "eventId": "e7f8a9b0-c1d2-4e3f-8a4b-5c6d7e8f9a0b",
  "type": "shipment.status_changed",
  "version": 1,
  "occurredAt": "2026-11-10T10:15:00.000Z",
  "requestId": "c3d4e5f6-a7b8-4901-8cde-f01234567890",
  "payload": {
    "shipmentId": "f1e2d3c4-b5a6-4978-8a6b-5c4d3e2f1a0b",
    "orderId": "5d7e9f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a",
    "userId": "0b5f5c1e-7f43-4b3c-9d2e-8a4b6a1c2d3e",
    "oldStatus": "PREPARING",
    "newStatus": "SHIPPED",
    "trackingNumber": "PL1234567890"
  }
}
```

Statusy: `PREPARING`, `SHIPPED`, `IN_TRANSIT`, `DELIVERED`, `CANCELLED`. Reakcje odbiorców:

| Odbiorca | Reaguje na | Co robi |
|---|---|---|
| Inventory | `newStatus: SHIPPED` | wydanie towaru z aktywnej rezerwacji zamówienia `orderId`: dla każdej pozycji rezerwacji `quantity −= n`, `reserved −= n` (`n` = ilość z rezerwacji — `payload` nie ma pozycji), rezerwacja dostaje status „wydana” (nazwa statusu w kodzie dowolna, np. `ISSUED`); inne statusy → `ack` bez działania |
| Order | każdy status | aktualizuje status zamówienia |
| Notification | `SHIPPED`, `DELIVERED` | e-mail do klienta |

Po wydaniu (`SHIPPED`) zamówienia nie można już anulować (sekcja [`order.cancelled`](#ordercancelled)).

Kontrakty `order.created`, `order.cancelled` i `shipment.status_changed` to propozycja v1 platformy. Właściciele Order i Shipping mogą je zmienić **przed pierwszą implementacją**, w porozumieniu z odbiorcami (zmiana w tym dokumencie). Później tylko przez nową `version`. Sprawy jeszcze nieustalone: sekcja [Otwarte kwestie kontraktu v1](#otwarte-kwestie-kontraktu-v1).

## Kolejki, wiązania i DLQ

| Kolejka | Klucze (wiązania z `shop.events`) | Kolejka błędów |
|---|---|---|
| `notification.q` | `user.registered`, `order.created`, `order.cancelled`, `shipment.status_changed` | `notification.dlq` |
| `inventory.q` | `order.cancelled`, `shipment.status_changed` | `inventory.dlq` |
| `shipping.q` | `order.created`, `order.cancelled` | `shipping.dlq` |
| `order.q` | `shipment.status_changed` | `order.dlq` |

- Wszystkie kolejki są typu **quorum** i trwałe: wiadomości przetrwają restart brokera.
- Na kolejce `<usługa>.q` działa polityka `<usługa>-retry`: `dead-letter-exchange: shop.dlx`, `dead-letter-routing-key: <usługa>.dlq`, `delivery-limit: 2`. Wiadomość trafia do `<usługa>.dlq`, gdy:
  - odbiorca ją odrzuci: `nack(requeue=False)` — od razu;
  - odbiorca trzy razy padnie w trakcie przetwarzania (3 dostawy bez `ack`) — broker przenosi ją sam.
- `shop.dlx` to exchange `direct`, wewnętrzny (nikt do niego nie publikuje, korzysta z niego tylko broker).
- `<usługa>.dlq` nie ma polityki ani odbiorcy. Wiadomości leżą tam, dopóki ktoś ich nie obejrzy i nie usunie (sekcja [Co zostaje w DLQ](#co-zostaje-w-dlq)).

Ustawienia ponowień są w polityce, nie w argumentach kolejki — odbiorca nie musi ich znać, otwiera kolejkę bez deklarowania (pasywnie).

## Konta, uprawnienia i zmienne

Każda usługa korzystająca ze zdarzeń ma własne konto (nazwa konta = nazwa usługi). Konta nie mają dostępu do panelu ani HTTP API. Konto `guest` nie istnieje.

| Konto | Publikuje (do `shop.events`) | Czyta |
|---|---|---|
| `auth-service` | `user.registered` | — |
| `notification-service` | — | `notification.q` |
| `inventory-service` | — | `inventory.q` |
| `shipping-service` | `shipment.status_changed` | `shipping.q` |
| `order-service` | `order.created`, `order.cancelled` | `order.q` |

Żadne konto nie może tworzyć ani usuwać exchange, kolejek i wiązań. Publikacja cudzego typu zdarzenia, odczyt cudzej kolejki albo kolejki DLQ i publikacja do innego exchange kończą się błędem `403 ACCESS_REFUSED` (broker zamyka kanał).

Usługa łączy się z RabbitMQ według czterech zmiennych środowiskowych:

| Zmienna | W compose | Z VS Code (usługa na laptopie) |
|---|---|---|
| `RABBITMQ_HOST` | `rabbitmq` | `127.0.0.1` |
| `RABBITMQ_PORT` | `5672` | `5672` |
| `RABBITMQ_USER` | nazwa konta, np. `inventory-service` | to samo |
| `RABBITMQ_PASSWORD` | z `deploy/.env` | z `deploy/.env` |

Te cztery zmienne **zastępują** adres połączenia w jednej zmiennej (np. `RABBITMQ_URL=amqp://użytkownik:hasło@…`) — hasła nie wpisuje się do adresu (sekcja [Czego nie robić](#czego-nie-robić)). Usługa nie ma innych zmiennych RabbitMQ: nazwa exchange (`shop.events`), nazwa kolejki (`<usługa>.q`), `prefetch` (10) i liczba prób (3) są **stałymi w kodzie**, bo wynikają z kontraktu i z topologii platformy, a nie z konfiguracji usługi.

Tryb „brak `RABBITMQ_HOST` = odbiorca wyłączony” jest dozwolony tylko w testach i przy pracy lokalnej, z ostrzeżeniem w logu przy starcie (jak `USER_SERVICE_ENABLED=false` w Auth). W compose te zmienne są zawsze ustawione.

Hasła są w `deploy/.env` (poza repo) w zmiennych `<USŁUGA>_RABBITMQ_PASSWORD`: `AUTH_RABBITMQ_PASSWORD`, `NOTIFICATION_RABBITMQ_PASSWORD`, `INVENTORY_RABBITMQ_PASSWORD`, `SHIPPING_RABBITMQ_PASSWORD`, `ORDER_RABBITMQ_PASSWORD`. Tworzy je `bash deploy/create-secrets.sh` (po aktualizacji repo dopisuje brakujące, istniejących nie zmienia). Konto i hasło zakłada `rabbitmq-setup` przy każdym `docker compose -f deploy/compose.yaml up`.

Usługę do `deploy/compose.yaml` dopisuje **Michał** (folder `deploy/` należy do platformy), na prośbę właściciela usługi — właściciel nie zmienia `deploy/` sam (zob. [D6](decisions.md#d6--konwencje-deploy-i-zmienne-środowiskowe) i [wpis usługi w Docker Compose](patterns.md#5-wpis-usługi-w-docker-compose)). Konto i hasło usługi już istnieją (tabela wyżej). Wpis wygląda tak (np. Inventory) — hasło tylko przez zmienną z `deploy/.env`, start dopiero po założeniu topologii i kont przez `rabbitmq-setup`:

```yaml
    environment:
      RABBITMQ_HOST: rabbitmq
      RABBITMQ_PORT: "5672"
      RABBITMQ_USER: inventory-service
      RABBITMQ_PASSWORD: ${INVENTORY_RABBITMQ_PASSWORD:?Run deploy/create-secrets.sh}
    depends_on:
      rabbitmq-setup:
        condition: service_completed_successfully
```

Przy uruchamianiu z VS Code usługa czyta te same cztery zmienne z lokalnego `.env` w swoim folderze (plik poza repo). W repo jest tylko `.env.example` usługi z samymi nazwami: `RABBITMQ_HOST=`, `RABBITMQ_PORT=`, `RABBITMQ_USER=`, `RABBITMQ_PASSWORD=`. Starą linię `RABBITMQ_URL` (jeśli była) usuń z `.env` i `.env.example`. Komplet czterech linii, z folderu usługi (przykład dla Inventory), bez pokazywania hasła na ekranie:

```bash
printf 'RABBITMQ_HOST=127.0.0.1\nRABBITMQ_PORT=5672\nRABBITMQ_USER=inventory-service\n' >> .env
printf 'RABBITMQ_PASSWORD=%s\n' "$(sed -n 's/^INVENTORY_RABBITMQ_PASSWORD=//p' ../../deploy/.env)" >> .env
```

## Jak publikować

Zasady nadawcy:

1. Publikuje tylko do `shop.events`, kluczem routingu = `type`, i tylko swoje typy zdarzeń (inne zablokują uprawnienia).
2. Wiadomość trwała, z właściwościami z sekcji [Koperta](#koperta).
3. Kanał z potwierdzeniami (publisher confirms). Brak potwierdzenia brokera = zdarzenie **nie** zostało wysłane.
4. Nie deklaruje exchange ani kolejek.
5. Publikuje **po zatwierdzeniu zmiany w bazie** (po commicie), nigdy przed — inaczej odbiorcy dostaną zdarzenie o czymś, co się wycofało.

**Zalecany wzorzec — [outbox](patterns.md#7-outbox) (tak działa Auth).** W tej samej transakcji co zmiana danych usługa zapisuje kopertę zdarzenia do tabeli `outbox_events` w swojej bazie. Osobna pętla w usłudze (przekaźnik) co kilka sekund pobiera niewysłane wiersze, publikuje je z potwierdzeniem i oznacza jako wysłane; przy błędzie ponawia później. Dzięki temu zdarzenie nie ginie, gdy RabbitMQ nie działa albo usługa się restartuje, a odpowiedź HTTP nie czeka na brokera. Ten sam wiersz może jednak zostać wysłany dwa razy (np. potwierdzenie zaginęło po drodze) — dlatego odbiorcy rozpoznają duplikaty po `eventId`.

**Minimum bez outboxu:** publikacja zaraz po commicie, a przy błędzie ostrzeżenie w logu (`warn`, z `eventId` i `type`). Zdarzenie może wtedy przepaść, jeśli RabbitMQ nie działa.

Publikacja jednego zdarzenia w Pythonie (aio-pika 9.5.4, połączenie jak w przykładzie odbiorcy niżej):

```python
# Fragment: publishing one event with aio-pika (inside an async function).
channel = await connection.channel(publisher_confirms=True)
exchange = await channel.get_exchange("shop.events", ensure=False)  # created by the platform
now = datetime.now(timezone.utc)
envelope = {
    "eventId": str(uuid.uuid4()),
    "type": "shipment.status_changed",
    "version": 1,
    "occurredAt": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    "requestId": request_id,  # X-Request-Id of the request that caused the event
    "payload": payload,
}
await exchange.publish(
    aio_pika.Message(
        body=json.dumps(envelope).encode("utf-8"),
        content_type="application/json",
        delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
        message_id=envelope["eventId"],
        type=envelope["type"],
        timestamp=now,
        app_id="shipping-service",
    ),
    routing_key=envelope["type"],
    timeout=5,
)  # returns after the broker confirmed; an exception means "not sent"
```

### Nadawca w Springu (Java)

`RabbitTemplate` domyślnie publikuje **bez** potwierdzeń brokera — wtedy zdarzenie odrzucone przez brokera (np. brak uprawnień) albo zgubione przy awarii wygląda jak wysłane. Potrzebne ustawienia w `application.yml` (cztery zmienne z sekcji [Konta, uprawnienia i zmienne](#konta-uprawnienia-i-zmienne)):

```yaml
spring:
  rabbitmq:
    host: ${RABBITMQ_HOST}
    port: ${RABBITMQ_PORT}
    username: ${RABBITMQ_USER}
    password: ${RABBITMQ_PASSWORD}
    publisher-confirm-type: correlated
```

Publikacja czeka na potwierdzenie najwyżej 5 s; brak potwierdzenia w tym czasie albo odmowa = zdarzenie **nie** zostało wysłane (w outboxie: wiersz zostaje do ponowienia). Właściwości wiadomości jak w sekcji [Koperta](#koperta). Bez beanów `Queue`, `Exchange`, `Binding` — exchange istnieje, zakłada go platforma.

```java
// Fragment: publishing one event with Spring AMQP and waiting for the broker confirmation (max 5 s).
MessageProperties properties = new MessageProperties();
properties.setContentType(MessageProperties.CONTENT_TYPE_JSON);
properties.setDeliveryMode(MessageDeliveryMode.PERSISTENT);
properties.setMessageId(eventId);
properties.setType(type);                          // e.g. "order.created"
properties.setTimestamp(Date.from(occurredAt));
properties.setAppId("order-service");
Message message = new Message(objectMapper.writeValueAsBytes(envelope), properties);

CorrelationData correlation = new CorrelationData(eventId);
rabbitTemplate.send("shop.events", type, message, correlation);   // routing key = type
CorrelationData.Confirm confirm = correlation.getFuture().get(5, TimeUnit.SECONDS);  // TimeoutException = not sent
if (!confirm.isAck()) {
    throw new IllegalStateException("RabbitMQ did not accept event " + eventId);
}
```

## Jak odbierać

Zasady odbiorcy:

1. Łączy się kontem swojej usługi. Kolejkę `<usługa>.q` otwiera **pasywnie**: aio-pika `channel.get_queue(name, ensure=True)`, Spring `@RabbitListener(queues = "<usługa>.q")` bez beanów `Queue`/`Binding`. Nie deklaruje exchange, kolejek ani wiązań.
2. `prefetch = 10`. Potwierdzanie ręczne: `ack` dopiero po przetworzeniu i zapisaniu skutku.
3. Idempotencja: przetworzone `eventId` zapisuje w swojej bazie, **w tej samej transakcji co skutek** zdarzenia, w kolumnie (polu) z **unikalnym indeksem**. Duplikat → `ack` bez działania. Ten sam `eventId` może przyjść dwa razy równocześnie (np. nadawca wysłał kopię, a dwie instancje odbiorcy dostały po jednej): obie przejdą sprawdzenie „czy już był”, a druga przy zapisie dostanie **naruszenie unikalności**. To duplikat, nie błąd: wycofać transakcję i `ack` — bez ponowień i bez DLQ. Usługa bez wspólnej transakcji dla skutku i `eventId` (Notification: e-mail przez SMTP, baza MongoDB) — niżej, [Idempotencja w Notification](#idempotencja-w-notification). W kodzie usługi sprawdzenie duplikatu i zapis `eventId` są w `handle_event`, w transakcji ze skutkiem; naruszenie unikalności (np. `IntegrityError`) łapie się tam — wycofanie transakcji i `return` bez wyjątku (wyjątek oznaczałby ponowienia i DLQ). Zbiór `processed_event_ids` z przykładu zastępuje w usłudze ta tabela.
4. Błąd przetwarzania (np. baza albo inna usługa chwilowo niedostępna): do 3 prób w procesie (odstęp 5 s, potem 30 s — razem dłużej niż otwarty [wyłącznik awaryjny](decisions.md#d2--wyłącznik-i-ponowienia) (30 s) i typowy restart zależności; decyzja Michała 2026-11-09), potem `nack(requeue=False)` → wiadomość trafia do `<usługa>.dlq`. **Nigdy `requeue=True`** (sekcja [Czego nie robić](#czego-nie-robić)).
5. Niepoprawny JSON, brak wymaganych pól, pola koperty złego typu (`eventId`, `type`, `occurredAt`, `requestId` muszą być tekstem, `version` liczbą całkowitą, `payload` obiektem), `type` inny niż klucz routingu dostawy albo nieznana `version` → od razu `nack(requeue=False)`, bo ponowienie nic nie zmieni. Uprawnienia brokera dotyczą klucza routingu, nie treści — tylko klucz mówi, kto mógł wysłać zdarzenie. Przykład: konto Shipping może publikować tylko z kluczem `shipment.status_changed`; gdyby odbiorca wierzył polu `type` z treści, Shipping mógłby podsunąć Inventory „anulowanie zamówienia”.
6. Nieznany `type` albo przypadek, którego usługa nie obsługuje (np. Inventory i status inny niż `SHIPPED`) → `ack` bez działania.
7. Gdy proces padnie w trakcie (brak `ack`), broker odda wiadomość innej instancji. Po 3 takich dostawach wiadomość trafia do DLQ (`x-first-death-reason: delivery_limit`).
8. [Logi](decisions.md#d16--logi) z `eventId`, `type`, `requestId` (i `userId`), bez danych osobowych z `payload` (e-mail, adres).
9. Wywołania REST z odbiorcy do innych usług: `X-User-Roles: SERVICE`, `X-User-Id` = `payload.userId` (jeśli jest), `X-Request-Id` = `requestId` z koperty.
10. Kilka instancji czyta tę samą kolejkę (konkurujący konsumenci) — kod nie może zakładać, że dostaje wszystkie zdarzenia.

### Kolejność zdarzeń nie jest gwarantowana

Zdarzenia mogą dojść w innej kolejności, niż się wydarzyły, np. `order.cancelled` przed `order.created` albo `DELIVERED` przed `IN_TRANSIT`. Powody: nadawca z outboxem wysyła później zdarzenie, którego pierwsza próba się nie udała, a następne idą dalej; kilka instancji nadawcy i odbiorcy pracuje równolegle; ponowienia u odbiorcy; zdarzenie wysłane ponownie z DLQ.

Zasada ogólna: odbiorca **nie zakłada kolejności i nie cofa stanu**. Zdarzenie, które przenosiłoby obiekt do stanu wcześniejszego niż obecny (np. `IN_TRANSIT`, gdy zamówienie jest już `DELIVERED`), kończy się `ack` bez zmiany. Zdarzenie o obiekcie, którego odbiorca jeszcze nie zna, nie może skończyć się błędem w kółko — usługa zapisuje to, co wie, albo kończy `ack` bez działania (szczegóły ustala właściciel usługi).

### Idempotencja w Notification

Skutkiem w Notification jest e-mail wysłany przez SMTP, a `eventId` trafia do MongoDB — nie ma jednej transakcji dla obu. Do wyboru jest kolejność:

| Kolejność | Gdy proces padnie między krokami | Skutek |
|---|---|---|
| e-mail, potem zapis `eventId` | e-mail wyszedł, `eventId` niezapisany | zdarzenie wraca, klient dostaje **drugi** e-mail |
| zapis `eventId`, potem e-mail | `eventId` zapisany, e-mail nie wyszedł | duplikat jest pomijany, klient **nie dostaje** e-maila |

Zalecana pierwsza kolejność (e-mail, potem zapis z unikalnym indeksem na `eventId`): odpowiada gwarancji całego systemu „co najmniej raz” — rzadki podwójny e-mail zamiast zgubionego. Przed wysłaniem odbiorca i tak sprawdza, czy `eventId` już jest (punkt 3).

### Przykład w Pythonie (aio-pika)

Pełny, samodzielny plik (Python 3.12, `aio-pika==9.5.4`). Realizuje punkty 1–8 i ponawia pierwsze połączenie, gdy RabbitMQ jeszcze nie działa (log `RabbitMQ unavailable, retrying`, odstęp rośnie od 1 s do 30 s; po zerwaniu działającego połączenia wznawia je `connect_robust`). Do własnej usługi kopiuje się go i zmienia `SERVICE`, `QUEUE`, `HANDLED` (obsługiwane typy, wersje i wymagane pola) oraz treść `handle_event`. Zbiór `processed_event_ids` w pamięci jest tylko na potrzeby przykładu — usługa trzyma `eventId` w bazie.

```python
# example_consumer.py: consumer of shop.events with retries and DLQ (docs/events.md)
"""Example consumer of shop.events events (Python 3.12, aio-pika 9.5.4).

Reads the queue of one service. A failed event is tried 3 times (5 s, then 30 s apart),
then rejected without requeue, so RabbitMQ moves it to <service>.dlq.
Settings from the environment: RABBITMQ_HOST, RABBITMQ_PORT, RABBITMQ_USER, RABBITMQ_PASSWORD.
"""
import asyncio
import json
import os
import socket
from datetime import datetime, timezone

import aio_pika
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustConnection

SERVICE = "notification-service"
QUEUE = "notification.q"  # the queue of your service: <service>.q
PREFETCH = 10
# Seconds before attempt 2 and before attempt 3: together longer than an open circuit breaker (30 s)
# or a typical restart of a dependency, so a short outage does not move events to the DLQ.
RETRY_DELAYS = (5, 30)
MAX_CONNECT_DELAY = 30  # seconds, the longest pause between attempts of the first connection
ENVELOPE_FIELDS = ("eventId", "type", "version", "occurredAt", "requestId", "payload")
TEXT_FIELDS = ("eventId", "type", "occurredAt", "requestId")
# Event types handled by this service: supported version and required payload fields.
HANDLED = {
    "user.registered": (1, ("userId", "email", "firstName")),
}

# Demo only. A real service stores processed eventIds in its own database,
# in the same transaction as the effect of the event.
processed_event_ids: set[str] = set()


class InvalidEvent(Exception):
    """The message can never be processed: bad JSON, missing or wrong fields, unknown version."""


def log(level: str, msg: str, event: dict | None = None, **fields) -> None:
    """One JSON line on stdout. Identifiers only, never the payload (personal data)."""
    line = {
        "time": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "level": level,
        "service": SERVICE,
        "msg": msg,
    }
    if event is not None:
        line |= {
            "eventId": event["eventId"],
            "type": event["type"],
            "requestId": event["requestId"],
            "userId": event["payload"].get("userId"),
        }
    print(json.dumps(line | fields), flush=True)


def parse_event(body: bytes, routing_key: str | None) -> dict:
    try:
        event = json.loads(body)
    except ValueError as exc:
        raise InvalidEvent("body is not valid JSON") from exc
    if not isinstance(event, dict) or any(field not in event for field in ENVELOPE_FIELDS):
        raise InvalidEvent("missing envelope fields")
    if not all(isinstance(event[field], str) for field in TEXT_FIELDS):
        raise InvalidEvent("envelope fields of a wrong type")
    if type(event["version"]) is not int:  # bool is not accepted either
        raise InvalidEvent("version is not an integer")
    if not isinstance(event["payload"], dict):
        raise InvalidEvent("payload is not an object")
    # RabbitMQ checks the sender's permissions against the routing key, not the body:
    # only the routing key tells who could have sent the event.
    if event["type"] != routing_key:
        raise InvalidEvent("type does not match the routing key")
    if event["type"] in HANDLED:
        version, required = HANDLED[event["type"]]
        if event["version"] != version:
            raise InvalidEvent(f"unsupported version {event['version']}")
        missing = [field for field in required if field not in event["payload"]]
        if missing:
            raise InvalidEvent(f"missing payload fields: {', '.join(missing)}")
    return event


async def handle_event(event: dict) -> None:
    """Business logic. Raise an exception on a temporary error (e.g. database or another
    service unavailable): the event is tried again. A case the service does not need
    (e.g. a status it does not react to) simply returns."""
    # Here: send the welcome e-mail to event["payload"]["email"] and save the eventId
    # together with the effect, in one database transaction.
    log("info", "Event handled", event)


async def on_message(message: AbstractIncomingMessage) -> None:
    try:
        event = parse_event(message.body, message.routing_key)
    except Exception as exc:
        # Any error here means the message itself is wrong: trying again will not help,
        # straight to the DLQ. No message may stay without ack or nack.
        reason = str(exc) if isinstance(exc, InvalidEvent) else type(exc).__name__
        log("error", "Invalid event, moved to the DLQ", messageId=message.message_id, reason=reason)
        await message.nack(requeue=False)
        return

    if event["type"] not in HANDLED:
        await message.ack()  # a type this service does not need
        return
    if event["eventId"] in processed_event_ids:
        log("info", "Duplicate event, skipped", event)
        await message.ack()
        return

    for attempt in range(1, len(RETRY_DELAYS) + 2):
        try:
            await handle_event(event)
            break
        except Exception as exc:
            # Only the exception class: its message may contain personal data.
            reason = type(exc).__name__
            if attempt > len(RETRY_DELAYS):
                log("error", "Event failed 3 times, moved to the DLQ", event, reason=reason)
                await message.nack(requeue=False)  # never requeue=True
                return
            log("warning", "Event failed, will retry", event, attempt=attempt, reason=reason)
            await asyncio.sleep(RETRY_DELAYS[attempt - 1])

    processed_event_ids.add(event["eventId"])
    await message.ack()


async def connect() -> AbstractRobustConnection:
    """connect_robust reconnects after a lost connection, but its first connection fails at once
    when the broker is not running yet. So the first connection is tried again and again,
    1 s, 2 s, 4 s ... up to 30 s apart."""
    delay = 1
    while True:
        try:
            return await aio_pika.connect_robust(
                host=os.environ["RABBITMQ_HOST"],
                port=int(os.environ.get("RABBITMQ_PORT", "5672")),
                login=os.environ["RABBITMQ_USER"],
                password=os.environ["RABBITMQ_PASSWORD"],
                client_properties={"connection_name": f"{SERVICE}-{socket.gethostname()}"},
            )
        except (OSError, aio_pika.exceptions.AMQPConnectionError) as exc:
            # Only the exception class: never the connection settings with the password.
            log("warning", "RabbitMQ unavailable, retrying", reason=type(exc).__name__, retryIn=delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, MAX_CONNECT_DELAY)


async def main() -> None:
    connection = await connect()
    async with connection:
        channel = await connection.channel()
        await channel.set_qos(prefetch_count=PREFETCH)
        # Passive open: the queue, its bindings and its DLQ are created by the platform.
        queue = await channel.get_queue(QUEUE, ensure=True)
        # Manual acknowledgement: every message ends with ack() or nack(requeue=False).
        await queue.consume(on_message)
        log("info", "Consumer started", queue=QUEUE)
        await asyncio.Future()  # runs until the process is stopped


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
```

Uruchomienie z laptopa (z katalogu głównego repo, zestaw compose z profilem `platform` działa):

1. Utwórz folder poza repo: `mkdir -p /tmp/events-example` i zapisz w nim blok wyżej jako `example_consumer.py`.
2. Potrzebny jest Python 3.12: `python3.12 --version` → `Python 3.12.…` (brak polecenia → instalacja z python.org albo `brew install python@3.12`). Na Windowsie w Git Bash zamiast `python3.12` wpisuje się `py -3.12`, a zamiast `/tmp/events-example/bin/` – `/tmp/events-example/Scripts/`.
3. Instalacja biblioteki i start (hasło trafia do zmiennej, nie na ekran):

```bash
python3.12 -m venv /tmp/events-example && /tmp/events-example/bin/pip install aio-pika==9.5.4
export RABBITMQ_HOST=127.0.0.1 RABBITMQ_PORT=5672 RABBITMQ_USER=notification-service
export RABBITMQ_PASSWORD="$(grep '^NOTIFICATION_RABBITMQ_PASSWORD=' deploy/.env | cut -d= -f2-)"
/tmp/events-example/bin/python /tmp/events-example/example_consumer.py
```

Po starcie przykład wypisuje linię `"msg": "Consumer started", "queue": "notification.q"` i czeka.

4. W drugim terminalu zarejestruj nowe konto przez Gateway (przy każdym uruchomieniu inny e-mail, inaczej `409`):

```bash
curl -s -w ' %{http_code}\n' -H 'Content-Type: application/json' \
  -d '{"email":"test1@example.com","password":"Haslo-1234!","firstName":"Anna","lastName":"Nowak"}' \
  http://localhost:8080/api/v1/auth/register
```

Wynik: `201`, a przykład wypisuje linię `"msg": "Event handled"` z `eventId`, `type`, `requestId` i `userId`. Zatrzymanie: Ctrl+C. Wiadomości odebrane przed Ctrl+C są potwierdzone i znikają z kolejki.

#### Odbiorca w usłudze FastAPI

Odbiorca działa jako zadanie w tle uruchamiane w `lifespan` (`asyncio.create_task(main())`) i anulowane przy zamykaniu (`task.cancel()`). `/health/ready` zwraca `503` **tylko wtedy, gdy to zadanie się zakończyło** (`task.done()`) — to znaczy błąd w kodzie albo brak dostępu do kolejki; bez tego martwy odbiorca byłby niewidoczny, a zdarzenia leżałyby w kolejce. Przerwa w połączeniu z RabbitMQ **nie** zmienia gotowości: odbiorca sam wznawia połączenie, a REST usługi działa dalej (awaria brokera nie może blokować głównej operacji usługi). Pozostałe sprawdzenia `/health/ready` (np. baza) zostają bez zmian (zob. [D15](decisions.md#d15--zdrowie-usługi)). Złe hasło albo konto (`ProbableAuthenticationError`, podklasa `AMQPConnectionError`) odbiorca ponawia bez końca — `/health/ready` zostaje `200`, a przyczyna jest tylko w logu `RabbitMQ unavailable, retrying` (pole `reason`). Brak zmiennej `RABBITMQ_*` (`KeyError`) kończy zadanie → `503`.

```python
# Fragment: the consumer of example_consumer.py as a background task of a FastAPI service.
# is_ready, health_ready and error_response as in example_service.py (docs/patterns.md, section 2).
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app import consumer  # the module with main() from the example above


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.consumer_task = asyncio.create_task(consumer.main())
    yield
    app.state.consumer_task.cancel()


app = FastAPI(lifespan=lifespan)


async def is_ready() -> bool:
    database_ready = True  # the usual checks, e.g. a short query to the own database
    # Not ready only when the consumer task has ended (a bug, no access to the queue).
    # A broker outage does not count: the consumer reconnects by itself.
    return database_ready and not app.state.consumer_task.done()


@app.get("/health/ready")
async def health_ready():
    if not await is_ready():
        return error_response(503, "Service is not ready")  # 503 in the error format of the team (D7)
    return {"status": "UP"}
```

Logikę bazy w `handle_event` wykonuje się asynchronicznym sterownikiem albo przez `asyncio.to_thread`, żeby nie blokować pętli zdarzeń.

Odbiorca uruchamiany samodzielnie w kontenerze (bez uvicorna) jest procesem nr 1 i bez obsługi SIGTERM nie kończy się po `docker compose stop` — obsłuż sygnał (`loop.add_signal_handler(signal.SIGTERM, …)` — handler anuluje zadanie `main()`, a przykład zamyka wtedy połączenie w `async with`) albo dodaj `init: true` w compose (wpis w `deploy/compose.yaml` dopisuje Michał). W FastAPI sygnały obsługuje uvicorn — jako proces nr 1 wymaga `CMD` w formie exec (`CMD ["uvicorn", …]`, nie `CMD uvicorn …`).

### Spring AMQP (Java)

Ustawienia w `application.yml`, bez deklaracji kolejek, exchange i wiązań w kodzie (połączenie — jak w sekcji [Nadawca w Springu (Java)](#nadawca-w-springu-java)):

```yaml
spring:
  rabbitmq:
    listener:
      simple:
        acknowledge-mode: auto
        prefetch: 10
        default-requeue-rejected: false
        retry:
          enabled: true
          max-attempts: 3
          initial-interval: 5s
          multiplier: 6
          max-interval: 30s
```

`acknowledge-mode: auto` w Springu oznacza: `ack` po poprawnym zakończeniu metody `@RabbitListener`, a po wyjątku (i 3 próbach) odrzucenie. `default-requeue-rejected: false` sprawia, że odrzucenie idzie do DLQ, a nie z powrotem do kolejki.

Punkt 5 zasad w Springu: metoda `@RabbitListener` odbiera też klucz routingu (`@Header(AmqpHeaders.RECEIVED_ROUTING_KEY) String routingKey`), sprawdza kopertę (typy pól, `type` równy `routingKey`, `version`) i przy niepoprawnej wiadomości rzuca wyjątek **przed** jakimkolwiek skutkiem — wiadomość trafia do DLQ. Niepoprawna koperta i naruszenie unikalności (duplikat) nie mogą przechodzić przez 3 ponowienia: wyjątek niepoprawnej koperty trzeba wyłączyć z ponowień (od razu odrzucenie), a duplikat zakończyć bez wyjątku (`ack`). Dokładny sposób sprawdza właściciel usługi w Javie — w etapie 4 fragmenty Springa nie były uruchamiane. Ustawienia nadawcy w Springu: [Nadawca w Springu (Java)](#nadawca-w-springu-java).

## Czego nie robić

| Czego nie robić | Dlaczego |
|---|---|
| Deklarować exchange, kolejek i wiązań (`declare_exchange`, `declare_queue`, `queue.bind`; w Springu beany `Queue`, `Exchange`, `Binding` albo `@RabbitListener(bindings = …)`) | Konta usług nie mają prawa `configure` → `403 ACCESS_REFUSED` i zamknięty kanał. Topologia jest w `deploy/rabbitmq/` i zakłada ją platforma. Nawet z prawami deklaracja kolejki bez `x-queue-type: quorum` kończy się błędem `406 PRECONDITION_FAILED`. |
| Publikować do domyślnego exchange (`amq.default`, w aio-pika `channel.default_exchange`) albo do `shop.dlx` | Brak uprawnień → `403`. Zdarzenia idą tylko do `shop.events`. |
| `nack` albo `reject` z `requeue=True` | Wiadomość zwrócona do kolejki **nie jest liczona jako próba** (RabbitMQ 4.x) — wraca natychmiast i krąży bez końca, nigdy nie trafia do DLQ. W teście na compose jedna wiadomość dostała ok. 6 tys. dostaw w 3 s (bez nagłówka `x-delivery-count`), a przy dłuższej próbie ok. 260 tys. w 2 minuty. Kolejka stoi, procesor pracuje na pusto. Uwaga: w aio-pika `message.nack()` **bez argumentu** to `requeue=True`; w Springu domyślnie `default-requeue-rejected: true`. |
| Ponowienia przez ponowną publikację z własnym licznikiem (np. nagłówek `x-attempts`) | Wymaga prawa zapisu do `amq.default` (brak → `403`), każda usługa pisze własny mechanizm, a błąd między publikacją kopii a `ack` gubi albo dubluje wiadomość. Ponowienia robi się w procesie (punkt 4 zasad odbiorcy). |
| Automatyczne potwierdzanie (`no_ack=True`, `auto_ack`) | Wiadomość znika z kolejki przy odbiorze — błąd przetwarzania albo padnięcie procesu ją gubi. |
| Logować `payload` albo całą kopertę | `payload` zawiera dane osobowe (e-mail, adres). W logach tylko identyfikatory. |
| Łączyć usługę kontem `admin` albo cudzym kontem | `admin` służy tylko do panelu. Każda usługa ma swoje konto z minimalnymi prawami. |
| Hasło w adresie połączenia (`RABBITMQ_URL=amqp://użytkownik:hasło@rabbitmq:5672/`) albo logowanie adresu połączenia | Adres trafia do logów startu, komunikatów błędów bibliotek i manifestów — razem z hasłem. Hasło tylko w osobnej zmiennej `RABBITMQ_PASSWORD`, przekazywane bibliotece jako parametr (jak w przykładzie). |
| Rozpoznawać zdarzenie po polu `type` z treści bez porównania z kluczem routingu | Broker sprawdza uprawnienia nadawcy tylko dla klucza routingu. Treść może podać dowolny `type` — tak jedna usługa podszyłaby się pod zdarzenia innej (punkt 5 zasad odbiorcy). |
| Używać pól `payload` bez sprawdzenia i bez escapowania | Treść zdarzenia pochodzi częściowo od klientów sklepu (np. `firstName` z rejestracji). Typy i formaty sprawdza się na wejściu (np. model Pydantic, Bean Validation); w e-mailach HTML przez szablon z automatycznym escapowaniem (np. Jinja2 z `autoescape`), nagłówki e-maili przez bibliotekę (np. `email.message.EmailMessage`), nigdy sklejaniem tekstu; w SQL tylko parametry zapytań. Inaczej imię `<a href=…>Odbierz rabat</a>` staje się linkiem w e-mailu sklepu. |

## Jak sprawdzić

### Panel

`http://127.0.0.1:15672`, login `admin`, hasło `RABBITMQ_ADMIN_PASSWORD` z `deploy/.env`.

- **Queues and Streams** → kolejka (np. `notification.q`): liczba wiadomości (`Ready`, `Unacked`) i odbiorców (`Consumers`). Liczby odświeżają się z opóźnieniem kilku sekund.
- Podgląd wiadomości bez zdejmowania: na stronie kolejki **Get messages** → `Ack Mode`: **Nack message requeue true**, `Messages`: np. 5 → **Get Message(s)**. Widać właściwości, nagłówki i treść. Tryb `Automatic ack` **usuwa** pobrane wiadomości.
- **Exchanges** → `shop.events` → **Bindings**: które klucze trafiają do których kolejek.
- **Connections**: połączone usługi (kolumna `User name` = konto usługi).
- Testowe zdarzenie dla odbiorcy: **Exchanges** → `shop.events` → **Publish message**: `Routing key` = typ (np. `order.cancelled`), `Properties`: `content_type` = `application/json`, `message_id` = `eventId`, `Payload` = koperta z sekcji [Zdarzenia w wersji 1](#zdarzenia-w-wersji-1) z nowym `eventId`. Pole `type` w kopercie musi być równe `Routing key` — inaczej odbiorca odrzuci zdarzenie do DLQ. Żeby zobaczyć skutek w bazie odbiorcy, identyfikatory w `payload` muszą istnieć u odbiorcy — np. dla Inventory `orderId` (i `productId`) rezerwacji założonej wcześniej przez REST; zdarzenie o nieznanym zamówieniu kończy się `ack` bez zmian.
- Czyszczenie kolejki (np. w trakcie testów, gdy usługa jeszcze nie odbiera): strona kolejki → **Purge Messages**. Purge usuwa **wszystkie** wiadomości z kolejki, bez możliwości odzyskania.

### Wiersz poleceń w kontenerze

Z katalogu głównego repo. `rabbitmqctl` nie potrzebuje hasła; `rabbitmqadmin` bierze hasło admina ze zmiennej w kontenerze (nie pojawia się na ekranie).

```bash
# queues: messages, consumers
docker compose -f deploy/compose.yaml exec rabbitmq rabbitmqctl list_queues name messages consumers

# bindings (lines with an empty source belong to the default exchange)
docker compose -f deploy/compose.yaml exec rabbitmq rabbitmqctl list_bindings source_name routing_key destination_name

# first 5 messages of a queue without removing them (ack_requeue_true)
docker compose -f deploy/compose.yaml exec rabbitmq sh -c \
  'RABBITMQADMIN_USERNAME=admin RABBITMQADMIN_PASSWORD="$RABBITMQ_DEFAULT_PASS" \
   rabbitmqadmin get messages --queue notification.dlq --count 5 --ack-mode ack_requeue_true'

# test event for a consumer: the envelope from a file through stdin, "type" equal to the routing key
docker compose -f deploy/compose.yaml exec -T rabbitmq sh -c \
  'RABBITMQADMIN_USERNAME=admin RABBITMQADMIN_PASSWORD="$RABBITMQ_DEFAULT_PASS" \
   rabbitmqadmin publish message --exchange shop.events --routing-key order.cancelled --payload-file - \
   --properties "{\"content_type\":\"application/json\",\"delivery_mode\":2,\"message_id\":\"<eventId>\",\"type\":\"order.cancelled\"}"' \
  < event.json
```

Publikacja z wiersza poleceń: `event.json` to koperta z sekcji [Zdarzenia w wersji 1](#zdarzenia-w-wersji-1) z nowym `eventId` (ten sam w pliku i w `message_id`). Wynik: `Message published and routed successfully`. Zasady jak przy publikacji z panelu (punkt „Testowe zdarzenie” wyżej).

`rabbitmqctl` wypisuje najpierw linie `Timeout: …` i `Listing …` – to normalne. Przy pustej kolejce `rabbitmqadmin get messages` pokazuje sam nagłówek tabeli; tabela jest szeroka, więc warto poszerzyć okno terminala.

`rabbitmqadmin get messages` bez `--ack-mode ack_requeue_true` **usuwa** pobrane wiadomości.

## Co zostaje w DLQ

W `<usługa>.dlq` lądują wiadomości, których odbiorca nie przetworzył:

| Powód (`x-first-death-reason`) | Kiedy |
|---|---|
| `rejected` | odbiorca wywołał `nack(requeue=False)`: po 3 nieudanych próbach albo od razu przy niepoprawnej wiadomości |
| `delivery_limit` | odbiorca 3 razy padł w trakcie przetwarzania (3 dostawy bez `ack`) |

Wiadomość w DLQ ma niezmienioną treść i właściwości (`message_id` = `eventId`) oraz nagłówki dodane przez broker:

| Nagłówek | Znaczenie |
|---|---|
| `x-first-death-reason` | powód: `rejected` albo `delivery_limit` |
| `x-first-death-queue` | kolejka, z której wiadomość trafiła do DLQ (np. `notification.q`) |
| `x-first-death-exchange` | exchange, przez który przyszła (`shop.events`) |
| `x-death` | lista z liczbą przypadków, powodem, kolejką, kluczami routingu i czasem (`time`, sekundy) |
| `x-delivery-count` | liczba wcześniejszych dostaw (przy `delivery_limit`: `3`) |

Obejrzenie: panel (strona `<usługa>.dlq` → **Get messages** z **Nack message requeue true**) albo `rabbitmqadmin get messages … --ack-mode ack_requeue_true` z poprzedniej sekcji. Logi odbiorcy z tym samym `eventId` pokazują przyczynę błędu.

Wiadomości nie wygasają i nie wracają same do `<usługa>.q`. Ponowne wysłanie z DLQ nie jest na razie zautomatyzowane. Po usunięciu przyczyny można wysłać zdarzenie ponownie z panelu (**Publish message** na `shop.events`, ta sama koperta — odbiorca rozpozna duplikat po `eventId`, jeśli zdarzenie zostało jednak przetworzone), a obejrzane wiadomości usunąć z DLQ przez **Purge Messages**. Uwaga: **Purge** usuwa z `<usługa>.dlq` wszystkie wiadomości, także te, których nikt jeszcze nie obejrzał ani nie wysłał ponownie — przed Purge trzeba obejrzeć całą zawartość DLQ (liczba `Ready` na stronie kolejki).

## Zmiana kontraktu

Nazwy exchange i kolejek, wiązania, koperta i pola zdarzeń oraz wzorzec odbiorcy to kontrakt między usługami. Zmiana wymaga zgody nadawcy, odbiorców i architekta projektu i trafia najpierw do tego dokumentu (zob. [D9](decisions.md#d9--własność-kodu-pr-i-dokumenty)). Zmiana `payload` po pierwszej implementacji = nowa `version` zdarzenia (odbiorca odrzuca nieznaną wersję do DLQ, więc nadawca zaczyna ją wysyłać dopiero, gdy odbiorcy ją obsługują).

## Otwarte kwestie kontraktu v1

Do ustalenia przez właścicieli Order i Shipping z Michałem — przed pierwszą implementacją tych usług. Do czasu decyzji obowiązuje to, co jest w tym dokumencie.

| Kwestia | Stan dziś |
|---|---|
| Czy Shipping publikuje `shipment.status_changed` już przy utworzeniu przesyłki (pierwszy status, `oldStatus: null`)? | nieustalone; przykład pokazuje tylko zmianę `PREPARING` → `SHIPPED` |
| Czy `trackingNumber` może być `null` przed nadaniem paczki (`PREPARING`)? | nieustalone; w przykładzie zawsze tekst |
| Czy Order wysyła `order.cancelled` dla zamówienia nieopłaconego (dla którego nie było `order.created`)? | nieustalone; `order.created` wychodzi dopiero po opłaceniu |

Ustalone (decyzje Michała 2026-11-09):
- odbiorca ponawia przetwarzanie 3 razy z odstępem 5 s, potem 30 s (punkt 4 zasad odbiorcy), zanim odda wiadomość do `<usługa>.dlq`;
- pole kraju w `shippingAddress` zdarzenia `order.created` to `countryCode` (jak w adresach User Service);
- połączenie z RabbitMQ **nie** wchodzi do `/health/ready` usług z REST: odbiorca sam wznawia połączenie, a `/health/ready` = `503` tylko, gdy zadanie odbiorcy się zakończyło (sekcja [Odbiorca w usłudze FastAPI](#odbiorca-w-usłudze-fastapi)).
