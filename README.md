# Sklep internetowy na mikroserwisach

Projekt zespołowy: sklep zbudowany z 10 mikroserwisów, frontendu w React i wspólnej infrastruktury
(Consul, RabbitMQ, Kubernetes w Rancher Desktop).

## Usługi

| Usługa | Nazwa (Consul, Kubernetes, Docker) | Port | Właściciel | Technologia |
|---|---|---|---|---|
| [API Gateway](services/api-gateway/) | `api-gateway` | 8080 | Michał ([@Michal-Jarek](https://github.com/Michal-Jarek)) | Node.js · NestJS + Fastify |
| [Auth Service](services/auth-service/) | `auth-service` | 8081 | Michał ([@Michal-Jarek](https://github.com/Michal-Jarek)) | Node.js · NestJS + Fastify |
| [User Service](services/user-service/) | `user-service` | 8082 | Karola ([@karola2001km-blip](https://github.com/karola2001km-blip)) | Python |
| [Product Service](services/product-service/) | `product-service` | 8083 | Michał ([@micbanavio](https://github.com/micbanavio)) | Python · FastAPI, PostgreSQL |
| [Inventory Service](services/inventory-service/) | `inventory-service` | 8084 | Aleksandra ([@akrzeszewska](https://github.com/akrzeszewska)) | Python · FastAPI |
| [Cart Service](services/cart-service/) | `cart-service` | 8085 | Karola ([@karola2001km-blip](https://github.com/karola2001km-blip)) | Python, Redis |
| [Order Service](services/order-service/) | `order-service` | 8086 | _do ustalenia_ | Java · Spring Boot (sugestia) |
| [Notification Service](services/notification-service/) | `notification-service` | 8087 | Michał ([@micbanavio](https://github.com/micbanavio)) | Python · FastAPI, MongoDB, RabbitMQ |
| [Review Service](services/review-service/) | `review-service` | 8088 | Aleksandra ([@akrzeszewska](https://github.com/akrzeszewska)) | Python · FastAPI, MongoDB |
| [Shipping Service](services/shipping-service/) | `shipping-service` | 8089 | _do ustalenia_ | Python · FastAPI (sugestia) |
| [Frontend](frontend/) | `frontend` | – | Michał ([@Michal-Jarek](https://github.com/Michal-Jarek)) | React (Vite) |

Sklep w przeglądarce: **http://127.0.0.1:8090** — kontener `frontend` z profilu `platform` ([deploy/README.md, „Profil platform”](deploy/README.md#profil-platform-api-gateway-auth-service-i-frontend)).

Technologia usługi z właścicielem jest ustalona. Przy usłudze bez właściciela technologia jest sugestią — nowy właściciel wybiera ją razem z Michałem i zgłasza Michałowi, który dopisuje go do tej tabeli i do `.github/CODEOWNERS`.

## Pierwsze kroki

1. Uruchom wspólną infrastrukturę według [deploy/README.md](deploy/README.md).
2. Przeczytaj [docs/decisions.md](docs/decisions.md) — na górze jest [ściągawka](docs/decisions.md#ściągawka) wszystkich decyzji.
3. Zbuduj usługę według [docs/patterns.md](docs/patterns.md) (rejestracja w Consulu, konfiguracja, logi, zdrowie — z przykładem w FastAPI).
4. Jeśli usługa wysyła albo odbiera zdarzenia — [docs/events.md](docs/events.md).
5. Product, Order, Shipping: kontrakt REST v1 (ścieżki, pola, kody błędów) jest w [docs/frontend-api.md](docs/frontend-api.md); dotyczy też pozostałych usług, które woła frontend.
6. Otwórz Pull Request do `develop` i wypełnij szablon (sekcja „Jak pracujemy”).

## Dokumenty

| Dokument | O czym |
|---|---|
| [docs/decisions.md](docs/decisions.md) | Wiążące decyzje D1–D20 dla wszystkich usług: identyfikatory, kwoty, błędy, wyłącznik, Consul, logi, zdrowie, kontener. |
| [docs/patterns.md](docs/patterns.md) | Jak spełnić decyzje w praktyce: przykład usługi w FastAPI, wywołanie innej usługi, wpis w compose, migracje. |
| [docs/events.md](docs/events.md) | Zdarzenia w RabbitMQ: koperta, kolejki, konta, wzorzec nadawcy i odbiorcy. |
| [deploy/README.md](deploy/README.md) | Lokalna infrastruktura w Docker Compose: uruchomienie, hasła, bazy, porty, reset. |
| [README API Gateway — „Dla autora usługi za Gateway”](services/api-gateway/README.md#dla-autora-usługi-za-gateway) | Co Gateway robi z żądaniem, zanim trafi do usługi: trasy, reguły dostępu, nagłówki `X-User-*`. |

## Co jest gdzie

| Folder | Co tam trafia |
|---|---|
| `services/<usługa>/` | Kod usługi, Dockerfile, `.env.example`, testy. Wszystko, co należy do jednej usługi, jest w jej folderze. |
| `services/<usługa>/k8s/` | Manifesty Kubernetes tej usługi (Deployment, Service). |
| `services/<usługa>/postman/` | Kolekcja Postman tej usługi. |
| `frontend/` | Aplikacja React. |
| `deploy/compose.yaml` | Lokalne uruchomienie infrastruktury i usług w Docker Compose. |
| `deploy/k8s/` | Wspólne manifesty: namespace `shop`, Ingress, NetworkPolicy, bazy danych, Redis. |
| `deploy/consul/` | Konfiguracja usług w Consul KV (klucze `config/<usługa>/data`). |
| `deploy/mongo/` | Skrypt zakładający bazy i użytkowników MongoDB (Review, Notification). |
| `deploy/rabbitmq/` | Kolejki, exchange `shop.events`, użytkownicy RabbitMQ. |
| `postman/` | Scenariusz zakupu przez Gateway i wspólne środowiska Postmana. |
| `docs/` | Dokumenty dla zespołu (decyzje, wzorce, zdarzenia), raport, prezentacja, diagramy. |
| `.github/` | CODEOWNERS, szablon PR, później automatyczne testy (CI). |

## Jak pracujemy

1. Każdy pracuje tylko w folderze swojej usługi. Zmianę w `deploy/` (wpis w compose, konfiguracja KV) robi Michał na prośbę właściciela usługi.
2. Nowa praca = nowa gałąź od `develop`, np. `order/skladanie-zamowien`.
3. Zmiana trafia do `develop` tylko przez Pull Request (scalany jako squash). Zatwierdza go osoba z pliku `.github/CODEOWNERS` (akceptacja code ownera jest wymagana).
4. `develop` → `main` przez merge commit — robi to Michał.
5. Zmiana kontraktu (ścieżki, pola JSON, kody odpowiedzi, zdarzenia) wymaga opisu w PR i zgody usług, które ją wołają ([D9](docs/decisions.md#d9--własność-kodu-pr-i-dokumenty)).
6. Haseł i kluczy nie wrzucamy do repo. Hasła są tylko w plikach `.env` (poza repo), do repo trafia `.env.example` z samymi nazwami zmiennych.
