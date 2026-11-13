# Kubernetes: product-service

Manifesty dla namespace `shop`. Namespace, PostgreSQL, Consul i polityki sieciowe to wspólna infrastruktura (`deploy/k8s/`, Michał).

| Plik | Co zawiera |
|---|---|
| `migration-job.yaml` | Job `product-db-migration`: `alembic upgrade head` (tabele i katalog startowy) |
| `app.yaml` | Deployment `product-service` (2 repliki) i Service `ClusterIP` na porcie 8083 |

Wymagania: obraz `product-service:0.1.0` (`docker build -t product-service:0.1.0 services/product-service`), PostgreSQL pod nazwą `postgres:5432` z bazą `product_db` i użytkownikiem `product_service`, Consul pod nazwą `consul:8500`.

Hasło do bazy nie jest w repozytorium. Secret tworzy się raz, wartością `PRODUCT_DB_PASSWORD` z `deploy/.env`:

```sh
kubectl -n shop create secret generic product-db-secret --from-literal=password='<hasło>'
```

Najpierw migracja, potem aplikacja:

```sh
kubectl apply -f services/product-service/k8s/migration-job.yaml
kubectl -n shop wait --for=condition=complete job/product-db-migration --timeout=120s
kubectl apply -f services/product-service/k8s/app.yaml
kubectl -n shop rollout status deployment/product-service
```

Kolejna migracja: `kubectl -n shop delete job product-db-migration` i ponownie dwie pierwsze komendy (Job jest też usuwany sam godzinę po zakończeniu).

Sprawdzenie bez Gateway:

```sh
kubectl -n shop port-forward service/product-service 8083:8083
curl -i http://127.0.0.1:8083/health/ready
curl -s -D - -o /dev/null http://127.0.0.1:8083/products | grep -i x-instance-id
```

Bezpieczeństwo kontenera: użytkownik 10001 (jak w `Dockerfile`), `runAsNonRoot`, `allowPrivilegeEscalation: false`, system plików tylko do odczytu (zapisywalny tylko `/tmp`), bez capabilities, seccomp `RuntimeDefault`, bez tokenu ServiceAccount. Probe: startup i liveness `/health/live`, readiness `/health/ready` (503, gdy baza nie odpowiada). Product rejestruje się w Consulu adresem poda (`SERVICE_ADDRESS`) i nazwą poda (`INSTANCE_ID`).

Ruch sieciowy potrzebny w NetworkPolicy: wejście z `api-gateway` na 8083 i od Cart, Order, Review (lekki odczyt, D4); wyjście do `postgres:5432`, `consul:8500`, `review-service:8085`, `inventory-service:8084` i DNS. Job migracji: wyjście do `postgres:5432` i DNS.

Nie wykonano wdrożenia w klastrze. Manifesty sprawdzono schematem Kubernetes 1.30 w trybie ścisłym (`kubeconform -strict`).
