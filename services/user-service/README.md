# User Service

Profile klientów i adresy dostawy.

| | |
|---|---|
| Właściciel | _wpisz imię i login GitHub_ |
| Technologia | Java · Spring Boot (sugerowana) |
| Port | 8082 |
| Nazwa w Consulu, Kubernetesie i obrazie Docker | `user-service` |
| Health checki | `/health/live`, `/health/ready` |

## Co tu trafia

- kod usługi i testy,
- `Dockerfile`,
- `.env.example` (nazwy zmiennych bez wartości),
- `k8s/` z manifestami Kubernetes tej usługi,
- `postman/` z kolekcją Postman tej usługi.
