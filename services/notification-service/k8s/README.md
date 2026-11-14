# Kubernetes: notification-service

Manifesty dla namespace `shop`. Namespace, MongoDB, RabbitMQ (exchange `shop.events`, kolejki `notification.q` i `notification.dlq`, konto `notification-service`), Consul, Mailpit i polityki sieciowe to wspólna infrastruktura (`deploy/k8s/`, Michał).

| Plik | Co zawiera |
|---|---|
| `app.yaml` | Deployment `notification-service` i Service `ClusterIP` na porcie 8087 |

Usługa nie ma migracji: indeksy w MongoDB zakłada sama przy starcie.

Wymagania: obraz `notification-service:0.1.0` (`docker build -t notification-service:0.1.0 services/notification-service`), MongoDB pod nazwą `mongo:27017` z bazą `notification_db` i użytkownikiem `notification_service`, RabbitMQ `rabbitmq:5672`, Consul `consul:8500`, serwer SMTP `mailpit:1025`.

Hasła nie są w repozytorium. Secrety tworzy się raz, wartościami `NOTIFICATION_DB_PASSWORD` i `NOTIFICATION_RABBITMQ_PASSWORD` z `deploy/.env`:

```sh
kubectl -n shop create secret generic notification-db-secret --from-literal=password='<hasło>'
kubectl -n shop create secret generic notification-rabbitmq-secret --from-literal=password='<hasło>'
kubectl apply -f services/notification-service/k8s/app.yaml
kubectl -n shop rollout status deployment/notification-service
```

Sprawdzenie: `kubectl -n shop port-forward service/notification-service 8087:8087` i `curl -i http://127.0.0.1:8087/health/ready`. Readiness daje 503, gdy MongoDB nie odpowiada albo odbiorca zdarzeń się zatrzymał (np. usunięta kolejka); przyczyna jest w logu `Event consumer stopped` (`kubectl -n shop logs deployment/notification-service`). Po usunięciu przyczyny trzeba zrestartować usługę: `kubectl -n shop rollout restart deployment/notification-service`.

Kilka replik może czytać tę samą kolejkę: RabbitMQ rozdziela wiadomości, a unikalny indeks na `eventId` nie pozwala wysłać tego samego e-maila dwa razy.

Bezpieczeństwo kontenera: użytkownik 10001 (jak w `Dockerfile`), `runAsNonRoot`, `allowPrivilegeEscalation: false`, system plików tylko do odczytu (zapisywalny tylko `/tmp`), bez capabilities, seccomp `RuntimeDefault`, bez tokenu ServiceAccount.

Ruch sieciowy potrzebny w NetworkPolicy: wejście na 8087 z `api-gateway` oraz z `consul` (health check `/health/ready` na adres poda); wyjście do `mongo:27017`, `rabbitmq:5672`, `consul:8500`, `user-service:8082`, `mailpit:1025` i DNS.

Poprawka opisu ruchu — platforma (etap 7), na podstawie CR #15.

Nie wykonano wdrożenia w klastrze. Manifesty sprawdzono schematem Kubernetes 1.30 w trybie ścisłym (`kubeconform -strict`).
