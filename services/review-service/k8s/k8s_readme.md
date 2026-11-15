# Kubernetes — review-service

Wzór manifestów tej usługi. Wszystkie zasoby są w namespace `shop` i mają etykietę `app: review-service`.

**Wdrożenie w klastrze robi platforma** (`deploy/k8s/services/review-service.yaml`, sekret tworzy `deploy/k8s/secrets.sh`, całość `bash deploy/k8s/up.sh`). Manifesty w tym folderze są wzorem — nie aplikuj ich w namespace `shop`: mają te same nazwy (Deployment, Service, Secret) co wdrożenie platformy, ale inne etykiety, więc nadpisałyby je i odcięły Review od Gateway i Product.

| Plik | Zawartość |
|---|---|
| `configmap.yaml` | `review-service-config`: port, nazwa bazy MongoDB, nazwa Order Service w Consulu i timeout wywołania, Consul. Bez `LOG_LEVEL`: zmienna ma pierwszeństwo przed `logLevel` z Consul KV (`config/review-service/data`), więc poziom logów ustawia się w KV; `LOG_LEVEL` dodaj tylko, gdy chcesz go wymusić. |
| `deployment.yaml` | 2 repliki, obraz `review-service:dev` (budowany lokalnie), probes `/health/live` i `/health/ready`, requests i limity, UID 10001, `readOnlyRootFilesystem`, `SERVICE_ADDRESS` = adres poda, `INSTANCE_ID` = nazwa poda. |
| `service.yaml` | Service `review-service` typu ClusterIP na porcie 8088. |

Deployment oczekuje sekretu `review-service-secret` z kluczem `MONGODB_URL` (użytkownik bazy `review_service`, np. `mongodb://review_service:<hasło>@mongo:27017/review_db?authSource=review_db`). Sekret nie jest w repozytorium. W ConfigMapie nie ma `ORDER_SERVICE_URL`, więc w klastrze adres Order Service pochodzi z Consula.

## Sprawdzenie wdrożenia platformy

```bash
kubectl -n shop get pods -l app.kubernetes.io/name=review-service
kubectl -n shop logs deploy/review-service
```

Pody powinny mieć status `Running` i `READY 1/1`. Z zewnątrz Review jest dostępny tylko przez Gateway (`https://shop.localhost/api/v1/reviews?productId=<uuid>`).

## Ustalenia z platformą

* Order Service zarejestrowany w Consulu jako `order-service`; bez niego dodanie opinii kończy się 503.
* NetworkPolicy (`deploy/k8s/network/`) przepuszcza ruch z Gateway i Product do Review oraz z Review do MongoDB, Consula i Order Service.
* Usługa nie ma publicznego Ingress, NodePort ani LoadBalancera.
