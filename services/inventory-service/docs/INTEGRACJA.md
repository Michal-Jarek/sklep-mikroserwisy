# Integracja inventory-service

Wszystkie pliki tej usługi znajdują się w `services/inventory-service/`. Kolekcja Postman jest w `postman/`, manifesty aplikacji w `k8s/`, a opis kodu w `docs/OPIS-KODU.md`.

## Infrastruktura potrzebna usłudze

* Namespace: `shop`; port usługi: 8084; nazwa w Consulu, Kubernetesie i obrazie Docker: `inventory-service`; etykieta podów: `app: inventory-service`.
* PostgreSQL z bazą `inventory_db` i osobnym użytkownikiem. Dane dostępowe pochodzą z Secret `inventory-service-secret`, klucz `DATABASE_URL`. Inne usługi nie czytają tej bazy.
* RabbitMQ z kontem `inventory-service`, które może tylko czytać z kolejki `inventory.q`. Kolejki, `inventory.dlq` i bindingi tworzy wspólna konfiguracja (`deploy/rabbitmq/`). Połączenie opisują zmienne `RABBITMQ_HOST`, `RABBITMQ_PORT` i `RABBITMQ_USER`, a hasło `RABBITMQ_PASSWORD` pochodzi z Secret `inventory-service-secret`.
* Consul pod `http://consul:8500`. Usługa rejestruje się jako `inventory-service` z ID `inventory-service-<hostname>` i własnym adresem IP (z VS Code `SERVICE_ADDRESS=host.docker.internal`), a health check `/health/ready` sprawdza połączenie z bazą. Co ok. 15 s usługa sprawdza, czy jej wpis istnieje z aktualnym adresem i portem, i rejestruje się ponownie, gdy go nie ma. Gdy Consul nie odpowiada, ponawia próby po 1, 2, 4, 8, 15 s. Przy zatrzymaniu wyrejestrowuje się.
* Secret i konta w bazie oraz RabbitMQ są tworzone poza manifestami w `k8s/`.

## Kto woła Inventory

* **Product i Cart:** `GET /inventory/{productId}`. Odpowiedź zawiera `productId`, `quantity`, `reserved`, `available` i `inStock`. Produkt bez wpisu w magazynie dostaje 404.
* **Order:** `POST /inventory/reservations` z ciałem `{orderId, items:[{productId, quantity}]}` i rolą SERVICE. Rezerwacja jest atomowa i idempotentna względem `orderId`, a brak towaru kończy się 409 `INSUFFICIENT_STOCK`. Zwolnienie rezerwacji to `DELETE /inventory/reservations/{orderId}`, także z rolą SERVICE.
* **Administrator:** `PUT /inventory/{productId}` ustawia stan. Inventory nie pyta Product o katalog, więc stan można ustawić także dla produktu, którego tam nie ma.

Kontrakty z Product, Cart i Order wymagają potwierdzenia przy implementacji tych usług.

## RabbitMQ

Inventory odbiera z kolejki `inventory.q` zdarzenia `order.cancelled` i `shipment.status_changed`. Koperta zawiera `eventId`, `type`, `occurredAt`, `version`, `requestId` i `payload`. Po `order.cancelled` zwalniane są rezerwacje zamówienia. Po `shipment.status_changed` ze statusem `SHIPPED` towar jest wydawany, czyli maleją `quantity` i `reserved`; inne statusy nie zmieniają stanu. Usługa nie tworzy kolejek ani bindingów, tylko sprawdza kolejkę pasywnie. Błąd chwilowy jest ponawiany w procesie (po 5 s, potem po 30 s), a po trzeciej nieudanej próbie lub przy błędnej kopercie wiadomość jest odrzucana i broker przenosi ją do `inventory.dlq`. Inventory nie publikuje żadnych zdarzeń.

## Tożsamość i role w tej usłudze

Usługa ustala użytkownika i role wyłącznie z nagłówków `X-User-Id` (UUID) i `X-User-Roles`, które ustawia Gateway; tokenu nie weryfikuje. `X-User-Id` niebędący UUID daje 400. Role są zbiorem z listy oddzielonej przecinkami, a wielkość liter ma znaczenie. Wymagane role: `ADMIN` dla PUT (zalogowany użytkownik, czyli z `X-User-Id`), `SERVICE` dla rezerwacji i zwolnienia (bez tej roli 403, także bez nagłówków; `X-User-Id` nie jest wtedy wymagany). Usługa wołająca w imieniu klienta dopisuje `SERVICE` do ról, np. `CUSTOMER,SERVICE`. Odczyt stanu nie wymaga roli.

## Konfiguracja centralna

Konfiguracja jest odczytywana ze zmiennych środowiskowych i lokalnego `.env`. Przy starcie usługa odczytuje z Consul KV klucz `config/inventory-service/data` (dokument YAML) i stosuje z niego pole `logLevel` (`debug`, `info`, `warning` lub `error`). Kolejność: zmienna środowiskowa `LOG_LEVEL` > KV > wartość domyślna `info`. Start bez Consula lub bez tego klucza jest dozwolony, a w logu pojawia się ostrzeżenie. Poziom dotyczy logów usługi i uvicorna; biblioteki logują tylko ostrzeżenia i błędy.
