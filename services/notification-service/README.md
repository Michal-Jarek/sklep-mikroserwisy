# Notification Service

Słucha zdarzeń z RabbitMQ i wysyła e-maile.

| | |
|---|---|
| Właściciel | _wpisz imię i login GitHub_ |
| Technologia | Python · FastAPI (sugerowana), RabbitMQ |
| Port | 8087 |
| Nazwa w Consulu, Kubernetesie i obrazie Docker | `notification-service` |
| Health checki | `/health/live`, `/health/ready` |

## Co tu trafia

- kod usługi i testy,
- `Dockerfile`,
- `.env.example` (nazwy zmiennych bez wartości),
- `k8s/` z manifestami Kubernetes tej usługi,
- `postman/` z kolekcją Postman tej usługi.
