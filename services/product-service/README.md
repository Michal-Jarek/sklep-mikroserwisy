# Product Service

Katalog produktów, kategorie, wyszukiwanie.

| | |
|---|---|
| Właściciel | _wpisz imię i login GitHub_ |
| Technologia | Java · Spring Boot (sugerowana) |
| Port | 8083 |
| Nazwa w Consulu, Kubernetesie i obrazie Docker | `product-service` |
| Health checki | `/health/live`, `/health/ready` |

## Co tu trafia

- kod usługi i testy,
- `Dockerfile`,
- `.env.example` (nazwy zmiennych bez wartości),
- `k8s/` z manifestami Kubernetes tej usługi,
- `postman/` z kolekcją Postman tej usługi.
