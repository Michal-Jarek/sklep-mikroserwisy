# Inventory Service

Stany magazynowe i rezerwacje.

| | |
|---|---|
| Właściciel | _wpisz imię i login GitHub_ |
| Technologia | Python · FastAPI (sugerowana) |
| Port | 8084 |
| Nazwa w Consulu, Kubernetesie i obrazie Docker | `inventory-service` |
| Health checki | `/health/live`, `/health/ready` |

## Co tu trafia

- kod usługi i testy,
- `Dockerfile`,
- `.env.example` (nazwy zmiennych bez wartości),
- `k8s/` z manifestami Kubernetes tej usługi,
- `postman/` z kolekcją Postman tej usługi.
