# Kubernetes — user-service

Manifesty są przeznaczone dla namespace `shop`. Namespace, bazy, Consul, sekrety i polityki sieciowe są wspólną infrastrukturą i wymagają uzgodnienia z architektem.

`app.yaml` zawiera Deployment oraz Service typu ClusterIP. Obraz: `user-service:0.1.0`. Przy rejestracji w Consulu aplikacja przekazuje adres poda i jego nazwę jako identyfikator instancji.

User wymaga PostgreSQL pod nazwą `postgres:5432`, bazy `user_db`, użytkownika `user_service` oraz Secret `user-db-secret` z kluczem `password`.

Najpierw wykonuje się `migration-job.yaml` i czeka na jego zakończenie. Dopiero potem stosuje się `app.yaml`. Przy kolejnych migracjach Job wymaga nowej nazwy albo usunięcia wcześniej zakończonego Joba.

```sh
kubectl apply -f services/user-service/k8s/migration-job.yaml
kubectl -n shop wait --for=condition=complete job/user-db-migration --timeout=120s
kubectl apply -f services/user-service/k8s/app.yaml
```

Propozycja NetworkPolicy jest w `../docs/network-policy.proposed.yaml`. Plik należy przekazać osobie odpowiedzialnej za `deploy/k8s/`; ten PR nie zmienia wspólnego deploy. Podstawowa polityka User wybiera tylko aplikację (`app: user-service`), a Job migracji ma osobną etykietę `app: user-db-migration` i potrzebuje osobnej reguły egress do PostgreSQL oraz DNS. Jeżeli baza ma restrykcyjną politykę ingress, musi dopuszczać aplikację i Job.

Kontenery mają system plików tylko do odczytu, seccomp RuntimeDefault, UID 1000, wyłączone montowanie tokenu ServiceAccount oraz usunięte capabilities. Service User nie wybiera Joba migracji. Przed wdrożeniem trzeba dostarczyć obrazy i skonfigurować namespace `shop`, bazy, Consul, sekrety oraz CNI. Nie wykonano wdrożenia w klastrze docelowym.
