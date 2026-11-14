# Kubernetes — inventory-service

Manifesty tej usługi. Wszystkie zasoby są w namespace `shop` i mają etykietę `app: inventory-service`.

| Plik | Zawartość |
|---|---|
| `configmap.yaml` | `inventory-service-config`: port, RabbitMQ (host, port, użytkownik), Consul, `LOG_LEVEL`. |
| `deployment.yaml` | 2 repliki, obraz `inventory-service:latest`, probes `/health/live` i `/health/ready`, requests i limity, UID 10001, `readOnlyRootFilesystem`. |
| `service.yaml` | Service `inventory-service` typu ClusterIP na porcie 8084. |

Sekret `inventory-service-secret` nie jest w repozytorium. Deployment wymaga go w kluczach `DATABASE_URL` i `RABBITMQ_PASSWORD`.

## Wymagania

* Namespace `shop` (jeśli go nie ma: `kubectl create namespace shop`).
* Obraz zbudowany lokalnie w folderze usługi: `docker build -t inventory-service:latest .`. Deployment używa `imagePullPolicy: IfNotPresent`, więc klaster musi widzieć lokalny obraz (np. Rancher Desktop).
* PostgreSQL z bazą `inventory_db`, RabbitMQ z kontem usługi oraz Consul pod `http://consul:8500`, przygotowane przez architekta.

## Wdrożenie

```bash
kubectl -n shop create secret generic inventory-service-secret \
  --from-literal=DATABASE_URL='postgresql+psycopg2://inventory:<haslo>@postgres:5432/inventory_db' \
  --from-literal=RABBITMQ_PASSWORD='<haslo>'

kubectl apply -f k8s/
```

Polecenia wykonuj z katalogu `services/inventory-service`. Hasła i adresy hostów podaj zgodnie z infrastrukturą zespołu; nie zapisuj ich w plikach.

## Sprawdzenie

```bash
kubectl -n shop get pods -l app=inventory-service
kubectl -n shop logs deploy/inventory-service
kubectl -n shop port-forward svc/inventory-service 8084:8084
curl http://localhost:8084/health/ready
```

Pody powinny mieć status `Running` i `READY 1/1`. Po zmianie ConfigMap lub sekretu zrestartuj usługę: `kubectl -n shop rollout restart deploy/inventory-service`.

## Do uzgodnienia z architektem

* Host i port RabbitMQ oraz nazwa konta w `configmap.yaml` (domyślnie `rabbitmq`, `5672`, `inventory-service`); konto powinno mieć prawo tylko do odczytu z `inventory.q`.
* Adres PostgreSQL w sekrecie oraz hasło konta RabbitMQ.
* NetworkPolicy ograniczająca ruch do usługi. Nie ma jej w tym folderze.
* Usługa nie ma publicznego Ingress, NodePort ani LoadBalancera.

## Usunięcie

```bash
kubectl delete -f k8s/
kubectl -n shop delete secret inventory-service-secret
```
