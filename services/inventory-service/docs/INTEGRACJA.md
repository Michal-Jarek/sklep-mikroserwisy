# Integracja inventory-service

Wszystkie pliki tej usługi znajdują się w `services/inventory-service/`. Kolekcja Postman jest w `postman/`, manifesty aplikacji w `k8s/`, a opis kodu w `docs/OPIS-KODU.md`.

## Infrastruktura potrzebna usłudze

* Namespace: `shop`; port usługi: 8084; nazwa w Consulu, Kubernetesie i obrazie Docker: `inventory-service`; etykieta podów: `app: inventory-service`.
* PostgreSQL z bazą `inventory_db` i osobnym użytkownikiem. Dane dostępowe pochodzą z Secret `inventory-service-secret`, klucz `DATABASE_URL`. Inne usługi nie czytają tej bazy.
* RabbitMQ z kontem dla tej usługi. Adres pochodzi z tego samego Secret, klucz `RABBITMQ_URL`. Konto musi mieć prawo deklarowania kolejek `inventory.q` i `inventory.dlq` oraz bindingu do exchange `shop.events`.
* Consul pod `http://consul:8500`. Usługa rejestruje się jako `inventory-service` z adresem poda, a health check `/health/ready` sprawdza połączenie z bazą.
* Secret i konta w bazie oraz RabbitMQ są tworzone poza manifestami w `k8s/`.

## Kto woła Inventory

* **Product i Cart:** `GET /inventory/{productId}`. Odpowiedź zawiera `productId`, `quantity`, `reserved`, `available` i `inStock`. Produkt bez wpisu w magazynie dostaje 404.
* **Order:** `POST /inventory/reservations` z ciałem `{orderId, items:[{productId, quantity}]}` i rolą SERVICE. Rezerwacja jest atomowa i idempotentna względem `orderId`, a brak towaru kończy się 409 `INSUFFICIENT_STOCK`. Zwolnienie rezerwacji to `DELETE /inventory/reservations/{orderId}`, także z rolą SERVICE.
* **Administrator:** `PUT /inventory/{productId}` ustawia stan. Inventory nie pyta Product o katalog, więc stan można ustawić także dla produktu, którego tam nie ma.

Kontrakty z Product, Cart i Order wymagają potwierdzenia przy implementacji tych usług.

## RabbitMQ

Inventory odbiera zdarzenie `order.cancelled` z exchange `shop.events` (topic) w kolejce `inventory.q`. Koperta zawiera `eventId`, `type`, `occurredAt`, `version` i `payload` z `orderId`. Po przetworzeniu zdarzenia rezerwacja zamówienia jest zwalniana. Po trzech nieudanych próbach wiadomość trafia do `inventory.dlq`. Inventory nie publikuje żadnych zdarzeń.

## Tożsamość i role w tej usłudze

Usługa ustala użytkownika i role z nagłówków `X-User-Id` i `X-User-Roles`. Gdy ustawione jest `JWT_JWKS_URL`, a żądanie ma nagłówek `Authorization: Bearer`, weryfikuje token RS256 kluczem z JWKS, a role i identyfikator pobiera z tokenu. Wymagane role: `ADMIN` dla PUT, `SERVICE` dla rezerwacji i zwolnienia. Odczyt stanu nie wymaga roli. Adres JWKS, `iss` i `aud` w `k8s/configmap.yaml` wymagają potwierdzenia z Auth Service.

## Konfiguracja centralna

Konfiguracja jest odczytywana ze zmiennych środowiskowych i lokalnego `.env`. Odczyt Consul KV `config/<usługa>/data` nie został zaimplementowany; wymaga wspólnego ustalenia sposobu ładowania konfiguracji.
