# Shipping Service

Metody dostawy i przesyłki, bez integracji z kurierem.

| | |
|---|---|
| Właściciel | _wpisz imię i login GitHub_ |
| Technologia | Python · FastAPI (sugerowana) |
| Port | 8089 |
| Nazwa w Consulu, Kubernetesie i obrazie Docker | `shipping-service` |
| Health checki | `/health/live`, `/health/ready` |

## Co tu trafia

- kod usługi i testy,
- `Dockerfile`,
- `.env.example` (nazwy zmiennych bez wartości),
- `k8s/` z manifestami Kubernetes tej usługi,
- `postman/` z kolekcją Postman tej usługi.
