# Kubernetes — user-service

Manifesty są przeznaczone dla namespace `shop`. Namespace, bazy, Consul, sekrety i polityki sieciowe są wspólną infrastrukturą i wymagają uzgodnienia z architektem.

`app.yaml` zawiera Deployment oraz Service typu ClusterIP. Obraz: `user-service:0.1.0`. Przy rejestracji w Consulu aplikacja przekazuje adres poda i jego nazwę jako identyfikator instancji.

User wymaga PostgreSQL pod nazwą `user-postgres:5432`, bazy `user_db`, użytkownika `user_service` oraz Secret `user-db-secret` z kluczem `password`.

Najpierw wykonuje się `migration-job.yaml` i czeka na jego zakończenie. Dopiero potem stosuje się `app.yaml`. Przy kolejnych migracjach Job wymaga nowej nazwy albo usunięcia wcześniej zakończonego Joba.

```sh
kubectl apply -f services/user-service/k8s/migration-job.yaml
kubectl -n shop wait --for=condition=complete job/user-db-migration --timeout=120s
kubectl apply -f services/user-service/k8s/app.yaml
```

Propozycja reguł dla wspólnej NetworkPolicy znajduje się w `../docs/network-policy.proposed.yaml`. W docelowym repo polityki należą do `deploy/k8s/`; plik wymaga przeglądu i przeniesienia przez architekta. Nie jest stosowany przez powyższe polecenia. Izolacja sieciowa jest warunkiem zaufania nagłówkom Gateway.
