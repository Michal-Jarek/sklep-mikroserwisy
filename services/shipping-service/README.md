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
- `postman/` z kolekcją Postman tej usługi.

Manifestów Kubernetes nie dodaje się w folderze usługi: manifesty wszystkich usług są w [`deploy/k8s/`](../../deploy/k8s/README.md) i pisze je Michał na podstawie wpisu usługi w `deploy/compose.yaml`.
