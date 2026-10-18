# Review Service

Oceny i opinie o produktach.

| | |
|---|---|
| Właściciel | _wpisz imię i login GitHub_ |
| Technologia | Python · FastAPI (sugerowana) |
| Port | 8088 |
| Nazwa w Consulu, Kubernetesie i obrazie Docker | `review-service` |
| Health checki | `/health/live`, `/health/ready` |

## Co tu trafia

- kod usługi i testy,
- `Dockerfile`,
- `.env.example` (nazwy zmiennych bez wartości),
- `k8s/` z manifestami Kubernetes tej usługi,
- `postman/` z kolekcją Postman tej usługi.
