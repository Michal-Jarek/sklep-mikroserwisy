# Wspólna infrastruktura

- `k8s/`: namespace `shop`, Ingress (shop.localhost), NetworkPolicy, bazy danych, Redis, RabbitMQ, Consul.
- `consul/`: konfiguracja usług w Consul KV, klucz `config/<usługa>/data` (YAML).
- `rabbitmq/`: exchange `shop.events`, kolejki i użytkownicy.

Hasła tylko w Kubernetes Secrets, nigdy w repo.
