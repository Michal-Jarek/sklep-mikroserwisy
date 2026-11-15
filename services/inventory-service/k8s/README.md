# Kubernetes — inventory-service

Wzór manifestów tej usługi. Wszystkie zasoby są w namespace `shop` i mają etykietę `app: inventory-service`.

**Wdrożenie w klastrze robi platforma** (`deploy/k8s/services/inventory-service.yaml`, sekret tworzy `deploy/k8s/secrets.sh`, całość `bash deploy/k8s/up.sh`). Manifesty w tym folderze są wzorem — nie aplikuj ich w namespace `shop`: mają te same nazwy (Deployment, Service, Secret) co wdrożenie platformy, ale inne etykiety, więc nadpisałyby je i odcięły Inventory od Gateway, Product i Cart.

| Plik | Zawartość |
|---|---|
| `configmap.yaml` | `inventory-service-config`: port, RabbitMQ (host, port, użytkownik), Consul, `LOG_LEVEL`. |
| `deployment.yaml` | 2 repliki, obraz `inventory-service:dev` (`imagePullPolicy: Never`), probes `/health/live` i `/health/ready`, requests i limity, UID 10001, `readOnlyRootFilesystem`. |
| `service.yaml` | Service `inventory-service` typu ClusterIP na porcie 8084. |

Deployment oczekuje sekretu z kluczami `DATABASE_URL` (użytkownik bazy `inventory_service`, np. `postgresql+psycopg2://inventory_service:<hasło>@postgres:5432/inventory_db`) i `RABBITMQ_PASSWORD`. Sekret nie jest w repozytorium.

## Sprawdzenie wdrożenia platformy

```bash
kubectl -n shop get pods -l app=inventory-service
kubectl -n shop logs deploy/inventory-service
```

Pody powinny mieć status `Running` i `READY 1/1`. Z zewnątrz Inventory jest dostępne tylko przez Gateway (`https://shop.localhost/api/v1/inventory/<productId>`).

## Ustalenia z platformą

* Konto RabbitMQ `inventory-service` ma prawo tylko do odczytu z `inventory.q`.
* NetworkPolicy ograniczająca ruch do usługi jest w `deploy/k8s/network/`.
* Usługa nie ma publicznego Ingress, NodePort ani LoadBalancera.
