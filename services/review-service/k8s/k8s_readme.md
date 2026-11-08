# Kubernetes — review-service

Manifesty tej usługi. Wszystkie zasoby są w namespace `shop` i mają etykietę `app: review-service`.

| Plik | Zawartość |
|---|---|
| `configmap.yaml` | `review-service-config`: port, nazwa bazy MongoDB, nazwa i timeout Order Service, Consul, adres JWKS, `LOG_LEVEL`. |
| `deployment.yaml` | 2 repliki, obraz `review-service:latest`, probes `/health/live` i `/health/ready`, requests i limity, UID 10001, `readOnlyRootFilesystem`. |
| `service.yaml` | Service `review-service` typu ClusterIP na porcie 8088. |

Sekret `review-service-secret` nie jest w repozytorium. Deployment wymaga go w kluczu `MONGODB_URL`. W ConfigMapie nie ma `ORDER_SERVICE_URL`, więc w klastrze adres Order Service pochodzi z Consula.

## Wymagania

* Namespace `shop` (jeśli go nie ma: `kubectl create namespace shop`).
* Obraz zbudowany lokalnie w folderze usługi: `docker build -t review-service:latest .`. Deployment używa `imagePullPolicy: IfNotPresent`, więc klaster musi widzieć lokalny obraz (np. Rancher Desktop).
* MongoDB z bazą `review_db` i użytkownikiem usługi oraz Consul pod `http://consul:8500`, przygotowane przez architekta.
* Order Service zarejestrowany w Consulu jako `order-service`. Bez niego dodanie opinii kończy się 503.

## Wdrożenie

```bash
kubectl -n shop create secret generic review-service-secret \
  --from-literal=MONGODB_URL='mongodb://review:<haslo>@mongodb:27017/review_db'

kubectl apply -f k8s/
```

Polecenia wykonuj z katalogu `services/review-service`. Hasło i adres hosta MongoDB podaj zgodnie z infrastrukturą zespołu; nie zapisuj ich w plikach.

## Sprawdzenie

```bash
kubectl -n shop get pods -l app=review-service
kubectl -n shop logs deploy/review-service
kubectl -n shop port-forward svc/review-service 8088:8088
curl http://localhost:8088/health/ready
```

Pody powinny mieć status `Running` i `READY 1/1`. Po zmianie ConfigMap lub sekretu zrestartuj usługę: `kubectl -n shop rollout restart deploy/review-service`.

## Do uzgodnienia z architektem

* Adres JWKS Auth Service, `JWT_ISSUER` i `JWT_AUDIENCE` w `configmap.yaml`. Pusty `JWT_JWKS_URL` wyłącza weryfikację tokenu w usłudze, a role pochodzą wtedy z nagłówków `X-User-*`.
* Adres MongoDB w sekrecie oraz nazwa użytkownika bazy.
* Nazwa, pod którą Order Service rejestruje się w Consulu (domyślnie `order-service`, zmienna `ORDER_SERVICE_NAME`).
