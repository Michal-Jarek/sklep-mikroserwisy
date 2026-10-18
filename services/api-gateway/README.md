# API Gateway

Jedyny punkt wejścia z zewnątrz, sprawdza JWT.

| | |
|---|---|
| Właściciel | Michał |
| Technologia | Node.js · NestJS + Fastify (ustalone) |
| Port | 8080 |
| Nazwa w Consulu, Kubernetesie i obrazie Docker | `api-gateway` |
| Health checki | `/health/live`, `/health/ready` |

## Co tu trafia

- kod usługi i testy,
- `Dockerfile`,
- `.env.example` (nazwy zmiennych bez wartości),
- `k8s/` z manifestami Kubernetes tej usługi,
- `postman/` z kolekcją Postman tej usługi.
