# Auth Service

Rejestracja, logowanie, tokeny JWT.

| | |
|---|---|
| Właściciel | Michał |
| Technologia | Node.js · NestJS + Fastify (ustalone) |
| Port | 8081 |
| Nazwa w Consulu, Kubernetesie i obrazie Docker | `auth-service` |
| Health checki | `/health/live`, `/health/ready` |

## Co tu trafia

- kod usługi i testy,
- `Dockerfile`,
- `.env.example` (nazwy zmiennych bez wartości),
- `k8s/` z manifestami Kubernetes tej usługi,
- `postman/` z kolekcją Postman tej usługi.
