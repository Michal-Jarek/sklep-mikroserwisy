# Sklep internetowy na mikroserwisach

Projekt zespołowy: sklep zbudowany z 10 mikroserwisów, frontendu w React i wspólnej infrastruktury
(Consul, RabbitMQ, Kubernetes w Rancher Desktop).

## Usługi

| Usługa | Nazwa (Consul, Kubernetes, Docker) | Port | Właściciel | Technologia |
|---|---|---|---|---|
| [API Gateway](services/api-gateway/) | `api-gateway` | 8080 | Michał | Node.js · NestJS + Fastify (ustalone) |
| [Auth Service](services/auth-service/) | `auth-service` | 8081 | Michał | Node.js · NestJS + Fastify (ustalone) |
| [User Service](services/user-service/) | `user-service` | 8082 | _do wpisania_ | Java · Spring Boot (sugerowana) |
| [Product Service](services/product-service/) | `product-service` | 8083 | _do wpisania_ | Java · Spring Boot (sugerowana) |
| [Inventory Service](services/inventory-service/) | `inventory-service` | 8084 | _do wpisania_ | Python · FastAPI (sugerowana) |
| [Cart Service](services/cart-service/) | `cart-service` | 8085 | _do wpisania_ | Node.js · NestJS + Fastify (sugerowana), Redis |
| [Order Service](services/order-service/) | `order-service` | 8086 | _do wpisania_ | Java · Spring Boot (sugerowana) |
| [Notification Service](services/notification-service/) | `notification-service` | 8087 | _do wpisania_ | Python · FastAPI (sugerowana), RabbitMQ |
| [Review Service](services/review-service/) | `review-service` | 8088 | _do wpisania_ | Python · FastAPI (sugerowana) |
| [Shipping Service](services/shipping-service/) | `shipping-service` | 8089 | _do wpisania_ | Python · FastAPI (sugerowana) |
| [Frontend](frontend/) | `frontend` | – | Michał | React |

Technologia przy usłudze to sugestia. Właściciel wpisuje tu to, w czym naprawdę pisze.

## Co jest gdzie

| Folder | Co tam trafia |
|---|---|
| `services/<usługa>/` | Kod usługi, Dockerfile, `.env.example`, testy. Wszystko, co należy do jednej usługi, jest w jej folderze. |
| `services/<usługa>/k8s/` | Manifesty Kubernetes tej usługi (Deployment, Service). |
| `services/<usługa>/postman/` | Kolekcja Postman tej usługi. |
| `frontend/` | Aplikacja React. |
| `deploy/k8s/` | Wspólne manifesty: namespace `shop`, Ingress, NetworkPolicy, bazy danych, Redis. |
| `deploy/consul/` | Konfiguracja usług w Consul KV (klucze `config/<usługa>/data`). |
| `deploy/rabbitmq/` | Kolejki, exchange `shop.events`, użytkownicy RabbitMQ. |
| `postman/` | Scenariusz zakupu przez Gateway i wspólne środowiska Postmana. |
| `docs/` | Raport, prezentacja, diagramy. |
| `.github/` | CODEOWNERS, szablon PR, później automatyczne testy (CI). |

## Jak pracujemy

1. Każdy pracuje tylko w folderze swojej usługi.
2. Nowa praca = nowa gałąź, np. `order/skladanie-zamowien`.
3. Zmiana trafia do `main` tylko przez Pull Request. Zatwierdza go osoba z pliku `.github/CODEOWNERS`.
4. Haseł i kluczy nie wrzucamy do repo. Do repo trafia tylko `.env.example` bez wartości.
