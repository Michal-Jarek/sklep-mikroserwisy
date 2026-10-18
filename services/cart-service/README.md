# Cart Service

Koszyk zalogowanego użytkownika.

| | |
|---|---|
| Właściciel | _wpisz imię i login GitHub_ |
| Technologia | Node.js · NestJS + Fastify (sugerowana), Redis |
| Port | 8085 |
| Nazwa w Consulu, Kubernetesie i obrazie Docker | `cart-service` |
| Health checki | `/health/live`, `/health/ready` |

## Co tu trafia

- kod usługi i testy,
- `Dockerfile`,
- `.env.example` (nazwy zmiennych bez wartości),
- `k8s/` z manifestami Kubernetes tej usługi,
- `postman/` z kolekcją Postman tej usługi.
