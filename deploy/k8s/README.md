# Sklep w Kubernetesie (Rancher Desktop)

Cały sklep w lokalnym klastrze Kubernetes z Rancher Desktop (k3s), w przestrzeni nazw `shop`: infrastruktura (Consul z ACL, PostgreSQL, MongoDB, dwa Redisy, RabbitMQ, Mailpit), API Gateway, Auth Service, User Service, frontend, usługi zespołu i monitoring (Prometheus, Grafana, kube-state-metrics — sekcja „Metryki (Prometheus i Grafana)”). Klaster używa tych samych plików konfiguracji co Docker Compose (`deploy/consul/config/`, `deploy/postgres/init/`, `deploy/mongo/init/`, `deploy/rabbitmq/`), tych samych haseł z `deploy/.env` i tych samych obrazów `:dev`. Z zewnątrz sklep jest dostępny tylko przez Ingress `https://shop.localhost` (sekcja „Ingress i TLS”).

Opis infrastruktury, haseł i konwencji wspólnych z compose: [deploy/README.md](../README.md).

**Wszystkie polecenia uruchamia się z katalogu głównego repo.** Każde polecenie `kubectl` w tym pliku ma jawny kontekst i przestrzeń (`--context rancher-desktop -n shop`), żeby nie trafić do innego klastra. Skrypty `deploy/k8s/*.sh` same ustawiają kontekst i przestrzeń.

## Wymagania

1. **Rancher Desktop** z włączonym Kubernetes (Preferences → Kubernetes) i silnikiem `dockerd (moby)` (Preferences → Container Engine). Maszyna wirtualna: **8 GB pamięci i 4 CPU** (Preferences → Virtual Machine); `up.sh` ostrzega, gdy Docker widzi mniej niż 7,5 GiB.
   - **Traefik włączony** (Preferences → Kubernetes → „Enable Traefik”, domyślnie włączony). Bez niego w klastrze nie ma typu `Middleware` i `up.sh platform` kończy się błędem `no matches for kind "Middleware"`.
   - **Kontekst Dockera `rancher-desktop`** (tworzy go Rancher Desktop; sprawdzenie: `docker context ls`). `up.sh` używa go jawnie przy sprawdzaniu pamięci i przy `--build`, niezależnie od bieżącego kontekstu Dockera — obrazy `:dev` muszą trafić do Dockera, z którego korzysta k3s (inaczej pody kończą się `ErrImageNeverPull`).
2. **kubectl** z kontekstem `rancher-desktop` (instaluje go Rancher Desktop). Sprawdzenie:
   ```bash
   kubectl config get-contexts rancher-desktop
   ```
   Wynik: jeden wiersz z nazwą `rancher-desktop`. Błąd `not found` oznacza, że Kubernetes w Rancher Desktop jest wyłączony albo jeszcze startuje.
3. **Hasła** – ten sam skrypt co dla compose. Dopisuje brakujące zmienne, w tym tylko dla Kubernetesa trzy tokeny Consula: `CONSUL_MANAGEMENT_TOKEN` (token zarządzający), `CONSUL_AUTH_TOKEN` i `CONSUL_GATEWAY_TOKEN` (tokeny Auth i Gateway, sekcja „Consul z ACL”) oraz hasło admina Grafany `GRAFANA_ADMIN_PASSWORD` (sekcja „Metryki”):
   ```bash
   bash deploy/create-secrets.sh
   ```
4. **mkcert** (od części 7b – certyfikat `shop.localhost`): instalacja według [README mkcert](https://github.com/FiloSottile/mkcert), potem raz `mkcert -install` (dodaje lokalny urząd certyfikacji do systemu i przeglądarek).
5. **Wolna pamięć:** compose i Kubernetes mogą działać naraz (porty się nie pokrywają), ale na maszynie 8 GB wygodniej zatrzymać compose (`docker compose -f deploy/compose.yaml --profile full-shop stop`). Monitoring (warstwa `monitoring`) zajmuje ok. 300 MiB po starcie i do ok. 450 MiB po dłuższym oglądaniu panelu (Grafana rośnie do ok. 380 MiB); obraz Grafany ma ok. 1,9 GB, więc pierwsze uruchomienie tej warstwy trwa dłużej (pobieranie obrazu).

## Uruchomienie od zera

```bash
bash deploy/create-secrets.sh
bash deploy/k8s/up.sh all --build
```

`create-secrets.sh` kończy się podpowiedzią dla compose (`Done. Start: docker compose …`) — w Kubernetesie ją pomiń, dalej `up.sh`. `--build` buduje obrazy `:dev` tym samym poleceniem co compose (`docker compose … --profile full-shop build`, w kontekście Dockera `rancher-desktop`); bez niego `up.sh` używa obrazów, które już są w Dockerze. Na początku pojawia się dużo linii budowania obrazów (`#1 … DONE`) — to normalne; kroki samego skryptu zaczynają się od `== …`. Pierwsze uruchomienie trwa kilka minut. Skrypt kończy się linią `done: all` (kod wyjścia 0).

Sprawdzenie:
```bash
kubectl --context rancher-desktop -n shop get pods
```
Wszystkie pody `Running` i `READY 1/1`, pody Jobów (`consul-kv-seed-…`, `rabbitmq-setup-…`, `*-migrate-…`) `Completed` (Joby znikają same 10 minut po zakończeniu).

### Warstwy

`bash deploy/k8s/up.sh [infra|platform|services|monitoring|all] [--build]` (bez argumentu: `all`). Warstwa to katalog `deploy/k8s/<warstwa>/`; `all` = `infra` → `platform` → `services` → `monitoring`.

| Warstwa | Obciążenia | Joby |
|---|---|---|
| `infra` | `consul`, `consul-guard` (2 repliki), `postgres`, `mongo`, `redis-gateway`, `redis-cart`, `rabbitmq`, `mailpit` | `consul-kv-seed`, `rabbitmq-setup` (po obciążeniach) |
| `platform` (jak profil compose `platform`) | `api-gateway` (2 repliki), `auth-service`, `user-service`, `frontend`, Ingress | `auth-migrate`, `user-migrate` (przed obciążeniami) |
| `services` | `cart-service`, `inventory-service`, `review-service`, `product-service`, `notification-service` | `product-migrate` (przed obciążeniami) |
| `monitoring` | `prometheus`, `grafana`, `kube-state-metrics`; przed nimi obiekty całego klastra z `cluster/prometheus-kubelet.yaml` | — |

Kolejność kroków `up.sh`: przestrzeń `shop` (`namespace.yaml`) → Secrety (`secrets.sh`) → ConfigMapy z plików `deploy/` → NetworkPolicy (`network/*.yaml`, jeśli są, i szablon `network/node-access.yaml.tpl`) → warstwy. Na każdą warstwę skrypt czeka najwyżej 5 minut (`rollout status` obciążeń, `Complete` Jobów).

Przed tymi krokami `up.sh` odczytuje z klastra dwa adresy spoza sieci podów: `InternalIP` jedynego węzła (kubelet) i adres z portem API Kubernetesa (EndpointSlice usługi `kubernetes` w przestrzeni `default`). Podstawia je przy każdym uruchomieniu w ConfigMapie `prometheus-config` i w szablonie `node-access.yaml.tpl` (polecenie `sed` na standardowe wyjście, pliki w repo się nie zmieniają; w repo nie ma żadnego adresu). Klaster z więcej niż jednym węzłem, węzeł bez adresu IPv4 albo brak adresu API → komunikat i kod 1, zanim skrypt cokolwiek zmieni.

Bez monitoringu (np. maszyna wirtualna z mniejszą pamięcią): `bash deploy/k8s/up.sh infra && bash deploy/k8s/up.sh platform && bash deploy/k8s/up.sh services`.

Kody wyjścia: `0` – gotowe; `1` – błąd (Job zakończony błędem – skrypt wypisuje ostatnie 20 linii logu każdego jego kontenera, także `wait-for-network`; brak obrazu w Dockerze – sprawdzane tylko pody sklepu, z etykietą `app.kubernetes.io/part-of: shop`; przekroczony czas – skrypt wypisuje listę podów); `2` – złe argumenty, brak `kubectl`, brak kontekstu `rancher-desktop` (w `kubectl`, a przy `--build` także w Dockerze) albo klaster nie odpowiada. Warstwa bez plików: przy `all` komunikat `skipping <warstwa>: no manifests` i przejście dalej, przy jawnie podanej warstwie – ten sam komunikat i kod 1.

Ponowne uruchomienie jest bezpieczne: niezmienione obiekty zostają (`unchanged`), Joby są usuwane i tworzone od nowa, więc KV w Consulu i topologia RabbitMQ zawsze odpowiadają plikom w repo.

| Zmiana | Polecenie |
|---|---|
| plik w `deploy/consul/config/` albo `deploy/rabbitmq/` | `bash deploy/k8s/up.sh infra` |
| kod usługi (nowy obraz) | `bash deploy/k8s/up.sh <warstwa> --build` – skrypt najpierw buduje obrazy, a potem w podanej warstwie (przy `all` – w każdej), po jej Jobach migracji, robi `rollout restart` wdrożeń z obrazami `:dev` (przy `imagePullPolicy: Never` pody same nie pobierają nowego obrazu); nowy kod nie startuje na starym schemacie bazy, a wdrożeń innych warstw skrypt nie restartuje |
| manifest w `deploy/k8s/<warstwa>/` | `bash deploy/k8s/up.sh <warstwa>` |
| plik w `deploy/monitoring/` (konfiguracja Prometheusa, źródło danych i panele Grafany) | `bash deploy/k8s/up.sh monitoring` – zmieniona ConfigMapa (`configured`) → `rollout restart` Prometheusa albo Grafany (sekcja „Metryki”) |
| wpis usługi w `deploy/compose.yaml` (zmienne, obraz, polecenie) | ta sama zmiana w manifeście `deploy/k8s/<warstwa>/<usługa>.yaml` (zmienne 1:1 z compose, kryterium K30), potem `bash deploy/k8s/up.sh <warstwa>`; bez tego Kubernetes po cichu działa ze starymi zmiennymi |
| hasło w `deploy/.env` | procedura „Zmiana hasła” w sekcji „Infrastruktura w klastrze” (hasła baz i RabbitMQ zapisują się w danych – jak w compose) |

## Zatrzymanie

```bash
bash deploy/k8s/down.sh            # dane zostają
bash deploy/k8s/down.sh --purge    # usuwa też dane i Secrety
```

`down.sh` usuwa z przestrzeni `shop` wszystkie obiekty sklepu według rodzaju (nie według etykiet, więc także pozostałości po usuniętych manifestach i obiekty testowe): Ingress i middleware Traefika, HPA, PodDisruptionBudget, Deploymenty, StatefulSety, Joby, pozostałe pody, Service, ConfigMapy, NetworkPolicy, Role, RoleBinding i ServiceAccount (poza `default`, które Kubernetes ma w każdej przestrzeni). Czeka, aż znikną wszystkie pody (najwyżej 2 minuty). Wolumeny (PersistentVolumeClaim – dane PostgreSQL, MongoDB, RabbitMQ, Consula i koszyków) i Secrety zostają, więc następne `up.sh` startuje z tymi samymi danymi.

`--purge` usuwa dodatkowo wolumeny i Secrety: następne `up.sh` zakłada bazy, konta i token Consula od nowa. Żadna wersja nie usuwa przestrzeni `shop` ani niczego poza nią — także ClusterRole i ClusterRoleBinding `shop-prometheus-kubelet` z `deploy/k8s/cluster/` zostają (sekcja „Wyjątki”).

## Struktura `deploy/k8s/`

```
deploy/k8s/
  README.md        ten plik
  namespace.yaml   przestrzeń shop z etykietami Pod Security
  up.sh            uruchomienie (warstwy, --build, adresy węzła i API)
  down.sh          zatrzymanie (--purge)
  secrets.sh       Secrety z deploy/.env i deploy/secrets/ (uruchamia go up.sh)
  infra/           consul.yaml, consul-server.hcl, consul-kv-seed.yaml (Job), consul-acl-setup.sh,
                   consul-guard.yaml, consul-guard.py, consul-guard_test.py, postgres.yaml, mongo.yaml,
                   redis-gateway.yaml, redis-cart.yaml, rabbitmq.yaml, rabbitmq-setup.yaml (Job), mailpit.yaml
  platform/        auth-migrate.yaml (Job), auth-service.yaml, api-gateway.yaml, user-migrate.yaml (Job),
                   user-service.yaml, frontend.yaml, ingress.yaml
  services/        cart-service.yaml, inventory-service.yaml, review-service.yaml, product-migrate.yaml (Job),
                   product-service.yaml, notification-service.yaml
  monitoring/      prometheus.yaml, grafana.yaml, kube-state-metrics.yaml
  cluster/         prometheus-kubelet.yaml (ClusterRole i ClusterRoleBinding; stosuje up.sh w warstwie monitoring)
  network/         NetworkPolicy całej przestrzeni (*.yaml) i szablon node-access.yaml.tpl (adresy wstawia up.sh)
deploy/monitoring/ konfiguracja z repo dla ConfigMap warstwy monitoring:
  prometheus/prometheus.yml                 zadania zbierania (job) Prometheusa
  grafana/datasources.yaml                  źródło danych Grafany (Prometheus)
  grafana/dashboards.yaml                   dostawca paneli z plików
  grafana/dashboards/shop.json              panel „Sklep”
```

Pliki konfiguracji Prometheusa i Grafany leżą poza `deploy/k8s/monitoring/`, bo `up.sh` stosuje jako manifest każdy `*.yaml` katalogu warstwy.

Manifesty w `services/<usługa>/k8s/` (przykłady zespołu) **nie są używane** przy wdrożeniu – sklep w klastrze stawiają wyłącznie pliki z `deploy/k8s/`.

## Konwencje platformy

Wzór dla każdego manifestu w `deploy/k8s/`:

- **Jeden plik = jeden komponent** (obciążenie z jego Service, PodDisruptionBudget, HPA). **Job zawsze w osobnym pliku** – sam Job z etykietą `app.kubernetes.io/component: job`; `up.sh` rozpoznaje go po `kind: Job`, usuwa i tworzy od nowa przy każdym uruchomieniu, ustawia kolejność z tabeli „Warstwy”. Joby mają `ttlSecondsAfterFinished: 600`.
- **Etykiety** na obiekcie i w szablonie poda: `app.kubernetes.io/name: <nazwa>` (= nazwa w compose, w Consulu i nazwa Service), `app.kubernetes.io/part-of: shop`, `app.kubernetes.io/component: infra | platform | service | monitoring | job`. NetworkPolicy wybiera pody po `app.kubernetes.io/name`.
- **Bezpieczeństwo kontenera** (każdy kontener i initContainer): `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `seccompProfile.type: RuntimeDefault`; pod: `automountServiceAccountToken: false` (wyjątki: `prometheus` i `kube-state-metrics` — sekcja „Wyjątki”), `runAsUser`/`runAsGroup` = użytkownik z `Dockerfile` (Gateway, Auth, User, Cart `1000:1000`; Inventory, Review, Product, Notification `10001`; frontend `101`; obrazy infrastruktury i monitoringu – ich własny użytkownik, np. Consul `100:1000`, Prometheus i kube-state-metrics `65534`, Grafana `472`), `fsGroup` przy wolumenach, a przy wolumenie trwałym (StatefulSet z PVC) także `fsGroupChangePolicy: OnRootMismatch` – bez tego kubelet zmienia prawa plików przy każdym montowaniu (RabbitMQ odrzuca wtedy `.erlang.cookie` po restarcie poda).
- **`enableServiceLinks: false`** w każdym podzie: inaczej Kubernetes dodaje do środowiska zmienne `<SERVICE>_PORT=tcp://…` i `<SERVICE>_SERVICE_HOST` dla każdej Service w przestrzeni (np. `CONSUL_PORT`, `RABBITMQ_PORT`); usługa, która nie ustawia takiej zmiennej jawnie i liczy na wartość domyślną, dostałaby `tcp://…` zamiast numeru portu. `readOnlyRootFilesystem: true` wszędzie, gdzie obraz na to pozwala (`emptyDir` na `/tmp` i katalogi robocze); wyjątki w sekcji „Wyjątki”. Przestrzeń wymusza Pod Security `baseline`, a `restricted` tylko ostrzega (`Warning: would violate PodSecurity "restricted"` przy `apply` = odstępstwo do opisania).
- **initContainer `wait-for-network`** (Z12, Z13) w każdym obciążeniu, które przy starcie łączy się z Consulem (Gateway, Auth, User, usługi zespołu — cel `consul:8500`, czyli pośrednik `consul-guard`; sam `consul-guard` — `consul-server:8500`), i w każdym Jobie (`consul-kv-seed` → `consul-server:8500`, `rabbitmq-setup` → `rabbitmq:15672`, `*-migrate` → `postgres:5432`): w obrazie usługi albo Joba, próba TCP co 0,5 s, najwyżej 30 s, potem kod 1; ten sam `securityContext` co kontener główny, zasoby 10m/16Mi – 100m/64Mi. Powód: NetworkPolicy obejmuje nowy pod z opóźnieniem ok. 1,2 s (sekcja „NetworkPolicy”).
- **Zasoby** (`requests`/`limits`, punkt wyjścia z pomiaru compose):

  | Pod | requests pamięć | limits pamięć | requests CPU | limits CPU |
  |---|---|---|---|---|
  | `api-gateway` (×2) | 96Mi | 256Mi | 50m | 500m |
  | `auth-service` | 128Mi | 320Mi | 50m | 1000m |
  | `frontend` | 16Mi | 64Mi | 10m | 200m |
  | `user`, `cart`, `inventory`, `review`, `notification` | 96Mi | 256Mi | 25m | 500m |
  | `product` | 96Mi | 256Mi | 50m | 500m |
  | `consul` | 96Mi | 256Mi | 50m | 500m |
  | `consul-guard` (×2) | 32Mi | 96Mi | 25m | 200m |
  | `postgres` | 128Mi | 512Mi | 100m | 1000m |
  | `mongo` | 320Mi | 640Mi | 100m | 1000m |
  | `rabbitmq` | 192Mi | 512Mi | 100m | 1000m |
  | `redis-gateway`, `redis-cart` | 16Mi | 64Mi | 10m | 200m |
  | `mailpit` | 32Mi | 128Mi | 10m | 200m |
  | `prometheus` | 64Mi | 512Mi | 50m | 500m |
  | `grafana` | 128Mi | 512Mi | 50m | 500m |
  | `kube-state-metrics` | 32Mi | 128Mi | 10m | 200m |
  | Joby | 64Mi | 256Mi | 25m | 500m |

- **Sondy** usług: startupProbe `/health/live` (`periodSeconds: 2`, `failureThreshold: 60`), liveness `/health/live` (`periodSeconds: 10`, `timeoutSeconds: 2`, `failureThreshold: 3`), readiness `/health/ready` (`periodSeconds: 5`, `timeoutSeconds: 3`). Infrastruktura – polecenia jak healthcheck w compose (Consul: lider wybrany; PostgreSQL `pg_isready -h 127.0.0.1`; Redis `redis-cli ping`; RabbitMQ `check_port_connectivity`), Mongo – `tcpSocket 27017`.
- **Zamykanie:** każda usługa rejestrowana w Consulu ma `lifecycle.preStop.sleep.seconds: 10` i `terminationGracePeriodSeconds: 30` (inni trzymają listę adresów z Consula do 10 s). Gateway ma PodDisruptionBudget `minAvailable: 1`. Consul nie rejestruje sam siebie, więc nie ma `preStop`. `consul-guard` (też nie w Consulu): `preStop` 5 s (pod wypada z endpointów Service `consul`), po SIGTERM kończy rozpoczęte żądania (do 10 s), PodDisruptionBudget `minAvailable: 1`.
- **Sekrety:** jeden Secret na obciążenie `<nazwa>-secret`, klucze = nazwy zmiennych środowiskowych (`secretKeyRef`); Joby migracji używają Secretu swojej usługi. Tworzy je `secrets.sh` (tabela niżej). Wartości nigdy nie trafiają do repo ani do manifestów.
- **Zmienne:** dokładnie te z wpisu usługi w `deploy/compose.yaml` (nazwy i wartości nie-sekretne 1:1; hosty compose = nazwy Service w `shop`). Dodatkowo `SERVICE_ADDRESS` z `status.podIP` (adres rejestracji w Consulu) i `INSTANCE_ID` z `metadata.name` (poza Inventory i Review – ich kod sam dodaje przedrostek). Wyjątek: nginx frontendu wymaga pełnej nazwy (`GATEWAY_URL=http://api-gateway.shop.svc.cluster.local:8080`).
- **Obrazy:** usługi – te same `<nazwa>:dev` co compose, `imagePullPolicy: Never` (k3s używa Dockera Rancher Desktop, obraz z `docker build` widać od razu); infrastruktura – obrazy publiczne w tych samych wersjach co compose, `imagePullPolicy: IfNotPresent`; monitoring (nie ma go w compose) – obrazy publiczne z przypiętą wersją: `prom/prometheus:v3.15.1`, `grafana/grafana:13.3.1`, `registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.20.0`, `imagePullPolicy: IfNotPresent`.
- **Service** zawsze `type: ClusterIP`, nazwa = nazwa usługi, port z tabeli portów. Żadnych innych typów Service, portów na węźle ani sieci węzła w podach – z zewnątrz tylko Ingress (kryterium K2 sprawdza to `grep` po całym `deploy/k8s/`, także po tym pliku).

### Secrety (`secrets.sh`)

`bash deploy/k8s/secrets.sh` czyta `deploy/.env` jako tekst i `deploy/secrets/jwt-private.pem`, buduje Secrety w pamięci i podaje je `kubectl apply --server-side` na standardowe wejście – wartości nie pojawiają się w argumentach procesów, na ekranie ani w plikach. Wypisuje tylko nazwy (`secret/<nazwa> serverside-applied`). Brak zmiennej → komunikat z jej nazwą i podpowiedzią `bash deploy/create-secrets.sh`, kod 1. `ADMIN_EMAIL` nie jest wymagana (domyślnie `admin@sklep.local`, jak `${ADMIN_EMAIL:-admin@sklep.local}` w compose); wartość, która nie wygląda na adres e-mail → komunikat z nazwą zmiennej (bez wartości), kod 1.

Dlaczego `--server-side` (menedżer pól `shop-secrets`): zwykłe `kubectl apply` zapisuje w adnotacji `kubectl.kubernetes.io/last-applied-configuration` kopię całego obiektu, czyli wszystkie wartości Secretu w metadanych. Apply po stronie serwera tej adnotacji nie tworzy, ale też nie usuwa adnotacji ze starymi wartościami w Secretach utworzonych wcześniej zwykłym `apply` — dlatego `secrets.sh` po każdym apply szuka Secretów sklepu z tą adnotacją (wypisuje tylko nazwy) i usuwa ją (`secret/<nazwa> annotated`). Po pierwszym uruchomieniu nie ma już czego usuwać.

| Secret | Klucze | Źródło w `deploy/.env` |
|---|---|---|
| `postgres-secret` | `POSTGRES_PASSWORD`, `AUTH_DB_PASSWORD`, `USER_DB_PASSWORD`, `PRODUCT_DB_PASSWORD`, `INVENTORY_DB_PASSWORD`, `ORDER_DB_PASSWORD`, `SHIPPING_DB_PASSWORD` | te same nazwy |
| `mongo-secret` | `MONGO_INITDB_ROOT_PASSWORD`, `REVIEW_DB_PASSWORD`, `NOTIFICATION_DB_PASSWORD` | `MONGO_ROOT_PASSWORD`, te same |
| `rabbitmq-secret` | `RABBITMQ_DEFAULT_PASS` | `RABBITMQ_ADMIN_PASSWORD` |
| `rabbitmq-setup-secret` | `RABBITMQ_ADMIN_PASSWORD`, `AUTH_/NOTIFICATION_/INVENTORY_/SHIPPING_/ORDER_RABBITMQ_PASSWORD` | te same nazwy |
| `redis-gateway-secret`, `redis-cart-secret` | `REDIS_PASSWORD` | `REDIS_GATEWAY_PASSWORD`, `REDIS_CART_PASSWORD` |
| `consul-secret` | `acl.hcl` (konfiguracja ACL z tokenem), `CONSUL_HTTP_TOKEN`, `CONSUL_AUTH_TOKEN`, `CONSUL_GATEWAY_TOKEN` (dwa ostatnie tylko dla Joba `consul-kv-seed`) | `CONSUL_MANAGEMENT_TOKEN`, `CONSUL_AUTH_TOKEN`, `CONSUL_GATEWAY_TOKEN` |
| `auth-service-secret` | `DB_PASSWORD`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `RABBITMQ_PASSWORD`, `CONSUL_HTTP_TOKEN` | `AUTH_DB_PASSWORD`, `ADMIN_EMAIL` (opcjonalna, domyślnie `admin@sklep.local`), `ADMIN_PASSWORD`, `AUTH_RABBITMQ_PASSWORD`, `CONSUL_AUTH_TOKEN` |
| `auth-jwt-secret` | `jwt-private.pem` (plik `/run/secrets/jwt-private.pem`) | `deploy/secrets/jwt-private.pem` |
| `api-gateway-secret` | `REDIS_PASSWORD`, `CONSUL_HTTP_TOKEN` | `REDIS_GATEWAY_PASSWORD`, `CONSUL_GATEWAY_TOKEN` |
| `user-service-secret`, `product-service-secret` | `DB_PASSWORD` | `USER_DB_PASSWORD`, `PRODUCT_DB_PASSWORD` |
| `cart-service-secret` | `REDIS_URL` (z hasłem, jak w compose) | `REDIS_CART_PASSWORD` |
| `inventory-service-secret` | `DATABASE_URL` (z hasłem, jak w compose), `RABBITMQ_PASSWORD` | `INVENTORY_DB_PASSWORD`, `INVENTORY_RABBITMQ_PASSWORD` |
| `review-service-secret` | `MONGODB_URL` (z hasłem, jak w compose) | `REVIEW_DB_PASSWORD` |
| `notification-service-secret` | `DB_PASSWORD`, `RABBITMQ_PASSWORD` | `NOTIFICATION_DB_PASSWORD`, `NOTIFICATION_RABBITMQ_PASSWORD` |
| `grafana-secret` | `GF_SECURITY_ADMIN_PASSWORD` (hasło konta `admin` Grafany) | `GRAFANA_ADMIN_PASSWORD` (tylko Kubernetes; compose go nie używa) |
| `shop-tls` | `tls.crt`, `tls.key` | certyfikat mkcert (część 7b) |

Wartości Secretów nie wyświetla się (`kubectl get secret -o yaml` pokazuje je w base64, czyli jawnie). Lista kluczy i ich długości bez wartości: `kubectl --context rancher-desktop -n shop describe secret <nazwa>`.

### ConfigMapy (`up.sh`)

Tworzone przy każdym `up.sh` z plików repo poleceniem `kubectl create configmap … --from-file=… --dry-run=client -o yaml | kubectl apply -f -`; klucz = nazwa pliku. Zmiana pliku w repo + `up.sh` = nowa treść ConfigMapy i ponowne uruchomienie Joba.

| ConfigMap | Pliki | Używa |
|---|---|---|
| `consul-kv` | `deploy/consul/config/*.yaml`, `deploy/consul/seed-kv.sh` | Job `consul-kv-seed` (`/kv/config`) |
| `consul-acl-setup` | `deploy/k8s/infra/consul-acl-setup.sh` | Job `consul-kv-seed` |
| `consul-server-config` | `deploy/k8s/infra/consul-server.hcl` | `consul-0` (`/consul/config`, po restarcie poda) |
| `consul-guard` | `deploy/k8s/infra/consul-guard.py` | `consul-guard` (`/app`); zmiana treści → `up.sh` robi `rollout restart deploy/consul-guard` |
| `postgres-init` | `deploy/postgres/init/*` | `postgres` (tryb `0755`) |
| `mongo-init` | `deploy/mongo/init/*` | `mongo` |
| `rabbitmq-setup` | `deploy/rabbitmq/definitions.json`, `deploy/rabbitmq/setup.sh` | Job `rabbitmq-setup` |
| `prometheus-config` | `deploy/monitoring/prometheus/prometheus.yml` (adres węzła wstawiony przez `up.sh` w miejsce `__NODE_IP__`) | `prometheus` (`/etc/prometheus`); zmiana treści → `up.sh` robi `rollout restart deploy/prometheus` |
| `grafana-datasources` | `deploy/monitoring/grafana/datasources.yaml` | `grafana` (`/etc/grafana/provisioning/datasources`) |
| `grafana-dashboard-providers` | `deploy/monitoring/grafana/dashboards.yaml` | `grafana` (`/etc/grafana/provisioning/dashboards`) |
| `grafana-dashboards` | `deploy/monitoring/grafana/dashboards/*` | `grafana` (`/etc/grafana/dashboards`); zmiana treści którejkolwiek z trzech ConfigMap Grafany → `up.sh` robi `rollout restart deploy/grafana` |

## Infrastruktura w klastrze

| Komponent | Obiekt | Pod | Dane | Użytkownik |
|---|---|---|---|---|
| `consul` | StatefulSet + Service `consul-server:8500` | `consul-0` | PVC `data-consul-0` (1Gi) | `100:1000` (`consul` z obrazu) |
| `consul-guard` | Deployment (2 repliki) + Service `consul:8500` + PodDisruptionBudget | `consul-guard-…` | brak | `10001:10001` |
| `postgres` | StatefulSet + Service `postgres:5432` | `postgres-0` | PVC `data-postgres-0` (2Gi), katalog `pgdata` | `70:70` (`postgres` z obrazu) |
| `mongo` | StatefulSet + Service `mongo:27017` | `mongo-0` | PVC `data-mongo-0` (1Gi) | `999:999` (`mongodb` z obrazu) |
| `redis-gateway` | Deployment + Service `redis-gateway:6379` | `redis-gateway-…` | brak (liczniki limitów, jak w compose) | `999:1000` (`redis` z obrazu) |
| `redis-cart` | StatefulSet + Service `redis-cart:6379` | `redis-cart-0` | PVC `data-redis-cart-0` (512Mi), AOF | `999:1000` |
| `rabbitmq` | StatefulSet + Service `rabbitmq` (`amqp` 5672, `http` 15672, `prometheus` 15692 – metryki dla Prometheusa) | `rabbitmq-0` | PVC `data-rabbitmq-0` (1Gi) | `100:101` (`rabbitmq` z obrazu) |
| `mailpit` | Deployment + Service `mailpit` (`smtp` 1025, `http` 8025) | `mailpit-…` | brak (wiadomości znikają przy restarcie) | `1000:1000` |

- StatefulSety używają zwykłego Service ClusterIP jako `serviceName` – każdy komponent ma jedną replikę, a klienci łączą się po nazwie Service.
- Konta usług w PostgreSQL i MongoDB tworzą skrypty z `deploy/postgres/init/` i `deploy/mongo/init/` **tylko przy pustym wolumenie**; hasła kont `admin` (`POSTGRES_PASSWORD`, `MONGO_ROOT_PASSWORD`, `RABBITMQ_ADMIN_PASSWORD`) baza i broker ustawiają też tylko przy pustym wolumenie – po ich zmianie zostaje `bash deploy/k8s/down.sh --purge` i `up.sh` (dane znikają).
- **Zmiana hasła** konta usługi w `deploy/.env` bez kasowania danych. Pody czytają Secrety tylko przy starcie, więc pod bazy też trzeba uruchomić od nowa, zanim skrypt init ustawi nowe hasło:
  ```bash
  k() { kubectl --context rancher-desktop -n shop "$@"; }
  bash deploy/k8s/secrets.sh
  # PostgreSQL (<USŁUGA>_DB_PASSWORD): nowe zmienne w postgres-0, potem ALTER ROLE ze skryptu init
  k rollout restart statefulset/postgres && k rollout status statefulset/postgres
  k exec postgres-0 -- bash /docker-entrypoint-initdb.d/01-service-databases.sh
  # MongoDB (REVIEW_DB_PASSWORD, NOTIFICATION_DB_PASSWORD): tak samo, skrypt init aktualizuje użytkowników
  k rollout restart statefulset/mongo && k rollout status statefulset/mongo
  k exec mongo-0 -- sh -c 'mongosh --quiet -u admin -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin /docker-entrypoint-initdb.d/01-service-users.js'
  # RabbitMQ (<USŁUGA>_RABBITMQ_PASSWORD): Job rabbitmq-setup ustawia hasła kont usług przy każdym up.sh infra
  bash deploy/k8s/up.sh infra
  # na koniec usługi, które używają zmienionego hasła, np.:
  k rollout restart deploy/cart-service
  ```
  Hasła Redisów (`REDIS_GATEWAY_PASSWORD`, `REDIS_CART_PASSWORD`) nie są zapisane w danych: `secrets.sh`, potem `rollout restart` Redisa (`deploy/redis-gateway`, `statefulset/redis-cart`) i jego usługi.
- **RabbitMQ:** nazwa węzła `rabbit@rabbitmq-0` wynika z nazwy poda i nie zmienia się po jego odtworzeniu, więc broker znajduje swoje dane na tym samym wolumenie. Job `rabbitmq-setup` przy każdym `up.sh` wgrywa `deploy/rabbitmq/definitions.json` i konta 5 usług; import tylko dodaje (zmiana typu albo argumentów istniejącej kolejki wymaga `down.sh --purge`). Konta `guest` nie ma.
- Sondy infrastruktury: PostgreSQL `pg_isready -h 127.0.0.1` (z `-h` gotowy dopiero po skryptach init), MongoDB `tcpSocket 27017` na adresie poda (w czasie init obraz uruchamia tymczasowy `mongod` tylko na 127.0.0.1), Redisy `redis-cli ping` z hasłem ze zmiennej poda, RabbitMQ `rabbitmq-diagnostics -q check_port_connectivity`, Mailpit `/mailpit readyz` (jak w compose). PostgreSQL i MongoDB mają `startupProbe` do 120 s na skrypty init.

### Sprawdzenie z poda (bez haseł na ekranie)

Hasła są tylko w zmiennych środowiskowych poda; polecenie w `sh -c '…'` w pojedynczym cudzysłowie rozwija je w podzie, nie w terminalu.

```bash
k() { kubectl --context rancher-desktop -n shop "$@"; }

# PostgreSQL: logowanie hasłem przez adres poda (połączenia z 127.0.0.1 obraz przepuszcza bez hasła)
k exec postgres-0 -- sh -c 'PGPASSWORD="$AUTH_DB_PASSWORD" psql -h "$(hostname -i)" -U auth_service -d auth_db -tAc "select current_user"'
# MongoDB: hasło z process.env, nie w argumentach procesu
k exec mongo-0 -- mongosh --quiet --nodb --eval 'const c = new Mongo("mongodb://127.0.0.1:27017"); c.getDB("review_db").auth("review_service", process.env.REVIEW_DB_PASSWORD); printjson(c.getDB("review_db").getCollectionNames())'
# Redis koszyków
k exec redis-cart-0 -- sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli dbsize'
# RabbitMQ: narzędzia CLI uwierzytelniają się ciasteczkiem Erlanga w podzie
k exec rabbitmq-0 -- rabbitmqctl -q list_queues name type messages    # 8 kolejek quorum
k exec rabbitmq-0 -- rabbitmqctl -q list_users                        # admin + 5 kont usług
k logs job/rabbitmq-setup                                             # wynik ostatniego wgrania topologii (do 10 min po up.sh)
```
Joby znikają 10 minut po zakończeniu (`ttlSecondsAfterFinished: 600`); później `k logs job/…` kończy się `NotFound`. Ponowne `bash deploy/k8s/up.sh infra` uruchamia `consul-kv-seed` i `rabbitmq-setup` od nowa.

## Porty na laptopie (`port-forward`)

W klastrze nic poza Ingressem nie ma portu na laptopie. Panele i Swagger otwiera się na czas pracy przez `kubectl port-forward` (działa do Ctrl+C). Porty są inne niż w compose, żeby oba środowiska mogły działać naraz.

| Co | Polecenie | Adres |
|---|---|---|
| Consul UI i API | `kubectl --context rancher-desktop -n shop port-forward svc/consul-server 18500:8500` (serwer; `svc/consul` to pośrednik, który UI odrzuca) | http://127.0.0.1:18500/ui |
| Mailpit (e-maile) | `kubectl --context rancher-desktop -n shop port-forward svc/mailpit 18025:8025` | http://127.0.0.1:18025 (także `localhost:18025`) |
| Panel RabbitMQ | `kubectl --context rancher-desktop -n shop port-forward svc/rabbitmq 18672:15672` | http://127.0.0.1:18672 (konto `admin`, hasło `RABBITMQ_ADMIN_PASSWORD` z `deploy/.env`) |
| Swagger usługi | `kubectl --context rancher-desktop -n shop port-forward svc/<usługa> 1808x:808x` (np. Product `18083:8083`) | np. http://127.0.0.1:18083/docs |
| Grafana (panel „Sklep”) | `kubectl --context rancher-desktop -n shop port-forward svc/grafana 13000:3000` | http://127.0.0.1:13000 (bez logowania: podgląd; konto `admin`, hasło `GRAFANA_ADMIN_PASSWORD` z `deploy/.env`) |
| Prometheus | `kubectl --context rancher-desktop -n shop port-forward svc/prometheus 19090:9090` | http://127.0.0.1:19090 (cele: http://127.0.0.1:19090/targets) |

## Consul z ACL

W klastrze Consul ma włączone ACL z polityką domyślną `deny` (w compose działa bez ACL). Ma też `CHECKPOINT_DISABLE=1`: nie sprawdza aktualizacji w `checkpoint-api.hashicorp.com`, bo NetworkPolicy nie wypuszcza ruchu z przestrzeni do internetu i każdy start kończyłby się błędem w logu.

- **Bez tokenu** (usługi zespołu, Consul UI bez logowania) działa polityka `anonymous-shop`: odczyt konfiguracji `config/…` z KV, odczyt katalogu i zdrowia wszystkich usług oraz węzłów, a rejestracja i wyrejestrowanie (z health checkami) **tylko pod nazwami usług zespołu z listy dozwolonych**: `user-service`, `cart-service`, `inventory-service`, `review-service`, `product-service`, `notification-service`, `order-service`, `shipping-service`. Każda inna nazwa — w tym **zastrzeżone** `auth-service` i `api-gateway` — jest bez tokenu tylko do odczytu (zdrowe instancje, katalog); rejestracja i wyrejestrowanie kończą się błędem 403. Reguły (`deploy/k8s/infra/consul-acl-setup.sh`):
  ```hcl
  service_prefix "" { policy = "read" }
  node_prefix "" { policy = "read" }
  key_prefix "config/" { policy = "read" }
  service "user-service" { policy = "write" }
  service "cart-service" { policy = "write" }
  # … i tak dalej dla każdej nazwy z listy
  ```
  Zapis do KV, odczyt agenta (`/v1/agent/self`, `/v1/agent/metrics`, `/v1/agent/monitor` — logi agenta), odczyt i zmiana ACL bez tokenu kończą się błędem 403. Rejestracja, sprawdzanie własnego wpisu (`GET /v1/agent/service/<id>`) i wyrejestrowanie potrzebują tylko reguły `service`.

  **Dlaczego lista dozwolonych, a nie `service_prefix "" { policy = "write" }` z wyjątkami (Z20).** Consul porównuje nazwy usług w katalogu bez rozróżniania wielkości liter, a reguły ACL — z rozróżnieniem. Przy zapisie dla wszystkich nazw anonim rejestrował `AUTH-SERVICE` albo `Auth-Service` (reguła `service "auth-service"` ich nie obejmuje), a Consul zwracał ten wpis na pytanie o `auth-service` — czyli Gateway mógł wysłać logowania z hasłami do obcego poda. Przy liście dozwolonych każdy wariant wielkości liter (np. `Cart-Service`) i każda nazwa spoza listy jest tylko do odczytu. **Nowa usługa zespołu = dopisanie jej nazwy do `TEAM_SERVICES` w `consul-acl-setup.sh`** i `bash deploy/k8s/up.sh infra`; bez tego usługa dostaje 403 przy rejestracji w Consulu i Gateway jej nie znajdzie (`503`).
- **Token zarządzający** = `CONSUL_MANAGEMENT_TOKEN` z `deploy/.env` (UUID). `secrets.sh` wpisuje go do Secretu `consul-secret` (plik konfiguracji `acl.hcl` – token startowy i token agenta – oraz `CONSUL_HTTP_TOKEN` dla Joba). Używa go tylko Job `consul-kv-seed`: wgrywa KV z repo i ustawia politykę `anonymous-shop` przy każdym `up.sh`. Agent Consula używa tego samego tokenu do własnych wpisów (bez tego w logu pojawiałyby się ostrzeżenia `blocked by ACLs`).
- **Tokeny Auth i Gateway.** Tylko Auth Service i API Gateway mają własne tokeny Consula: `CONSUL_AUTH_TOKEN` i `CONSUL_GATEWAY_TOKEN` z `deploy/.env` (UUID, tworzy je `bash deploy/create-secrets.sh`; compose ich nie używa). Po co: Gateway kieruje `/api/v1/auth/**` (logowanie z hasłem, rejestracja) do instancji `auth-service` z Consula, więc bez zastrzeżenia nazwy dowolny pod mógłby zarejestrować `auth-service` ze swoim adresem i przejąć te żądania.
  - `secrets.sh` wpisuje oba tokeny do `consul-secret` (klucze `CONSUL_AUTH_TOKEN`, `CONSUL_GATEWAY_TOKEN` — tylko dla Joba; StatefulSet `consul` montuje z tego Secretu wyłącznie `acl.hcl` i `CONSUL_HTTP_TOKEN`) oraz jako `CONSUL_HTTP_TOKEN` do `auth-service-secret` i `api-gateway-secret`. Wszystkie trzy tokeny muszą być UUID i muszą się różnić (inaczej `secrets.sh` kończy się błędem z nazwami zmiennych).
  - Job `consul-kv-seed` (`consul-acl-setup.sh`) przy każdym `up.sh infra` tworzy albo aktualizuje polityki `auth-service` i `api-gateway` oraz tokeny o tych SecretID. Polityki i tokeny skrypt szuka na listach (`consul acl policy list`, `consul acl token list` — SecretID porównywany w `jq`, nie trafia na wyjście), a nie odczytem pojedynczego obiektu, bo odczyt nieistniejącej polityki albo tokenu daje w logu Consula `[ERROR] … ACL not found` (pierwsze uruchomienie na pustym Consulu: 0 linii `[ERROR]`). Token jest → aktualizacja polityki przez jego AccessorID; nie ma → utworzenie. Potem skrypt usuwa **inne** tokeny, które mają przypiętą wyłącznie politykę `auth-service` (`api-gateway`), bez innych polityk, ról ani tożsamości usług i węzłów. Token zarządzający (jest też tokenem agenta) i token anonimowy mają inne polityki, więc nigdy nie są usuwane. W logu Joba są tylko nazwy polityk i tokenów oraz AccessorID usuniętych tokenów (`deleted old token of auth-service <AccessorID>`), nigdy wartości. Drugie uruchomienie niczego nie dubluje i niczego nie usuwa. Gdy lista tokenów albo usunięcie się nie powiedzie, Job kończy się błędem (`failed to delete old token of auth-service <AccessorID>`) i `up.sh` się zatrzymuje.
  - Co może token: zapis (rejestracja, wyrejestrowanie) tylko własnej nazwy oraz odczyty, których usługa potrzebuje — `service_prefix "" read` (zdrowe instancje innych usług), `node_prefix "" read`, `key_prefix "config/" read`, `agent_prefix "" read`. Token Auth nie zarejestruje `cart-service` ani `api-gateway`; żaden z nich nie zapisze KV.
  - Usługa wysyła token w nagłówku `X-Consul-Token` we wszystkich wywołaniach Consula (rejestracja, sprawdzanie wpisu, wyrejestrowanie, odczyt KV, wyszukiwanie instancji). Zmienna `CONSUL_HTTP_TOKEN` jest opcjonalna — w compose pusta, więc bez nagłówka, jak dotąd. Token nie trafia do logów; 403 z Consula daje w logu np. `Consul registration responded with 403 (ACL: CONSUL_HTTP_TOKEN missing or without permission)`.
  - **Zmiana tokenu Auth albo Gateway** (nowa wartość w `deploy/.env`) — bez `down.sh --purge`, oba polecenia jedno po drugim:
    ```bash
    bash deploy/k8s/up.sh infra && \
      kubectl --context rancher-desktop -n shop rollout restart deploy/auth-service deploy/api-gateway
    ```
    `up.sh infra` wgrywa nowy Secret, a Job tworzy nowy token i usuwa stary — od tej chwili rejestracja starym tokenem kończy się błędem 403, więc starego tokenu nie trzeba usuwać ręcznie. Pody czytają Secret tylko przy starcie, a `up.sh platform` nie restartuje Deploymentu, którego manifest się nie zmienił — stąd `rollout restart` od razu po Jobie.

    Skutki przejściowe (znane, same mijają):
    - Między Jobem a restartem działające pody mają już nieważny token. Ich wpisy w Consulu zostają, ale agent nie może aktualizować stanu ich health checków (w logu `consul-0` `Check registration blocked by ACLs`); zapytanie usługi o własny wpis może dostać 403 (wtedy w logu Auth/Gateway ostrzeżenie `Consul is not reachable, will retry the registration`).
    - Stare pody nie mogą się wyrejestrować (403). Ich wpisy zostają w katalogu z ostatnim stanem `passing` jeszcze ok. 1,5–2 min po zatrzymaniu poda, aż agent usunie je sam (`DeregisterCriticalServiceAfter` 1 min + przegląd co ok. 30 s; w logu `consul-0` `deregistered service with critical health …`). Gateway może w tym czasie wybrać taki adres; połączenie nie powstaje, więc Gateway ponawia żądanie na innej instancji i wyrzuca martwą z listy.
    - Kryterium „`blocked by acls` = 0 w logu `consul-0`” sprawdza się dopiero 5 min po zmianie tokenu.

    Podgląd tokenów w Consulu (AccessorID, polityki, opis — bez SecretID):
    ```bash
    kubectl --context rancher-desktop -n shop exec consul-0 -- sh -c 'consul acl token list -token-file=/consul/token/CONSUL_HTTP_TOKEN -format=json | jq -r ".[] | [.AccessorID, ([.Policies[]?.Name] | join(\"+\")), .Description] | @tsv"'
    ```
    Po zmianie tokenu jest dokładnie jeden token z polityką `auth-service` i jeden z `api-gateway`. (Zwykłe `consul acl token list` bez `-format=json | jq` wypisuje też SecretID — nie używać go na ekranie.) Zmiana tokenu **zarządzającego** — punkt niżej.
- **W podzie `consul-0`** token jest tylko jako plik `/consul/token/CONSUL_HTTP_TOKEN`, nie w zmiennych środowiskowych – polecenia w podzie bez `-token-file` działają jak anonim. Polecenie z tokenem, bez wyświetlania go:
  ```bash
  kubectl --context rancher-desktop -n shop exec consul-0 -- consul acl policy list -token-file=/consul/token/CONSUL_HTTP_TOKEN
  ```
  Konfigurację usług zmienia się w `deploy/consul/config/` i `bash deploy/k8s/up.sh infra`, nie ręcznym zapisem do KV.
- **Consul UI:** `port-forward` z tabeli wyżej, http://127.0.0.1:18500/ui. Bez logowania widać usługi i konfigurację; pełny dostęp po „Log in” tokenem – wartością `CONSUL_MANAGEMENT_TOKEN` z własnego `deploy/.env` (nie wkleja się jej do czatu ani do repo).
- **Zmiana tokenu zarządzającego** (`CONSUL_MANAGEMENT_TOKEN` w `deploy/.env`) — bez `down.sh --purge`. Consul czyta `acl.hcl` tylko przy starcie: przy każdym starcie tworzy token zarządzający z konfiguracji, jeśli go jeszcze nie zna, a dotychczasowy zostaje ważny. Dopóki `consul-0` działa ze starą konfiguracją, Job `consul-kv-seed` z nowym tokenem dostaje 403. Kolejność:
  ```bash
  k() { kubectl --context rancher-desktop -n shop "$@"; }
  bash deploy/k8s/secrets.sh
  k rollout restart statefulset/consul && k rollout status statefulset/consul
  bash deploy/k8s/up.sh infra
  # stary token zarządzający: usunięcie (na ekranie tylko AccessorID)
  k exec consul-0 -- sh -c 'T=/consul/token/CONSUL_HTTP_TOKEN; self=$(consul acl token read -self -token-file=$T -format=json | jq -r .AccessorID); for id in $(consul acl token list -token-file=$T -format=json | jq -r --arg self "$self" ".[] | select(.AccessorID != \$self) | select(any(.Policies[]?; .Name == \"global-management\")) | .AccessorID"); do consul acl token delete -token-file=$T -accessor-id "$id"; done'
  ```
  Dane Consula (KV, tokeny Auth i Gateway, wpisy usług) zostają na wolumenie. Ostatnie polecenie usuwa każdy inny token z polityką `global-management` niż bieżący — także utworzony ręcznie.

## Pośrednik przed Consulem (`consul-guard`)

**Po co (decyzja Michała M2 → C; Z23, Z25, Z27).** Kto rejestruje usługę w Consulu, ten ustala jej health check HTTP: adres, metodę, nagłówki i treść żądania. Check wykonuje serwer Consula (`consul-0`), który łączy się z każdą usługą i z Gateway (tabela połączeń) i jest w zakresie zaufanym Gateway (`TRUSTED_PROXIES`). Bez pośrednika przejęty pod usługi zespołu mógł zarejestrować check, przez który Consul wysyłał do dowolnej usługi żądanie z dowolnymi `X-User-Id`/`X-User-Roles` (z pominięciem Gateway i NetworkPolicy), a do Gateway z dowolnym `X-Forwarded-For`, i czytać odpowiedź z pola `Output` checku. Dlatego usługi nie łączą się z serwerem Consula bezpośrednio:

- Service **`consul`** (8500) to Deployment `consul-guard`: 2 repliki, PodDisruptionBudget, obraz publiczny `python:3.12-slim`, skrypt `infra/consul-guard.py` z ConfigMapy `consul-guard` (tylko biblioteka standardowa Pythona). Zmienne usług (`CONSUL_HOST=consul`, `CONSUL_URL=http://consul:8500`) są takie jak w compose, więc kod usług nic nie wie o pośredniku.
- Service **`consul-server`** (8500) to serwer Consula (StatefulSet `consul`, pod `consul-0`). NetworkPolicy wpuszcza do niego tylko `consul-guard` i Job `consul-kv-seed` (token zarządzający); UI i scenariusz `postman/run.sh k8s` łączą się przez `kubectl port-forward svc/consul-server` (ruch z węzła).
- Serwer ma `discard_check_output = true` (`infra/consul-server.hcl`, ConfigMapa `consul-server-config` w katalogu `/consul/config` obok `acl.hcl` z Secretu): pole `Output` checków jest zawsze puste.

**Co przepuszcza (lista dozwolonych, wszystko inne → `403`).** Ścieżka jest porównywana w całości, bez żadnej normalizacji; `<nazwa>` i `<id>` to `[A-Za-z0-9._-]{1,128}`; `..`, `//`, `%` (w każdym kodowaniu), `\`, `#` i znaki spoza ASCII są odrzucane. Zapytanie musi być dokładnie jednym z wymienionych — każdy inny parametr (także `token`, `dc`, `ns`, `index`, `wait`) i parametr powtórzony → `403`. Pośrednik przepuszcza tylko to, czego używa kod 8 usług.

| Wywołanie | Zapytanie | Do czego |
|---|---|---|
| `GET /v1/kv/config/<nazwa>/data` | brak, `raw`, `raw=true` | konfiguracja przy starcie (Gateway i Auth `?raw`, usługi Pythona `raw=true`) |
| `GET /v1/health/service/<nazwa>` | brak, `passing`, `passing=true` | zdrowe instancje innej usługi |
| `GET /v1/agent/service/<id>` | brak | sprawdzanie własnego wpisu (co 15 s) |
| `PUT /v1/agent/service/register` | brak | rejestracja — warunki niżej |
| `PUT /v1/agent/service/deregister/<id>` | brak | wyrejestrowanie przy zamykaniu — tylko wpisu, który w Consulu ma adres poda wysyłającego żądanie |
| `GET /guard/live`, `GET /guard/ready` | brak | sondy pośrednika (`ready` = serwer Consula ma lidera) |

Rejestracja przechodzi tylko wtedy, gdy:
- treść to obiekt JSON bez powtórzonych kluczy, z nagłówkiem `Content-Length`, najwyżej 16 KiB (inaczej `411` albo `413`);
- pola to tylko `ID`, `Name`, `Address`, `Port`, `Meta` (Inventory, Review) i `Check` — wielkość liter ma znaczenie; `Tags`, `Checks`, `Kind`, `Proxy`, `Connect`, `TaggedAddresses` i każde inne → `403`;
- `Address` to adres IP poda, z którego przyszło połączenie, `Port` to liczba 1–65535, `Name` i `ID` jak `<nazwa>`;
- wpisu o tym ID (bez `ID` — o ID równym `Name`, tak liczy Consul) nie ma albo ma ten sam adres: pod nie zastąpi wpisu innego poda, a ponowna rejestracja tego samego poda przechodzi;
- `Check` ma tylko pola `Name`, `CheckID`, `HTTP`, `Interval`, `Timeout`, `DeregisterCriticalServiceAfter`, `Status`, `Notes` i `Method` (tylko `GET`), a `HTTP` to dokładnie `http://<Address>:<Port>/health/ready` albo `…/health/live`; `Header`, `Body`, `TCP`, `GRPC`, `Args`, `TTL` i każde inne pole → `403`.

Do Consula idzie zwalidowany JSON z jednym dopisanym polem w checku: `"DisableRedirects": true` (Z27). Consul domyślnie podąża za przekierowaniem, więc pod, który na własne `/health/ready` odpowiada `302`, kierowałby check pod dowolny adres (sprawdzone na Consulu 1.21: bez pola 8 wejść w 8 s pod adres z `Location`, z polem 0 wejść i check `critical`). Pole ustawia tylko pośrednik — klient, który przyśle je sam, dostaje `403`. Do Consula przechodzą tylko nagłówki `X-Consul-Token`, `Content-Type` i `Accept`; odpowiedź Consula (kod, nagłówki, treść) wraca bez zmian. Limit czasu do Consula 5 s (`504`), brak połączenia `502`.

**Log pośrednika** (JSON na stdout, jedna linia na zdarzenie: `time`, `level`, `message`, `method`, `path` bez zapytania, `client`, `decision`, `reason`, a przy przepuszczonej rejestracji i wyrejestrowaniu także `status` od Consula): każda odmowa (`warning`), każdy błąd Consula (`error`), każda rejestracja i wyrejestrowanie (`info`). Zwykłych odczytów nie loguje; treści żądań, nagłówków i tokenów — nigdy.
```bash
kubectl --context rancher-desktop -n shop logs deploy/consul-guard --prefix --tail=100 | grep '"deny"'
```
Odmowa pośrednika to `403` ze zwykłym tekstem i powodem, np. `consul-guard: check field not allowed: Header`; odmowa ACL Consula (np. rejestracja nazwy spoza listy dozwolonych) ma inną treść (`Permission denied: …`), a w logu pośrednika jest jako przepuszczona rejestracja ze `status: 403`.

**Nowe pole rejestracji albo nowe wywołanie Consula w usłudze** (np. `Tags`, nowy parametr zapytania): dopisać wzorzec w `deploy/k8s/infra/consul-guard.py` (`ROUTES`, `QUERIES`, `REGISTRATION_FIELDS`, `CHECK_FIELDS`) i test w `consul-guard_test.py`, uruchomić testy, potem `bash deploy/k8s/up.sh infra` — nowa treść trafia do ConfigMapy, a `up.sh` sam restartuje `consul-guard` (po jednej replice, PodDisruptionBudget). Testy bez klastra:
```bash
docker run --rm -v "$PWD/deploy/k8s/infra:/src:ro" -w /src python:3.12-slim python -I consul-guard_test.py -v
```
Zmiana `consul-server.hcl`: `bash deploy/k8s/up.sh infra`, potem `k rollout restart statefulset/consul`.

**Aktualizacja klastra postawionego przed pośrednikiem.** Pole `serviceName` StatefulSetu `consul` (teraz `consul-server`) jest niezmienne, więc `up.sh` na takim klastrze kończy się błędem `The StatefulSet "consul" is invalid: spec: Forbidden: updates to statefulset spec …`. Jednorazowo: `bash deploy/k8s/down.sh && bash deploy/k8s/up.sh all` — wolumeny (KV, tokeny, bazy) zostają.

**Docelowy wzorzec produkcyjny** (poza zakresem projektu). Pośrednik obchodzi to, że usługi zespołu rejestrują się w Consulu bez tokenu. W produkcji tożsamość usługi daje Kubernetes: metoda logowania `kubernetes` w ACL Consula (konto usługi poda → token Consula tylko dla jej nazwy), rejestrację i checki na podstawie sond readiness robi consul-k8s (usługa nic nie rejestruje sama), a połączenia między usługami chroni mTLS z regułami „kto z kim” (Consul Connect intentions albo service mesh, np. Istio).

## Platforma (Gateway, Auth, User, frontend)

| Obiekt | Plik | Co |
|---|---|---|
| Job `auth-migrate` | `platform/auth-migrate.yaml` | `prisma migrate deploy` na `auth_db` (to samo polecenie co w compose) |
| Job `user-migrate` | `platform/user-migrate.yaml` | `alembic upgrade head` na `user_db` |
| Deployment + Service `auth-service:8081` | `platform/auth-service.yaml` | 1 replika; hasła i token Consula z `auth-service-secret`, klucz prywatny JWT z `auth-jwt-secret` jako plik `/run/secrets/jwt-private.pem` (`0440`, grupa `1000` przez `fsGroup`); konto admina: `ADMIN_EMAIL` z `auth-service-secret` (domyślnie `admin@sklep.local`; inny adres: `ADMIN_EMAIL=…` w `deploy/.env` przed pierwszym startem, jak w compose) |
| Deployment + Service `api-gateway:8080`, Service `api-gateway-metrics:9080` (bez adresu, `clusterIP: None`), PodDisruptionBudget, HPA | `platform/api-gateway.yaml` | 2 repliki (HPA 2–3); zmienne jak w compose poza `TRUSTED_PROXIES`, `AUTH_JWKS_ORIGIN` i `CONSUL_HTTP_TOKEN` (niżej); metryki na osobnym porcie 9080 tylko dla Prometheusa (sekcja „Metryki”) |
| Deployment + Service `user-service:8082` | `platform/user-service.yaml` | 1 replika (Auth tworzy w niej profil przy rejestracji — dlatego User jest w tej warstwie, jak w profilu compose `platform`) |
| Deployment + Service `frontend:8080` | `platform/frontend.yaml` | nginx z aplikacją React (sekcja „Ingress i TLS”) |

`up.sh platform` najpierw uruchamia od nowa oba Joby migracji i czeka na `Complete`, potem stawia obciążenia. Usługi rejestrują się w Consulu z adresem poda (`SERVICE_ADDRESS` z `status.podIP`) i ID = nazwa poda (`INSTANCE_ID` z `metadata.name`; to samo ID Gateway wysyła w nagłówku `X-Gateway-Instance-Id`).

**Repliki, PDB, HPA.** Traefik rozkłada ruch na 2 repliki Gateway (pierwszy poziom load balancingu, `X-Gateway-Instance-Id` na zmianę). PodDisruptionBudget `minAvailable: 1` nie pozwala dobrowolnie zatrzymać obu podów naraz. HPA trzyma 2–3 repliki według CPU (cel 70 % z `requests.cpu`), po spadku obciążenia czeka 60 s. Deployment ma `replicas: 2`, więc ponowne `up.sh`, gdy HPA trzyma 3 repliki, ustawia na moment 2 (HPA podnosi z powrotem przy następnym sprawdzeniu, jeśli obciążenie trwa). Podgląd: `kubectl --context rancher-desktop -n shop get hpa` (`TARGETS` = `<unknown>` przez ok. minutę po starcie).

**Zamykanie podów.** Usługa rejestrowana w Consulu przed zatrzymaniem czeka 10 s (`preStop.sleep`), potem dostaje SIGTERM, wyrejestrowuje się i zamyka serwer; limit 30 s. W tych 10 s pod wypada z endpointów Service, a inne usługi odświeżają listę instancji z Consula. Zmierzone: po usunięciu poda Auth wpis w Consulu znika po ok. 10,5 s, pod kończy się po ok. 11,4 s.

**Klucze JWKS z Service, nie z Consula (decyzja 8).** Gateway ma `AUTH_JWKS_ORIGIN=http://auth-service.shop.svc.cluster.local:8081` i pobiera klucze do weryfikacji tokenów przez Service `auth-service`, bez Consula. Od zmiany Z9 nazwa `auth-service` w Consulu jest zastrzeżona (rejestruje ją tylko token Auth, sekcja „Consul z ACL”), więc fałszywa instancja nie wejdzie do Consula; JWKS z Service zostaje jako druga warstwa — nawet gdyby ktoś zdobył token Auth, nie podsunie Gateway własnych kluczy (Service w Kubernetesie może utworzyć tylko ktoś z dostępem do API klastra). W logu Gateway: `JWKS keys loaded from Auth Service` z polem `source: "origin"`. Trasy `/api/v1/auth/**` idą do instancji `auth-service` z Consula — chronionych tym samym zastrzeżeniem nazwy. W compose zmienna nie jest ustawiona (klucze z Consula, Consul bez ACL).

**Zaufany proxy (decyzja 10).** `TRUSTED_PROXIES=10.42.0.0/16` (zakres adresów podów k3s): Traefik łączy się z Gateway z adresu swojego poda, więc nazwa Service nie zadziała. Gateway bierze ostatni wpis `X-Forwarded-For` dopisany przez Traefika, więc nagłówek od klienta z zewnątrz nie zmienia wyniku. Zakres jest bezpieczny tylko razem z NetworkPolicy „do Gateway wchodzi tylko Traefik (i Consul na health check)” — bez niej każdy pod w `shop` mógłby wprost podać dowolny `X-Forwarded-For` i obejść limit logowań na adres. Drogę przez health checki Consula (Consul też łączy się z Gateway) zamyka pośrednik `consul-guard`: check może być tylko zwykłym `GET` na `/health/*` poda, który go rejestruje (sekcja „Pośrednik przed Consulem”). Przez `kubectl port-forward` liczy się adres połączenia (127.0.0.1 w podzie), nagłówek jest pomijany.

**Zmiana konfiguracji w KV** (`deploy/consul/config/<usługa>.yaml`): usługi czytają KV tylko przy starcie, więc po `bash deploy/k8s/up.sh infra` potrzebny jest restart, np. `kubectl --context rancher-desktop -n shop rollout restart deploy/api-gateway`. Po zmianie kodu: `bash deploy/k8s/up.sh platform --build`.

**Swagger Auth i User** — tylko przez `port-forward` (tabela „Porty na laptopie”), np. `kubectl --context rancher-desktop -n shop port-forward svc/auth-service 18081:8081` → http://127.0.0.1:18081/docs.

## Ingress i TLS

Jedynym wejściem z zewnątrz jest Traefik wbudowany w k3s (przestrzeń `kube-system`, wejścia `web` :80 i `websecure` :443). Plik `deploy/k8s/platform/ingress.yaml` (warstwa `platform`) zawiera:

| Obiekt | Wejście | Co robi |
|---|---|---|
| Ingress `shop` | `websecure` (HTTPS), host `shop.localhost`, certyfikat z Secretu `shop-tls` | `/api` i `/api/…` → Service `api-gateway:8080`, wszystko inne → Service `frontend:8080`; middleware `shop-hsts` |
| Ingress `shop-http` | `web` (HTTP), host `shop.localhost` | middleware `shop-https-redirect`: stałe przekierowanie na `https://` (Traefik odpowiada sam, backend nie jest wołany) |
| Middleware `shop-hsts` | – | nagłówek `Strict-Transport-Security: max-age=31536000` na każdej odpowiedzi HTTPS (frontend i Gateway); bez `includeSubDomains` i `preload` – sklep nie ma subdomen, a nazwy `.localhost` nie da się wpisać na listę preload |
| Middleware `shop-https-redirect` | – | `redirectScheme: https`, `permanent: true` (`301` dla GET/HEAD, `308` dla innych metod) |

Adres: **`https://shop.localhost`**. Nazwa `*.localhost` rozwiązuje się na 127.0.0.1 bez wpisu w `/etc/hosts` (przeglądarki, curl, Node 22). Inne hosty (np. `http://localhost/`) dostają `404` z Traefika.

### Certyfikat (mkcert)

`bash deploy/k8s/secrets.sh` (uruchamia go też `up.sh`) tworzy Secret `shop-tls` typu `kubernetes.io/tls` z plików:

```
deploy/secrets/tls/shop.localhost.pem       certyfikat
deploy/secrets/tls/shop.localhost-key.pem   klucz prywatny (0600, katalog 0700)
```

Gdy któregoś pliku brakuje, skrypt tworzy oba poleceniem `mkcert shop.localhost`; istniejące pliki są używane ponownie. Katalog `deploy/secrets/` jest w `.gitignore`. Bez `mkcert` skrypt kończy się kodem 1 i podpowiedzią `brew install mkcert && mkcert -install`. Lokalny urząd certyfikacji mkcert trzeba raz dodać do systemu i przeglądarek: `mkcert -install` (punkt 4 „Wymagań”); bez tego przeglądarka pokaże ostrzeżenie o certyfikacie.

Nowy certyfikat (np. po wygaśnięciu – mkcert wystawia go na ok. 2 lata i 3 miesiące):
```bash
rm deploy/secrets/tls/shop.localhost*.pem
bash deploy/k8s/secrets.sh
```
Traefik sam wczytuje zmieniony Secret (bez restartu).

Sprawdzenie z terminala (curl nie korzysta z pęku kluczy systemu – urząd mkcert podaje się jawnie):
```bash
CA="$(mkcert -CAROOT)/rootCA.pem"
curl -s -o /dev/null -w '%{http_code}\n' --cacert "$CA" https://shop.localhost/                 # 200
curl -s -D - -o /dev/null --cacert "$CA" https://shop.localhost/ | grep -i -E 'strict-transport|content-security'
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://shop.localhost/products       # 301 https://shop.localhost/products
```

### Nagłówki bezpieczeństwa

- `/` (frontend): `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy` – z nginx frontendu, jak w compose (`frontend/nginx/default.conf.template`); `Strict-Transport-Security` – z Traefika.
- `/api/…` (Gateway): nagłówki `helmet` z Gateway, bez zmian; `Strict-Transport-Security` – z Traefika.
- HSTS: przeglądarka przez rok łączy się z `shop.localhost` tylko przez HTTPS (także gdy wpisze się `http://`). Compose (`http://localhost:8090`) to inny host – HSTS go nie dotyczy.

### Frontend w Kubernetesie

- Ten sam obraz `frontend:dev` i te same zmienne co w compose, poza `GATEWAY_URL=http://api-gateway.shop.svc.cluster.local:8080` – `resolver` nginx nie używa domen wyszukiwania z `resolv.conf`, więc krótka nazwa `api-gateway` nie zadziała. Przez Ingress `/api` nie trafia do frontendu (Traefik kieruje je prosto do Gateway), ale szablon konfiguracji wymaga tej zmiennej.
- Frontend nie rejestruje się w Consulu. `preStop` 5 s (usługi w Consulu mają 10 s): Traefik usuwa pod z listy backendów chwilę po tym, jak przestaje on być gotowy; przez ten czas nginx dalej przyjmuje połączenia. nginx kończy pracę sygnałem `SIGQUIT` z obrazu (dokończenie otwartych żądań).
- Konfiguracja nginx w podzie: `kubectl --context rancher-desktop -n shop exec deploy/frontend -- cat /etc/nginx/conf.d/default.conf`.

## Usługi zespołu (warstwa `services`)

| Obiekt | Plik | Użytkownik | Co |
|---|---|---|---|
| Job `product-migrate` | `services/product-migrate.yaml` | `10001:10001` | `alembic upgrade head` na `product_db` (to samo polecenie co w compose); `up.sh services` usuwa go i tworzy od nowa, czeka na `Complete`, dopiero potem stawia obciążenia; znika 10 min po zakończeniu |
| Deployment + Service `cart-service:8085` | `services/cart-service.yaml` | `1000:1000` | `REDIS_URL` (z hasłem) z `cart-service-secret` |
| Deployment + Service `inventory-service:8084` | `services/inventory-service.yaml` | `10001:10001` | `DATABASE_URL` (z hasłem) i `RABBITMQ_PASSWORD` z `inventory-service-secret`; odbiorca zdarzeń wyłączony (brak `RABBITMQ_URL`, jak w compose) |
| Deployment + Service `review-service:8088` | `services/review-service.yaml` | `10001:10001` | `MONGODB_URL` (z hasłem) z `review-service-secret` |
| Deployment + Service `product-service:8083`, HPA | `services/product-service.yaml` | `10001:10001` | `DB_PASSWORD` z `product-service-secret`; HPA 1–3 |
| Deployment + Service `notification-service:8087` | `services/notification-service.yaml` | `10001:10001` | `DB_PASSWORD`, `RABBITMQ_PASSWORD` z `notification-service-secret` |

- Każda usługa ma 1 replikę, zmienne 1:1 z wpisu w `deploy/compose.yaml` i dodatkowo `SERVICE_ADDRESS` (adres poda, rejestrowany w Consulu). `INSTANCE_ID` (nazwa poda) mają Cart, Product i Notification — ich kod buduje bez niego ID `<usługa>-<hostname>`, a nazwa poda już zaczyna się od nazwy usługi (podwójny przedrostek); z `INSTANCE_ID` ID w Consulu i nagłówek `X-Instance-Id` to sama nazwa poda, np. `product-service-5c7889b54d-jnnj5`. Inventory i Review nie dostają `INSTANCE_ID` (decyzja 5): ich kod zawsze dokleja `<usługa>-` do ID, więc w Consulu mają `inventory-service-inventory-service-<…>` i `review-service-review-service-<…>` (z `INSTANCE_ID` byłoby tak samo); nagłówek `X-Instance-Id` to nazwa poda.
- **Kontener inicjujący `wait-for-network` (Z12, Z13).** Przy aktywnych NetworkPolicy nowy pod przez ok. 1–2 s po starcie nie może nawiązać połączeń (k3s dodaje adres poda do reguł z opóźnieniem). Cart, Product i Notification czytają konfigurację z Consul KV tylko przy starcie — bez czekania działałyby po cichu na wartościach domyślnych (w logu `Configuration from Consul KV not loaded, using defaults` albo `Consul KV unavailable; using local configuration`), a pierwsza próba Joba migracji kończyła się `Connection refused`. Dlatego każda usługa warstwy `services` i `user-service` ma kontener inicjujący, który w obrazie usługi (`python -c`) co 0,5 s próbuje połączenia TCP z `consul:8500`, a Joby migracji — z `postgres:5432` (Joby infrastruktury: sekcja „Konwencje platformy”); najwyżej 30 s, potem kod 1 (pod usługi restartuje się, Job robi kolejną próbę). Wypisuje czas oczekiwania: `k logs <pod> -c wait-for-network`. Ten sam `securityContext` co kontener główny, zasoby 10m/16Mi (requests) i 100m/64Mi (limits) — sam interpreter Pythona, kilka sekund.
- `runAsGroup: 10001` dla obrazów z `USER 10001`: Dockerfile nie podaje grupy (obrazy Inventory i Review mają grupę `999`, Product i Notification — `0`); pliki aplikacji są do odczytu dla wszystkich, więc grupa nie ma znaczenia, a `10001` unika grupy `root`.
- **`readOnlyRootFilesystem: true` we wszystkich pięciu usługach, ich kontenerach `wait-for-network` i w `product-migrate`, z `emptyDir` na `/tmp` — bez wyjątków** (sprawdzone w klastrze: wszystkie pody gotowe, 0 restartów, w logach 0 błędów zapisu). `kubectl apply --dry-run=server -f deploy/k8s/services/`: 0 ostrzeżeń Pod Security (`restricted`).
- Inventory i Review przy starcie zakładają schemat/indeksy w bazie, zanim serwer HTTP zacznie odpowiadać, więc mają czas do 120 s (`startupProbe`, jak każda usługa). Review bez MongoDB przy starcie kończy proces i pod restartuje się, aż baza odpowie; Inventory czeka na PostgreSQL bez limitu czasu. Obie rejestrują się w Consulu tylko raz, przy starcie: wpis usunięty z Consula (np. restart Consula z pustym wolumenem) wraca dopiero po restarcie poda (`k rollout restart deploy/inventory-service deploy/review-service`).

### Swagger usług zespołu (tylko `port-forward`)


Ingress wystawia tylko `/api` (Gateway) i frontend, więc dokumentacja OpenAPI usług nie jest dostępna z zewnątrz (`https://shop.localhost/docs` zwraca `200`, ale to aplikacja frontendu — nginx odpowiada `index.html` na każdą ścieżkę SPA; `/api/v1/products/docs` → `400` z Product, bo `docs` nie jest poprawnym identyfikatorem produktu):
```bash
k port-forward svc/product-service 18083:8083        # http://127.0.0.1:18083/docs
k port-forward svc/inventory-service 18084:8084      # http://127.0.0.1:18084/docs
k port-forward svc/cart-service 18085:8085           # http://127.0.0.1:18085/docs
k port-forward svc/notification-service 18087:8087   # http://127.0.0.1:18087/docs
k port-forward svc/review-service 18088:8088         # http://127.0.0.1:18088/docs
```

## Metryki (Prometheus i Grafana)

Warstwa `monitoring` (`bash deploy/k8s/up.sh monitoring`, także ostatnia część `all`): Prometheus co 15 s zbiera metryki, Grafana pokazuje panel „Sklep”, kube-state-metrics podaje stan obiektów przestrzeni `shop`. Grafanę i Prometheusa otwiera się tylko przez `kubectl port-forward` — z zewnątrz (Ingress) nie widać ani metryk, ani paneli. W compose monitoringu nie ma.

| Obiekt | Plik | Co |
|---|---|---|
| ServiceAccount, Service `prometheus:9090`, Deployment | `monitoring/prometheus.yaml` | 1 replika, `prom/prometheus:v3.15.1`, użytkownik `65534`; dane w `emptyDir` (do 1Gi), retencja 24 h albo 512 MB — historia znika razem z podem (restart, `up.sh` po zmianie konfiguracji); bez API administracyjnego (`--web.enable-admin-api`) i bez przeładowania konfiguracji przez HTTP (`--web.enable-lifecycle`) |
| Service `grafana:3000`, Deployment | `monitoring/grafana.yaml` | 1 replika, `grafana/grafana:13.3.1`, użytkownik `472`, konto `default` bez tokenu; baza w `emptyDir` |
| ServiceAccount, Role, RoleBinding, Service `kube-state-metrics:9180`, Deployment | `monitoring/kube-state-metrics.yaml` | stan Deploymentów, StatefulSetów, HPA i podów tylko z przestrzeni `shop` (rola `list`/`watch` w `shop`) |
| ClusterRole i ClusterRoleBinding `shop-prometheus-kubelet` | `cluster/prometheus-kubelet.yaml` | konto `shop/prometheus` może czytać metryki kubeleta (`get` na `nodes/metrics`); sekcja „Wyjątki” |

### Co zbieramy

Plik `deploy/monitoring/prometheus/prometheus.yml` (ConfigMapa `prometheus-config`). Nazwa zadania (`job`) jest etykietą, po której panel wybiera serie.

| `job` | Skąd | Co |
|---|---|---|
| `api-gateway` | każdy gotowy pod Gateway osobno, port 9080, `/metrics`; adresy podów z DNS usługi bez adresu `api-gateway-metrics` (odświeżane co 15 s) | ruch, kody odpowiedzi i czas na usługę, próby wysłania do instancji, instancje widziane przez Gateway, stan wyłączników, pamięć i CPU procesu (opis metryk: [services/api-gateway/README.md](../../services/api-gateway/README.md), sekcja „Metryki”) |
| `rabbitmq` | `rabbitmq:15692`, `/metrics` (wbudowana wtyczka `rabbitmq_prometheus`) | sumy brokera: wiadomości, połączenia, kanały, pamięć |
| `rabbitmq-queues` | `rabbitmq:15692`, `/metrics/detailed?family=queue_coarse_metrics&family=queue_consumer_count` | liczby na kolejkę (8 kolejek, w tym `*.dlq`): wiadomości gotowe i nieprzyjęte, odbiorcy |
| `kube-state-metrics` | `kube-state-metrics:9180`, `/metrics` | repliki Deploymentów i StatefulSetów (dostępne i oczekiwane), HPA, faza podów, restarty kontenerów |
| `kubelet` | kubelet węzła, port 10250, `/metrics/resource` (HTTPS; certyfikat sprawdzany urzędem z konta usługi, token konta `prometheus` z pliku w podzie) | CPU i pamięć węzła (`node_*`) oraz każdego kontenera i poda `shop`; serie podów z innych przestrzeni są odrzucane przy zbieraniu |
| `prometheus` | `localhost:9090` | sam Prometheus |

Metryki ruchu pochodzą tylko z Gateway: usługi zespołu i Auth nie wystawiają własnych metryk, ale przez Gateway przechodzi każde żądanie z zewnątrz, więc widać ruch i błędy wszystkich usług. Nowa usługa (np. Order i Shipping w etapie 8) pojawia się na panelu sama, gdy ma trasę w Gateway — lista usług nie jest nigdzie wpisana na sztywno.

Sprawdzenie celów (wszystkie `up`, liczba celów `api-gateway` = liczba podów Gateway):
```bash
kubectl --context rancher-desktop -n shop port-forward svc/prometheus 19090:9090 >/dev/null &
pf=$!; sleep 2
curl -s http://127.0.0.1:19090/api/v1/targets | jq -r '.data.activeTargets[] | "\(.labels.job) \(.health) \(.lastError)"' | sort | uniq -c
kill "$pf"
```

### Jak otworzyć

```bash
kubectl --context rancher-desktop -n shop port-forward svc/grafana 13000:3000       # Grafana
kubectl --context rancher-desktop -n shop port-forward svc/prometheus 19090:9090    # Prometheus
```
- **Grafana:** http://127.0.0.1:13000 — strona domowa to panel „Sklep”, bez logowania; ten sam panel pod http://127.0.0.1:13000/d/shop.
- **Prometheus:** http://127.0.0.1:19090 — zapytania PromQL (Query), cele (Status → Targets, http://127.0.0.1:19090/targets), bieżąca konfiguracja (http://127.0.0.1:19090/config). Prometheus nie ma logowania; tak jak Consul UI i panel Mailpit jest dostępny tylko z laptopa przez `port-forward`.

`port-forward` działa do Ctrl+C. Inne pody przestrzeni nie mają drogi do Grafany ani do Prometheusa (NetworkPolicy), a Ingress kieruje tylko do Gateway (8080) i frontendu.

### Logowanie admina

Bez logowania Grafana tylko pokazuje panele (rola `Viewer`): bez zapisywania, bez edycji źródła danych i bez Explore; zakładanie kont jest wyłączone. Konto administratora: login `admin`, hasło — zmienna `GRAFANA_ADMIN_PASSWORD` z `deploy/.env` (tak jak panel RabbitMQ). Zmienną dopisuje `bash deploy/create-secrets.sh`, a `secrets.sh` (uruchamia go `up.sh`) wkłada ją do Secretu `grafana-secret`. Logowanie: „Sign in” w Grafanie. Admin ma Explore i może układać panel w interfejsie; zmiana na stałe idzie przez repo (niżej).

Baza Grafany jest w `emptyDir`, więc każdy nowy pod zaczyna od pustej bazy: konta, ustawienia i zmiany zrobione w interfejsie znikają przy restarcie poda, a hasło admina jest zawsze to z Secretu. Zmiana hasła — nowa wartość w `deploy/.env`, potem:
```bash
bash deploy/k8s/secrets.sh && kubectl --context rancher-desktop -n shop rollout restart deploy/grafana
```
Sprawdzenie hasła bez wyświetlania go (hasło rozwija powłoka w podzie):
```bash
kubectl --context rancher-desktop -n shop exec deploy/grafana -- sh -c 'curl -s -o /dev/null -w "%{http_code}\n" -u "admin:$GF_SECURITY_ADMIN_PASSWORD" http://127.0.0.1:3000/api/admin/settings'   # 200
```
Złe hasło: `401` na `/api/user` i przy logowaniu; na `/api/admin/settings` jest `403`, bo Grafana z włączonym podglądem bez logowania traktuje takie żądanie jak anonima.

Grafana ma wyłączone wbudowane wtyczki źródeł danych poza Prometheusem (`GF_PLUGINS_DISABLE_PLUGINS`) i instalowanie wtyczek przy starcie (`GF_PLUGINS_PREINSTALL_DISABLED`): bez tego wersja 13.3.1 kopiuje przy każdym starcie ok. 170 MB wtyczek do katalogu danych i uruchamia proces dla każdej z nich (ok. 630 MiB pamięci zamiast ok. 210–240 MiB). Nie łączy się z internetem (sprawdzanie aktualizacji, statystyki, wiadomości i Gravatar wyłączone; NetworkPolicy i tak to blokuje). Logi idą na standardowe wyjście (`kubectl --context rancher-desktop -n shop logs deploy/grafana`).

### Zmiana panelu na stałe

Panel „Sklep” to plik `deploy/monitoring/grafana/dashboards/shop.json` (ConfigMapa `grafana-dashboards`). Dostawca paneli z `deploy/monitoring/grafana/dashboards.yaml` nie pozwala zapisać ani usunąć panelu w interfejsie. Zmiana na stałe:
1. Zalogowany admin zmienia panel w interfejsie (Edit), bez zapisywania.
2. Export → Export as JSON, bez opcji eksportu dla innej instancji (źródło danych zostaje `uid: prometheus`); skopiowany JSON zastępuje całą treść `shop.json`, `uid` zostaje `shop`.
3. `bash deploy/k8s/up.sh monitoring` — ConfigMapa `grafana-dashboards` jest `configured`, skrypt robi `rollout restart deploy/grafana`, a nowy pod (gotowy po ok. 10 s) pokazuje nowy panel.

Tak samo konfiguracja Prometheusa: zmiana w `deploy/monitoring/prometheus/prometheus.yml` + `bash deploy/k8s/up.sh monitoring` → nowy pod Prometheusa z nową konfiguracją (zebrane dane znikają, bo są w `emptyDir`). Bez zmian w plikach `up.sh monitoring` niczego nie restartuje (ConfigMapy `unchanged`).

### Co pokazuje panel

Panel „Sklep” (http://127.0.0.1:13000/d/shop) odświeża się co 10 s i domyślnie pokazuje ostatnie 30 minut w strefie czasowej przeglądarki. Lista „Usługa” u góry filtruje wiersz „Ruch przez Gateway” (domyślnie wszystkie usługi). Usługi biorą się z metryk Gateway (etykieta `service`), więc nowa usługa z trasą w Gateway pojawia się na liście i na wykresach sama. Wartość `none` to żądania bez trasy (np. ścieżka spoza `/api/v1`). Opis każdego wykresu jest pod ikoną „i” przy tytule.

| Wiersz | Panel | Jak czytać |
|---|---|---|
| Ruch przez Gateway | Żądania/s na usługę | wszystkie odpowiedzi Gateway na usługę (suma po replikach Gateway), także błędy samego Gateway (401, 429, 503) |
| | Błędy 5xx/s na usługę i kod | słupki według usługi i kodu: `503` — brak zdrowej instancji albo otwarty wyłącznik, `504` — usługa nie odpowiedziała w czasie, `502` — błąd połączenia, `500` — błąd w usłudze. Bez błędów napis „Brak odpowiedzi 5xx” |
| | Odsetek 5xx na usługę | udział odpowiedzi 5xx w odpowiedziach usługi; `0 %` — bez błędów serwera, `100 %` — usługa niedostępna. Usługa bez ruchu w ostatniej minucie nie ma wartości. Oś do 5 %, przy większych wartościach rośnie sama |
| | Błędy 4xx/s według kodu | `401` brak albo zły token, `403` brak roli, `404` brak trasy albo zasobu, `429` limit żądań Gateway (cały ruch z laptopa ma jeden adres — sekcja „Wyjątki”) |
| | Czas odpowiedzi p50 i p95 | czas od przyjęcia żądania przez Gateway do końca odpowiedzi; p95 = 95 % żądań było szybszych. Liczony z histogramu (kubełki od 5 ms do 10 s), więc to przybliżenie |
| | Stan wyłączników (circuit breaker) | pasek na usługę: zielony „zamknięty” (ruch idzie do usługi), czerwony „otwarty” (Gateway od razu odpowiada `503` przez 30 s), pomarańczowy „półotwarty” (czeka na jedno żądanie próbne). Najgorszy stan wśród replik Gateway. Usługa pojawia się po pierwszym żądaniu do niej |
| | Instancje widziane przez Gateway | liczba zdrowych instancji usługi na liście Gateway (z Consula); `0` = Gateway odpowiada `503`. Przy skalowaniu (HPA) rośnie razem z liczbą podów |
| | Rozkład żądań na instancje usług | próby wysłania żądania do każdego poda usługi; przy kilku replikach widać podział ruchu (load balancing w Gateway) |
| | Żądania od startu Gateway | liczba odpowiedzi Gateway na usługę od startu podów Gateway; pokazuje każde żądanie, także pierwsze (wykresy „/s” go nie widzą — akapit pod tabelą); zeruje się przy restarcie poda Gateway |
| Zasoby | Pamięć podów, CPU podów (rdzenie) | każdy pod `shop` według kubeleta; tabela obok wykresu sortuje pody od największej bieżącej wartości |
| | Pamięć węzła | pamięć robocza maszyny wirtualnej Rancher Desktop i suma podów sklepu |
| | Repliki HPA | aktualna i docelowa liczba replik według autoskalera (`api-gateway` 2–3, `product-service` 1–3) |
| | Repliki Gateway zbierane | ile replik Gateway Prometheus właśnie zbiera (`up{job="api-gateway"} == 1`); zielone przy 2 i więcej |
| | Repliki wdrożeń: dostępne i oczekiwane | tabela Deploymentów; kolumna „Brakuje” > 0 na czerwono — pody nie wstały albo usługa jest zatrzymana |
| | Restarty kontenerów | restarty od utworzenia poda; wartość > 0 na pomarańczowo |
| Zdarzenia (RabbitMQ) | Wiadomości w kolejkach | wiadomości gotowe (czekają na odbiorcę) i niepotwierdzone (pobrane, w przetwarzaniu) w każdej kolejce poza `*.dlq`. Zwykle `0` — odbiorca przetwarza zdarzenie od razu |
| | Wiadomości w DLQ | osobny kafelek na każdą kolejkę `*.dlq`: zielone `0`, **czerwone, gdy jest co najmniej 1 wiadomość** — zdarzenie, którego odbiorca nie przetworzył po 3 próbach (sprawdzić w panelu RabbitMQ, sekcja „Porty na laptopie”) |
| | Odbiorcy na kolejkę | podłączeni odbiorcy; `notification.q` ma 1 (2 przy pokazie „Dwie kopie Notification”), kolejki DLQ i kolejki usług z etapu 8 — 0 |
| | Przepływ wiadomości/s | cały broker: przyjęte od nadawców, dostarczone odbiorcom, potwierdzone (ack) |
| | Pamięć brokera | pamięć procesu RabbitMQ i próg, po którym broker wstrzymuje nadawców |
| Zbieranie | Działające cele na zadanie, Cele Prometheusa | liczba celów z udanym ostatnim pobraniem na zadanie (`api-gateway` = liczba replik Gateway, reszta 1) i każdy cel osobno („działa”/„nie działa”). Czerwone `0` = brak danych z tego źródła — szczegóły w Prometheusie, Status → Targets |

Wykresy z `rate()` (żądania/s, błędy, czas, przepływ wiadomości) potrzebują dwóch pobrań metryk, czyli ok. 30 s danych: zaraz po starcie Prometheusa są puste. Ruch, który tworzy nową serię (pierwsze żądanie danej usługi z daną metodą i kodem na danej replice Gateway), nie jest widoczny w `rate()` i `increase()` — seria zaczyna się od wartości, która już zawiera te żądania; widać dopiero kolejne. Usługa z jednym żądaniem na przebieg (np. Auth, Inventory, Review) może się więc nie pojawić na wykresach „/s” nawet po kilku przebiegach (2 repliki Gateway — każdy przebieg może trafić w nową serię drugiej repliki); każde żądanie, także pierwsze, widać na panelu „Żądania od startu Gateway”. Prometheus trzyma dane w `emptyDir`, więc każdy nowy pod Prometheusa (np. po `up.sh monitoring` ze zmianą `prometheus.yml`) zaczyna od pustej historii.

### Pokazy na panelu

Polecenia z funkcjami `k` i `api` z sekcji „Pokazy” i z otwartym panelem (port-forward Grafany i Prometheusa — „Jak otworzyć”). Przed pokazami przez Ingress wyzerować limity Gateway (`FLUSHALL` z „Pokazów”), inaczej część żądań dostanie `429`, i puścić jeden przebieg rozgrzewający `bash postman/run.sh k8s` (tworzy serie metryk — akapit wyżej), a pokazy zacząć ≥ 30 s po nim. Ruch scenariusza najpewniej widać na panelu „Żądania od startu Gateway”. Każdy pokaz kończy się przywróceniem stanu.

**Ruch scenariusza zakupu.** `bash postman/run.sh k8s` (ok. 45 żądań w kilka sekund). Po 15–30 s na „Żądania/s na usługę” są skoki dla Auth, User, Product, Cart, Inventory, Review i Order (do etapu 8 Order to jedno żądanie z odpowiedzią `404`, a kroki Order i Shipping są pomijane), na „Błędy 4xx/s” — `400`, `401`, `403`, `404`, `409` z kroków, które sprawdzają odmowy, na „Rozkład żądań na instancje” — nazwy podów, a w wierszu RabbitMQ — przepływ po rejestracji (zdarzenie `user.registered`). Zmierzone (etap 9b): po jednym przebiegu na panelu „Żądania od startu Gateway” 7 usług; na wykresach „/s” zaraz po starcie Gateway tylko usługi z kilkoma żądaniami na przebieg (Cart, User, Product), na klastrze po kilku przebiegach — wszystkie 7. Wyraźniejsze wykresy dają 2 przebiegi w odstępie ok. 30 s; trzeci w tej samej minucie dostaje `429` na logowaniu (limit 5 logowań na minutę — „Problemy”) i widać go na „Błędy 4xx/s” jako `429`.

**Zatrzymana usługa → `503` w ciągu minuty.** Review do zera replik, pętla publicznego `GET /reviews` przez Ingress, powrót:
```bash
k scale deploy/review-service --replicas=0
for i in $(seq 90); do echo "$(date +%T) $(api '/reviews?productId=9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' -o /dev/null -w '%{http_code}')"; sleep 1; done
k scale deploy/review-service --replicas=1 && k rollout status deploy/review-service
```
Pętla wypisuje `503` po kilku sekundach (Gateway odświeża listę instancji z Consula). Na panelu: „Instancje widziane przez Gateway” dla `review-service` spada do `0`, „Błędy 5xx/s” pokazują słupki `review-service 503`, „Odsetek 5xx” dochodzi do 100 %, w tabeli „Repliki wdrożeń” `review-service` ma `0`/`0`. Wyłącznik zostaje zamknięty — brak instancji nie liczy się jako awaria (sekcja „Circuit breaker” w README Gateway). Zmierzone: pierwsze `503` po 10 s od `scale`, pierwsza wartość > 0 na wykresie 5xx po kolejnych 20 s, instancje `0` po 25 s. Po `scale … --replicas=1` Review rejestruje się w Consulu przy starcie: po ok. 7 s pętla dostaje znowu odpowiedź usługi (nie `503`), instancje wracają do `1`. Gdy po powrocie Gateway dalej odpowiada `503` — wiersz „Inventory albo Review nie ma w Consulu” w „Problemach”.

**Otwarty wyłącznik.** Zamrożenie kontenera Review (`docker pause` — proces stoi, połączenia się nawiązują, odpowiedzi nie ma), 24 równoległe żądania, odmrożenie:
```bash
cid=$(docker --context rancher-desktop ps -q --filter name=k8s_review-service_review-service)
docker --context rancher-desktop pause "$cid"
for i in $(seq 24); do api '/reviews?productId=9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' -o /dev/null -w '%{http_code}\n' & done; wait
docker --context rancher-desktop unpause "$cid"
# żądanie próbne co 3 s: przez 30 s Gateway od razu odpowiada 503, potem próba zamyka wyłącznik
for i in $(seq 25); do api '/reviews?productId=9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' -o /dev/null -w '%{http_code}\n'; sleep 3; done
```
`unpause` od razu po żądaniach: kontener zamrożony dłużej niż ok. 30 s zrestartuje sonda liveness. Każde z 24 żądań kończy się `504` po ok. 10 s (czas na odpowiedź w Gateway). 24, bo każda z 2 replik Gateway ma własny wyłącznik i dostaje ok. połowę żądań, a wyłącznik otwiera się dopiero od 10 żądań. Na panelu: „Stan wyłączników” — czerwony pasek „otwarty” przy `review-service`, „Błędy 5xx/s” — słupki `504`, potem `503` (żądania odrzucone przy otwartym wyłączniku); po 30 s pomarańczowy „półotwarty”, po udanym żądaniu próbnym znowu zielony. Zmierzone: 24 × `504` po 10,5 s każde; stan `otwarty` w Prometheusie 8 s po ostatniej odpowiedzi (Grafana pokazuje go przy następnym odświeżeniu, do 10 s później); Gateway odpowiadał `503` przez 30 s, pierwsze żądanie po 30 s dostało znowu odpowiedź usługi, stan `zamknięty` 43 s po `unpause`. Stanu `półotwarty` przy żądaniach co 3 s zwykle nie widać — trwa krócej niż odstęp zbierania (15 s). Kolumna „Restarty” Review bez zmian.

**HPA Product.** Obciążenie jak w „Pokazach” (bezpośrednio do Product przez `port-forward`, 20 pętli przez 90 s). Gateway odświeża listę instancji przy żądaniach do usługi, więc w drugim terminalu lekki ruch przez Ingress na czas pokazu: `for i in $(seq 150); do api /products -o /dev/null; sleep 2; done`. Na panelu: „Repliki HPA” — `product-service aktualne` rośnie do 2–3, „CPU podów” — skok poda Product, „Instancje widziane przez Gateway” i „Rozkład żądań na instancje” — nowe pody Product; po zakończeniu obciążenia wszystko wraca do 1. Zmierzone: 3 gotowe pody Product po ok. 30 s obciążenia, na panelu (HPA i instancje = 3) po ok. 40 s; po końcu obciążenia 1 pod po ok. 80 s, instancje Gateway `1` po ok. 100 s. Przy zejściu o kilka podów naraz (np. 3 → 1) Gateway ma jeszcze przez kilka sekund na liście kończące się pody: wyrejestrowują się z Consula dopiero po SIGTERM, a lista jest trzymana do 10 s. Przy braku połączenia Gateway próbuje więc kolejnych instancji, każdej najwyżej raz, razem do 3 prób ([README Gateway](../../services/api-gateway/README.md#przebieg-żądania), tabela pod „Gdy usługa nie odpowiada”). Dzięki temu lekki ruch przez Ingress nie dostaje w czasie pokazu `502` (decyzja Michała M2 etapu 9b → A; wcześniej, przy jednym ponowieniu, zdarzały się pojedyncze `502`; zmierzone po zmianie: 2 przebiegi 3 → 1 pod ruchem, 504 żądania, 0 × `502`, w tym jedno żądanie, w którym dwa kończące się pody odmówiły połączenia, a trzecia próba trafiła w żywy pod).

**Wiadomość w DLQ.** Wiadomość testowa do `notification.dlq` kontem admina RabbitMQ (hasło rozwija powłoka w podzie, nie pojawia się w poleceniu ani na ekranie), potem opróżnienie kolejki:
```bash
k exec rabbitmq-0 -- sh -c 'RABBITMQADMIN_USERNAME="$RABBITMQ_DEFAULT_USER" RABBITMQADMIN_PASSWORD="$RABBITMQ_DEFAULT_PASS" rabbitmqadmin --non-interactive publish message --routing-key notification.dlq --payload "test"'
k exec rabbitmq-0 -- rabbitmqctl purge_queue notification.dlq
```
Na panelu kafelek `notification.dlq` w „Wiadomości w DLQ” zmienia się na czerwone `1`, po `purge_queue` wraca do zielonego `0`. Zmierzone: czerwone `1` po 11 s od wysłania wiadomości, zielone `0` po 15 s od `purge_queue` (zbieranie co 15 s + odświeżanie panelu co 10 s).

## NetworkPolicy

Usługi ufają nagłówkom `X-User-Id` i `X-User-Roles` tylko dlatego, że do usług nie ma innej drogi niż przez Gateway. W klastrze pilnują tego reguły NetworkPolicy w `deploy/k8s/network/`: domyślnie każde połączenie w przestrzeni `shop` jest zablokowane (do podów i z podów), a otwarte są tylko połączenia z tabeli niżej. k3s egzekwuje reguły kontrolerem kube-router: zablokowane połączenie jest od razu odrzucane (`connection refused`), nie czeka do limitu czasu.

| Plik | Co zawiera |
|---|---|
| `default-deny.yaml` | `default-deny`: wszystkie pody `shop` (`podSelector: {}`), `Ingress` i `Egress` bez reguł = nic nie wchodzi i nic nie wychodzi |
| `dns.yaml` | `allow-dns`: wszystkie pody → CoreDNS (`kube-system`, `k8s-app: kube-dns`) 53/UDP i 53/TCP |
| `infra.yaml` | Consul (serwer i `consul-guard`), PostgreSQL, MongoDB, oba Redisy, RabbitMQ, Mailpit oraz Joby `consul-kv-seed` i `rabbitmq-setup` |
| `platform.yaml` | Gateway, frontend, Auth, User oraz Joby `auth-migrate` i `user-migrate` |
| `services.yaml` | Cart, Product (+ Job `product-migrate`), Inventory, Review, Notification oraz Order i Shipping (przygotowane na etap 8) |
| `monitoring.yaml` | Prometheus, Grafana, kube-state-metrics |
| `node-access.yaml.tpl` | szablon, nie manifest (`kubectl apply -f network/` go pomija): `prometheus-node` i `kube-state-metrics-api` — po jednej regule wyjścia `ipBlock` do kubeleta węzła i do API Kubernetesa; adresy wstawia `up.sh` przy każdym uruchomieniu (sekcja „Wyjątki”) |

Zasady zapisu:
- **Jedna NetworkPolicy na pod**, nazwana jak jego etykieta `app.kubernetes.io/name` (`k get netpol cart-service`). Wybiera pody po tej etykiecie — także pody Jobów. Wyjątek: dwie polityki z szablonu `node-access.yaml.tpl` dodają podom `prometheus` i `kube-state-metrics` po jednej regule wyjścia (sekcja „Wyjątki”).
- Reguły się sumują. Połączenie A → B działa tylko wtedy, gdy **i** reguła wyjścia A pozwala na B (port), **i** reguła wejścia B pozwala na A. Dlatego każde połączenie z tabeli jest zapisane dwa razy: w polityce wołającego (`egress`) i wołanego (`ingress`), z komentarzem „kto → kto i po co”.
- Reguły wybierają **pody**, nie adresy Service: usługi wołają się po adresie poda z Consula. Połączenie przez nazwę Service (np. `consul:8500` → pod `consul-guard`) też przechodzi, bo reguła sprawdza adres docelowego poda.
- Gateway i frontend przyjmują ruch z zewnątrz tylko od Traefika: w jednym elemencie `from` jest `namespaceSelector` (`kubernetes.io/metadata.name: kube-system`) **i** `podSelector` (`app.kubernetes.io/name: traefik`) — oba warunki naraz. Gateway ufa `X-Forwarded-For` od całego zakresu podów (`TRUSTED_PROXIES=10.42.0.0/16`, decyzja 10), więc ta reguła blokuje bezpośrednie żądania innych podów z fałszywym adresem klienta. Drogę pośrednią przez health check w Consulu (Consul też łączy się z Gateway) zamyka pośrednik `consul-guard` — sekcja „Pośrednik przed Consulem”. Prometheus dochodzi do Gateway tylko na port metryk 9080 (osobny serwer, tylko `GET /metrics`), do API na 8080 nie.
- Nic poza tabelą: żadnego wyjścia do internetu (Consul ma dlatego `CHECKPOINT_DISABLE=1`, Grafana wyłączone sprawdzanie aktualizacji). Reguły `ipBlock` są tylko dwie, z szablonu `node-access.yaml.tpl`: Prometheus → kubelet węzła (10250) i kube-state-metrics → API Kubernetesa. Żaden inny pod nie ma drogi do API ani do węzła (poza chwilą tuż po starcie nowego poda — sekcja „Wyjątki”).

### Tabela połączeń

Porty usług: Gateway 8080, Auth 8081, User 8082, Product 8083, Inventory 8084, Cart 8085, Order 8086, Notification 8087, Review 8088, Shipping 8089.

| Pod (cel) | Wejście dozwolone od (port poda) | Wyjście dozwolone do |
|---|---|---|
| wszystkie | — | DNS: `kube-system`, `k8s-app: kube-dns`, 53/UDP i 53/TCP |
| `api-gateway` | Traefik (`kube-system`), `consul` — 8080; `prometheus` — 9080 (metryki) | `consul` 8500, `redis-gateway` 6379, `auth-service` 8081 (JWKS i trasy `/auth`), wszystkie usługi 8082–8089 |
| `frontend` | Traefik (`kube-system`) — 8080 | — |
| `auth-service` | `api-gateway`, `consul` — 8081 | `postgres` 5432, `rabbitmq` 5672, `consul` 8500, `user-service` 8082 |
| `user-service` | `api-gateway`, `auth-service`, `notification-service`, `consul` — 8082 | `postgres` 5432, `consul` 8500 |
| `cart-service` | `api-gateway`, `order-service`, `consul` — 8085 | `redis-cart` 6379, `consul` 8500, `product-service` 8083, `inventory-service` 8084 |
| `product-service` | `api-gateway`, `cart-service`, `order-service`, `consul` — 8083 | `postgres` 5432, `consul` 8500, `review-service` 8088, `inventory-service` 8084 |
| `inventory-service` | `api-gateway`, `product-service`, `cart-service`, `order-service`, `consul` — 8084 | `postgres` 5432, `rabbitmq` 5672, `consul` 8500 |
| `review-service` | `api-gateway`, `product-service`, `consul` — 8088 | `mongo` 27017, `consul` 8500, `order-service` 8086 |
| `notification-service` | `api-gateway`, `consul` — 8087 | `mongo` 27017, `rabbitmq` 5672, `mailpit` 1025, `consul` 8500, `user-service` 8082 |
| `order-service` (etap 8) | `api-gateway`, `review-service`, `consul` — 8086 | `postgres` 5432, `rabbitmq` 5672, `consul` 8500, `cart-service` 8085, `inventory-service` 8084, `shipping-service` 8089, `product-service` 8083 |
| `shipping-service` (etap 8) | `api-gateway`, `order-service`, `consul` — 8089 | `postgres` 5432, `rabbitmq` 5672, `consul` 8500 |
| `consul-guard` (Service `consul`) | każdy pod z etykietą `app.kubernetes.io/part-of: shop` — 8500 | `consul` 8500 |
| `consul` (serwer, Service `consul-server`) | `consul-guard`, Job `consul-kv-seed` — 8500 | każda usługa na swoim porcie 8080–8089 (health check HTTP na adres poda; pośrednik dopuszcza tylko `GET` na `/health/*` rejestrującego poda) |
| `postgres` | usługi z bazą w PostgreSQL (Auth, User, Product, Inventory, Order, Shipping) i Joby migracji — 5432 | — |
| `mongo` | `review-service`, `notification-service` — 27017 | — |
| `redis-gateway` / `redis-cart` | `api-gateway` / `cart-service` — 6379 | — |
| `rabbitmq` | `auth-service`, `notification-service`, `inventory-service`, `order-service`, `shipping-service` — 5672; Job `rabbitmq-setup` — 15672; `prometheus` — 15692 (metryki) | — |
| `mailpit` | `notification-service` — 1025 | — |
| Joby `consul-kv-seed` / `rabbitmq-setup` | — | `consul` (serwer) 8500 / `rabbitmq` 15672 |
| Joby `auth-migrate`, `user-migrate`, `product-migrate` (oraz `order-migrate`, `shipping-migrate` — etap 8) | — | `postgres` 5432 |
| `prometheus` | `grafana` — 9090 | `api-gateway` 9080, `rabbitmq` 15692, `kube-state-metrics` 9180; kubelet węzła 10250 (`ipBlock`, szablon) |
| `grafana` | — (tylko `port-forward` z węzła) | `prometheus` 9090 |
| `kube-state-metrics` | `prometheus` — 9180 | API Kubernetesa: adres i port z EndpointSlice usługi `kubernetes` (`ipBlock`, szablon) |

- **Order i Shipping** mają reguły z góry (pody powstaną w etapie 8). Joby `order-migrate` i `shipping-migrate` są w regułach według konwencji nazw `<usługa>-migrate`; jeśli etap 8 nie użyje Jobów migracji (np. migracja przy starcie usługi), te dwie polityki i wpisy w `postgres` można usunąć.
- Inventory ma wyjście do RabbitMQ, choć jego odbiorca zdarzeń jest dziś wyłączony (decyzja 17) — reguła odpowiada tabeli połączeń architektury.
- Panel RabbitMQ (15672), interfejs Mailpit (8025), Consul UI, Swagger usług, Grafana (3000) i Prometheus (9090) działają tylko przez `kubectl port-forward` — ruch z węzła (niżej), reguły go nie blokują.
- **Zmiana tabeli połączeń** (nowa ścieżka między usługami) to decyzja Michała: nowa usługa albo nowe wywołanie = dopisanie reguły wyjścia u wołającego i wejścia u wołanego w tym samym pliku, z komentarzem.
- `up.sh` stosuje `network/` (i szablon z adresami) **przed** warstwami, więc przy starcie od zera Joby i pody od początku działają pod regułami (DNS i reguły Jobów muszą być w katalogu od pierwszego uruchomienia). `down.sh` usuwa wszystkie NetworkPolicy z `shop`.

### Opóźnienie reguł dla nowego poda (Z12, Z13)

kube-router dopisuje adres nowego poda do reguł dopiero po tym, jak pod dostanie adres i kontroler przeliczy reguły. Przez tę chwilę reguła wejścia celu (np. `consul-guard`, `postgres`) jeszcze nie zna nowego adresu i `default-deny` od razu odrzuca połączenie (`connection refused`). Zmierzone w tym klastrze: pierwsze udane połączenie z `consul:8500` po 0,1–0,45 s od startu interpretera Pythona i najpóźniej ok. 1,2 s od startu kontenera; tyle samo przy 4 i przy 27 regułach (czas nie zależy od liczby reguł). Bez zabezpieczenia skutki były takie: Job `consul-kv-seed` przegrywał każdą próbę (`restartPolicy: Never` — każda próba to nowy pod z nowym adresem, a klient `consul` łączy się w pierwszych milisekundach), a Cart, Product i Notification, które czytają konfigurację z Consul KV tylko przy starcie, po cichu działały na wartościach domyślnych. Dlatego każde obciążenie, które przy starcie łączy się z Consulem, i każdy Job mają initContainer `wait-for-network` (w obrazie usługi albo Joba, bez nowego obrazu): co 0,5 s próbuje połączenia TCP ze swoim celem (`consul:8500`, `rabbitmq:15672`, `postgres:5432`), najwyżej 30 s, potem kończy się błędem (restart poda albo kolejna próba Joba widoczne w zdarzeniach). initContainer ma ten sam adres co główny kontener, więc gdy kończy pracę, reguły już obejmują pod.

### Jak pokazać odmowę na żywo

Dozwolone i zabronione połączenie z prawdziwego poda (python3 w podzie; w Gateway, Auth i frontendzie `nc`):
```bash
k exec deploy/cart-service -- python3 -c "import socket; socket.create_connection(('product-service', 8083), 3); print('OPEN')"
k exec deploy/cart-service -- python3 -c "import socket; socket.create_connection(('user-service', 8082), 3); print('OPEN')"
# drugie: ConnectionRefusedError od razu – Cart nie ma prawa łączyć się z User
k exec deploy/frontend -- nc -z -w 3 api-gateway 8080; echo "exit=$?"   # 1: frontend nie łączy się z Gateway
gw=$(k get pods -l app.kubernetes.io/name=api-gateway -o jsonpath='{.items[0].status.podIP}')
k exec deploy/prometheus -- nc -z -w 3 "$gw" 9080; echo "exit=$?"   # 0: Prometheus pobiera metryki Gateway
k exec deploy/prometheus -- nc -z -w 3 "$gw" 8080; echo "exit=$?"   # 1: do API Gateway Prometheus nie ma drogi
```
Odmowa przychodzi od razu (Python: `ConnectionRefusedError` w czasie poniżej 1 ms); `nc` z BusyBox po odmowie kończy się dopiero po ok. 1 s — to zachowanie programu, nie reguł.

Pod bez etykiet sklepu (np. ktoś uruchomił pod w `shop`) nie łączy się z niczym poza DNS:
```bash
k run e7-probe --image=alpine:3.22 --image-pull-policy=Never --restart=Never \
  --overrides='{"spec":{"automountServiceAccountToken":false,"securityContext":{"runAsNonRoot":true,"runAsUser":65534,"seccompProfile":{"type":"RuntimeDefault"}},"containers":[{"name":"p","image":"alpine:3.22","imagePullPolicy":"Never","command":["sleep","300"],"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}}}]}}'
k wait --for=condition=Ready pod/e7-probe
k exec e7-probe -- sh -c 'nc -z -w 3 postgres 5432; echo "postgres exit=$?"; nslookup consul'   # exit=1 od razu, DNS odpowiada
k delete pod e7-probe
```

Lista reguł i to, które pody wybierają: `k get netpol`, `k describe netpol <nazwa>`.

Przez Ingress sklep działa jak wcześniej (`curl --cacert "$(mkcert -CAROOT)/rootCA.pem" https://shop.localhost/api/v1/products` → 200), a w Consulu nie ma niezdanych health checków: `k exec consul-0 -- curl -s http://127.0.0.1:8500/v1/health/state/critical` → `[]`.

Wyjątek węzła (ruch z maszyny wirtualnej przechodzi mimo reguł) — sekcja „Wyjątki”.

## Wyjątki

- **Brak stron błędów D7 z Traefika (decyzja 14 etapu 7).** Middleware `errors` Traefika podmienia każdą odpowiedź o danym kodzie, także poprawne 502/503/504 samego Gateway (z `requestId`, `X-Request-Id`, `Retry-After`), więc nie jest używany. Gdy żadna replika Gateway nie jest gotowa, Traefik odpowiada zwykłym tekstem `503` („no available server”), a przy nagłym końcu procesu Gateway (awaria, bez `preStop`) żądania w toku do tej repliki mogą dostać `502` („Bad Gateway”, bez `Content-Type`) — w teście 2 z 192 żądań; zwykłe wdrożenie i usunięcie poda (także `--force`) dają 0×502; frontend pokazuje wtedy komunikat według kodu statusu. Ryzyko ograniczają 2 repliki Gateway, PodDisruptionBudget i `preStop`. Odpowiedź `503` Traefika ma treść `no available server` (`text/plain`), bez `X-Request-Id` i bez nagłówków `helmet` (ślad tylko w logu Traefika w `kube-system`); ten sam tekst pojawia się chwilę po starcie, zanim pierwsza replika Gateway jest gotowa.
- **Sklep osiągalny z sieci lokalnej (decyzja 19, Z32).** Rancher Desktop na macOS wystawia porty 80 i 443 Traefika na wszystkich adresach laptopa (`lsof -nP -iTCP:443 -sTCP:LISTEN` → `*:443`); ustawienia „tylko localhost” na macOS nie ma (`kubernetes.ingress.localhostOnly` działa tylko na Windows — tam można je włączyć). Przeglądarka na innym urządzeniu sklepu nie otworzy: adres laptopa bez nazwy hosta daje `404` z Traefika, a nazwy `.localhost` zawsze wskazują na własne urządzenie. Celowe żądanie z nagłówkiem `Host: shop.localhost` z tej samej sieci dociera jednak do sklepu (`curl --resolve shop.localhost:443:<adres laptopa> …` → `200`), więc pracuj w zaufanej sieci; limity „na adres” są wspólne dla wszystkich klientów z zewnątrz (następny punkt). Rancher Desktop wystawia też API Kubernetesa (6443) i kubelet (10250) — oba bez certyfikatu klienta odpowiadają `401`.
- **Jeden adres klienta dla całego ruchu z zewnątrz.** ServiceLB k3s (klipper-lb) zamienia adres źródłowy żądania na adres swojego poda, więc Gateway widzi wszystkich klientów pod jednym adresem (`clientIp` w logach Gateway zawsze ten sam). Limity „na adres” (np. liczba logowań na minutę) są wspólne dla wszystkich klientów — na laptopie z jednym użytkownikiem bez znaczenia; przed pokazami z wieloma logowaniami limity można wyzerować poleceniem z sekcji „Pokazy”.
- **Węzeł jest granicą zaufania (decyzja 20).** k3s zawsze przepuszcza ruch z węzła do podów (bez tego nie działałyby sondy kubeleta i `port-forward`). Z sieci maszyny wirtualnej (`docker run --network host`) można więc wejść do poda z pominięciem Ingressu mimo NetworkPolicy. Kontener Dockera w zwykłej sieci i inne pody są blokowane. Dostęp do węzła = administrator laptopa. Sprawdzenie:

  ```bash
  ip=$(k get pods -l app.kubernetes.io/name=api-gateway -o jsonpath='{.items[0].status.podIP}')
  docker run --rm alpine:3.22 nc -z -w 3 "$ip" 8080; echo "exit=$?"                   # 1: zablokowane
  docker run --rm --network host alpine:3.22 nc -z -w 3 "$ip" 8080; echo "exit=$?"    # 0: węzeł przechodzi
  ```

- **Dwie reguły `ipBlock` (etap 9b, decyzja 13).** Kubelet węzła i API Kubernetesa nie są podami, więc reguła z `podSelector` ich nie wskaże. Dlatego szablon `network/node-access.yaml.tpl` zawiera dwie polityki tylko z wyjściem, każda z jedną regułą `ipBlock` `/32`: `prometheus-node` (pody `prometheus` → adres węzła, TCP 10250 — CPU i pamięć podów z kubeleta) i `kube-state-metrics-api` (pody `kube-state-metrics` → adres i port API). To także jedyny wyjątek od „jedna NetworkPolicy na pod”: wejście i pozostałe wyjścia tych podów są w `network/monitoring.yaml`, a polityki z szablonu tylko dodają po jednej regule. Adresów nie ma w repo — `up.sh` (krok `network`) wylicza je przy każdym uruchomieniu i podstawia w szablonie (`sed` na wyjście, bez zmiany pliku):
  ```bash
  # węzeł: InternalIP jedynego węzła (więcej węzłów = błąd up.sh)
  kubectl --context rancher-desktop get nodes -o jsonpath='{.items[*].status.addresses[?(@.type=="InternalIP")].address}'
  # API: adres i port z EndpointSlice usługi kubernetes
  kubectl --context rancher-desktop -n default get endpointslices -l kubernetes.io/service-name=kubernetes \
    -o jsonpath='{.items[0].endpoints[0].addresses[0]} {.items[0].ports[0].port}'
  # porównanie z regułami w klastrze
  kubectl --context rancher-desktop -n shop get netpol prometheus-node kube-state-metrics-api \
    -o jsonpath='{range .items[*]}{.metadata.name} {.spec.egress[0].to[0].ipBlock.cidr} {.spec.egress[0].ports[0].port}{"\n"}{end}'
  ```
  Dziś to dwa różne adresy (węzeł np. `192.168.5.15`, API np. `192.168.64.3:6443`). kube-state-metrics łączy się z API przez adres Service `kubernetes` (zmienna `KUBERNETES_SERVICE_HOST`, port 443); k3s zamienia go na adres z EndpointSlice, zanim zadziała reguła, więc reguła wskazuje adres końcowy, a nie adres Service. Adres API może się zmienić po restarcie maszyny wirtualnej Rancher Desktop — wtedy `bash deploy/k8s/up.sh monitoring` (sekcja „Problemy”). Sprawdzone: Prometheus → węzeł:10250 dochodzi, → API i → węzeł:22 — odmowa; kube-state-metrics → API dochodzi, → węzeł:10250 i → `api-gateway:8080` — odmowa.
- **Tokeny kont usług tylko w `prometheus` i `kube-state-metrics` (decyzja 14).** Wszystkie inne pody mają `automountServiceAccountToken: false` i konto `default` bez uprawnień. Te dwa mają własne konta (`ServiceAccount` `prometheus` w `monitoring/prometheus.yaml`, `kube-state-metrics` w `monitoring/kube-state-metrics.yaml`) z tokenem montowanym w `/var/run/secrets/kubernetes.io/serviceaccount/`: Prometheus wysyła go do kubeleta (`credentials_file`, nigdy w konfiguracji) i sprawdza certyfikat kubeleta urzędem z tego samego katalogu (`ca.crt`, bez `insecure_skip_verify`), a kube-state-metrics czyta nim API. Uprawnienia:
  - `kube-state-metrics` — `Role` tylko w `shop`: `list` i `watch` na `pods`, `deployments`, `statefulsets`, `horizontalpodautoscalers`; bez Secretów, ConfigMap i innych przestrzeni (bez ClusterRole);
  - `prometheus` — tylko ClusterRole z następnego punktu; w API nie może nic odczytać.

  Sprawdzenie (wynik `yes no no yes no no no`):
  ```bash
  SA=system:serviceaccount:shop
  kubectl --context rancher-desktop auth can-i get nodes --subresource=metrics --as=$SA:prometheus
  kubectl --context rancher-desktop auth can-i get nodes --subresource=proxy --as=$SA:prometheus
  kubectl --context rancher-desktop -n shop auth can-i list pods --as=$SA:prometheus
  kubectl --context rancher-desktop -n shop auth can-i list pods --as=$SA:kube-state-metrics
  kubectl --context rancher-desktop -n shop auth can-i list secrets --as=$SA:kube-state-metrics
  kubectl --context rancher-desktop -n default auth can-i list pods --as=$SA:kube-state-metrics
  kubectl --context rancher-desktop -n shop auth can-i list pods --as=$SA:default
  ```
  Podzasób podaje się przez `--subresource=metrics`: zapis `get nodes/metrics` `kubectl auth can-i` czyta jako „węzeł o nazwie `metrics`” i zawsze odpowiada `no`.
- **Obiekty całego klastra: ClusterRole i ClusterRoleBinding `shop-prometheus-kubelet` (decyzje 3 i 4).** Jedyne obiekty sklepu poza przestrzenią `shop` (plik `cluster/prometheus-kubelet.yaml`): konto `shop/prometheus` może wykonać `get` na `nodes/metrics`, czyli czytać metryki kubeleta. Kubelet z tym uprawnieniem odpowiada na `/metrics/resource` (zbierane), `/metrics/cadvisor` i `/metrics` (`200`), a odmawia `/pods`, `/runningpods/` i `/configz` (`403`); bez tokenu — `401`. Świadomie nie `nodes/proxy`: to uprawnienie pozwala przez kubelet na `exec` w dowolnym podzie. Plik stosuje `up.sh` w warstwie `monitoring` (przed obciążeniami) na podstawie stałej zgody Michała z 2026-11-14 — wyłącznie ten plik i dokładnie ten zakres; każda zmiana zakresu (inne zasoby, czasowniki, konta, nowe obiekty całego klastra) to decyzja Michała. `down.sh` (także `--purge`) go nie usuwa, bo nie dotyka niczego poza `shop`. Usunięcie (tylko Michał, np. po zakończeniu projektu):
  ```bash
  kubectl --context rancher-desktop delete clusterrolebinding,clusterrole shop-prometheus-kubelet
  ```
  Bez tych obiektów cel `kubelet` w Prometheusie ma błąd `403` i panele CPU i pamięci podów są puste; następne `up.sh monitoring` zakłada je od nowa.
- **Wyjście nowego poda w pierwszej chwili po starcie (pomiar etapu 9b; przyjęte jako znane ograniczenie lokalnego klastra — decyzja Michała 2026-11-14).** Sekcja „Opóźnienie reguł dla nowego poda (Z12, Z13)” opisuje, że nowy pod przez chwilę nie dochodzi do celów w `shop`, bo ich reguły wejścia jeszcze nie znają jego adresu. Druga strona tego samego opóźnienia: przez ok. 0,7–2 s od startu nowego poda jego **wyjście nie jest jeszcze filtrowane**, więc dochodzi do celów **bez** reguły wejścia w `shop` — sprawdzone: API Kubernetesa i kubelet węzła; prawdopodobnie też inne cele spoza `shop` (nie sprawdzane) (zmierzone: pod z etykietą `kube-state-metrics` przy celowo złym adresie w `ipBlock` łączył się z API od `t+0,00` do `t+0,69 s`, od `t+0,80 s` odmowa; pod bez etykiet sklepu dochodził do węzła:10250 i API w pierwszych ~1–2 s). Połączenie otwarte w tym czasie trwa dalej (np. obserwacja API przez kube-state-metrics), dopóki któraś strona go nie zamknie. Restart kontenera w tym samym podzie okna nie ma (sprawdzone: po restarcie odmowa od `t+0,00`) — dotyczy tylko nowego poda. W usługach z `wait-for-network` okno w praktyce przypada na kontener inicjujący (kod z repo), a kod usługi startuje już pod regułami; bez `wait-for-network` są infrastruktura, frontend i monitoring. Cele w `shop` z regułą wejścia są chronione jak dotąd. Sprawdzenia reguł (`conn`, `nc`) robi się dlatego najwcześniej 5 s po starcie poda. Wzorzec produkcyjny: wtyczka sieci, która egzekwuje reguły, zanim kontener poda wystartuje (np. Cilium, Calico), i wzajemne uwierzytelnianie usług (mTLS w service mesh) — wtedy samo połączenie nie wystarcza, żeby usługa przyjęła żądanie; w tym projekcie bez zmian w klastrze i manifestach.
- **Nazwy usług zespołu nie są chronione w Consulu (Z9, Z20, świadome ryzyko).** Zastrzeżone są `auth-service` i `api-gateway` — razem z każdym wariantem wielkości liter (`AUTH-SERVICE`, `Api-Gateway`), bo bez tokenu można zapisywać tylko dokładne nazwy z listy dozwolonych (sekcja „Consul z ACL”). Usługi zespołu (User, Cart, Inventory, Review, Product, Notification) rejestrują się bez tokenu, bo ochrona ich nazw wymagałaby tokenów w kodzie każdej z nich (poza zakresem etapu). NetworkPolicy częściowo to ogranicza: Gateway i usługi łączą się tylko z podami o etykiecie docelowej usługi na jej porcie, więc wpis z adresem obcego poda kończy się odmową połączenia (502, instancja wypada z listy), a nie przejęciem ruchu. Przejęty pod usługi zespołu może jednak zarejestrować cudzą nazwę ze swoim adresem i swoim portem (np. pod Cart jako `user-service` na `:8085`, z którym Gateway może się łączyć) i dostać część żądań tej usługi razem z nagłówkami `X-User-Id` i `X-User-Roles`. Pośrednik `consul-guard` (sekcja „Pośrednik przed Consulem”) zawęża resztę do własnego adresu: rejestracja tylko z adresem poda, który ją wysyła, i bez zastępowania wpisu innego poda; wyrejestrowanie tylko własnego wpisu; tryb maintenance niedostępny (`403`). Zostaje świadome ryzyko podszycia pod nazwę usługi zespołu z **własnym** adresem poda (wpis dochodzi obok prawdziwych instancji, nie zastępuje ich).
- **Health checki Consula (M2 — zamknięte pośrednikiem `consul-guard`; Z23, Z27).** Rejestrujący pod może ustawić tylko zwykłe `GET` na własne `/health/ready` albo `/health/live` — bez nagłówków, treści, cudzego adresu i bez podążania za przekierowaniem — a pole `Output` checków jest puste (`discard_check_output`). Zostaje podszycie pod nazwę usługi zespołu z poprzedniego punktu. Sprawdzenie i szczegóły — sekcja „Pośrednik przed Consulem”.
- **`readOnlyRootFilesystem` i ostrzeżenia Pod Security `restricted`:** infrastruktura (Consul, PostgreSQL, MongoDB, oba Redisy, RabbitMQ, Mailpit i Joby) działa z systemem plików tylko do odczytu, bez ostrzeżeń `restricted` – wyjątków nie ma; zapis tylko do wolumenu danych i `emptyDir` (`/tmp`, gniazdo PostgreSQL `/var/run/postgresql`, `/data/configdb` MongoDB). Frontend (`101:101`) też bez wyjątku: zapis do `/etc/nginx/conf.d` (skrypt startowy obrazu tworzy tam `default.conf` z szablonu — bez zapisywalnego `conf.d` nginx startuje po cichu z domyślną konfiguracją obrazu, bez tras SPA i nagłówków) i `/tmp` (`emptyDir`). Gateway, Auth, User i Joby migracji (`1000:1000`) też bez wyjątku — zapis tylko do `emptyDir` na `/tmp` (sprawdzone `docker run --read-only`: migracje Prisma i Alembic, start, rejestracja konta). Usługi zespołu, ich kontenery `wait-for-network` i `product-migrate` — też bez wyjątku (`emptyDir` na `/tmp`). Monitoring (Prometheus, Grafana, kube-state-metrics) — też bez wyjątku: zapis tylko do `emptyDir` (dane Prometheusa, baza Grafany i `/tmp`), `kubectl apply --dry-run=server -f deploy/k8s/monitoring/` bez ostrzeżeń `restricted`.
- **Dłuższe czasy sond RabbitMQ (odstępstwo od wspólnego wzoru sond).** Każde wywołanie `rabbitmq-diagnostics` uruchamia maszynę Erlanga (ok. 0,45 s bez obciążenia), a nieudana sonda liveness restartuje cały broker, więc: startup co 5 s do 180 s, liveness `timeoutSeconds: 10`, readiness `timeoutSeconds: 5` (jak `timeout: 10s` w compose). `terminationGracePeriodSeconds: 60` – czas na zapis stanu kolejek quorum.

## Pokazy

Polecenia z funkcją `k() { kubectl --context rancher-desktop -n shop "$@"; }` i `api() { curl -s --cacert "$(mkcert -CAROOT)/rootCA.pem" "https://shop.localhost/api/v1$1" "${@:2}"; }`.


Przed pokazami przez Ingress (dużo logowań z jednego adresu laptopa) można wyzerować limity Gateway:
```bash
k exec deploy/redis-gateway -- sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli FLUSHALL'
```

**Product ×3 (load balancing poziom 2) i wstrzymanie HPA.** HPA Product trzyma 1–3 repliki według CPU, więc ręczne `k scale` cofnąłby po ok. 60 s bez obciążenia. Na czas pokazu HPA ustawia się na stałe 3 repliki (sam utworzy brakujące pody):
```bash
k patch hpa product-service --type merge -p '{"spec":{"minReplicas":3,"maxReplicas":3}}'
# HPA zmienia liczbę replik przy następnym sprawdzeniu (do ok. 15 s), więc rollout status skończyłby się od razu przy 1 replice
k wait deploy/product-service --for=jsonpath='{.status.readyReplicas}'=3 --timeout=90s
for i in $(seq 9); do api /products -D - -o /dev/null | grep -i '^x-instance-id'; done   # 3 różne wartości
```
Powrót: `k apply -f deploy/k8s/services/product-service.yaml` (albo `bash deploy/k8s/up.sh services`) — przywraca `minReplicas: 1`, `maxReplicas: 3` i `replicas: 1` z pliku (`kubectl apply` porównuje plik z bieżącym stanem obiektu, więc nadpisuje też liczbę ustawioną przez HPA albo `k scale`); nadmiarowe pody kończą się po `preStop` (10 s), po ok. 15 s zostaje 1 pod. Zmierzone (T7): po `patch` 3 pody gotowe po ok. 15 s, w Consulu 3 wpisy `passing`; 9 żądań przez Ingress → 3 różne `X-Instance-Id` (nie zawsze po równo — każda z 2 replik Gateway rozkłada żądania osobno).

Gateway pyta Consula o instancje Product i rozkłada żądania między nie (drugi poziom load balancingu, za Traefikiem); nagłówek `X-Instance-Id` pokazuje, która kopia Product odpowiedziała.

**Dwie kopie Notification (konkurujący odbiorcy).** Obie kopie czytają tę samą kolejkę `notification.q`; każda wiadomość trafia do jednej z nich:
```bash
k scale deploy/notification-service --replicas=2
k rollout status deploy/notification-service
# 4 rejestracje przez API (każda = zdarzenie user.registered = e-mail powitalny); oczekiwane 4× 201
for i in 1 2 3 4; do api /auth/register -X POST -H 'Content-Type: application/json' -d "{\"email\":\"demo-$i-$(date +%s)@example.com\",\"password\":\"Demo-Haslo-12345!\",\"firstName\":\"Demo\",\"lastName\":\"K8s\"}" -o /dev/null -w '%{http_code}\n'; done
# e-maile w Mailpit (port-forward 18025, sekcja „Porty na laptopie”) i logi obu podów — linie z obu (przedrostek [pod/…])
k logs -l app.kubernetes.io/name=notification-service -c notification-service --prefix --tail=-1 | grep 'E-mail sent'
k scale deploy/notification-service --replicas=1
```

**HPA Product pod obciążeniem.** Obciążenie idzie **bezpośrednio do Product przez `port-forward`, z pominięciem Gateway**: przez Ingress cały ruch z laptopa ma jeden adres klienta (sekcja „Wyjątki”), więc po kilku sekundach Gateway odpowiada `429` (limit 300 żądań/min na adres — poprawne działanie limitu) i do Product nie dociera tyle ruchu, żeby HPA zareagował. W jednym terminalu `k get hpa product-service -w`, w drugim:

```bash
# pełne kubectl (nie funkcja k), żeby $! był procesem kubectl i kill go zamknął
kubectl --context rancher-desktop -n shop port-forward svc/product-service 18083:8083 >/dev/null &
pf=$!; sleep 2
loops=()
for i in $(seq 20); do
  ( end=$((SECONDS + 90)); while [ "$SECONDS" -lt "$end" ]; do curl -s -o /dev/null http://127.0.0.1:18083/products; done ) &
  loops+=($!)
done
wait "${loops[@]}"
kill "$pf"
```

W ciągu ok. minuty HPA podnosi Product do 2–3 replik; po ok. minucie bez obciążenia wraca do 1. Kolumna `TARGETS` pokazuje `<unknown>` przez ok. minutę po starcie poda (metrics-server). HPA Gateway (2–3) trzyma co najmniej 2 repliki (`k get hpa api-gateway`).

Pokazy load balancingu Gateway (2 repliki na zmianę: `X-Gateway-Instance-Id`) — sekcja „Platforma”; pokaz odmowy NetworkPolicy — sekcja „NetworkPolicy”. Pokazy na panelu Grafany (zatrzymana usługa → `503`, otwarty wyłącznik, HPA, wiadomość w DLQ) — sekcja „Metryki (Prometheus i Grafana)”, „Pokazy na panelu”.

## Problemy

| Objaw | Przyczyna i rozwiązanie |
|---|---|
| `kubectl context rancher-desktop not found` albo `the cluster … does not answer` (kod 2) | Rancher Desktop nie działa albo Kubernetes jest wyłączony lub jeszcze startuje – włączyć i poczekać, aż ikona pokaże gotowość. |
| `missing in deploy/.env: …` | `bash deploy/create-secrets.sh` (dopisuje brakujące). |
| `429` (`TOO_MANY_REQUESTS`) na `/api/…`, zwłaszcza w czasie pokazów i testów | Limit Gateway „na adres” (300 żądań/min, 5 logowań/min, 10 rejestracji/min), a cały ruch z laptopa ma jeden adres klienta (sekcja „Wyjątki”). Odczekać minutę albo wyzerować liczniki poleceniem `FLUSHALL` z „Pokazów” (logowania: także `k rollout restart deploy/auth-service` — Auth ma własny licznik w pamięci). Pokaz HPA idzie z pominięciem Gateway („Pokazy”). |
| `lsof -nP -iTCP:443 -sTCP:LISTEN` pokazuje `*:443` | Na macOS oczekiwane — Rancher Desktop wystawia porty Traefika na wszystkich adresach laptopa (sekcja „Wyjątki”, decyzja 19). |
| `image <nazwa>:dev not found in Docker` | Obrazu nie ma w Dockerze: `bash deploy/k8s/up.sh <warstwa> --build`. |
| `job.batch/<nazwa> failed, last log lines:` | Skrypt Joba zakończył się błędem – przyczyna w wypisanym logu (linie z przedrostkiem `[pod/<pod>/<kontener>]`; `wait-for-network` = brak połączenia z celem w 30 s); pełny log: `kubectl --context rancher-desktop -n shop logs job/<nazwa> --all-containers --prefix` (do 10 min po zakończeniu Joba – potem Job znika, a ponowne `up.sh <warstwa>` uruchamia go od nowa). |
| `mongo-0` ma 1 restart (`RESTARTS 1`) tuż po pierwszym `up.sh` na pustym wolumenie; `kubectl --context rancher-desktop -n shop logs mongo-0 --previous` kończy się `Error setting up listener … Address already in use` i `exitCode 48` | Wyścig w obrazie `mongo:8.0` przy pierwszej inicjalizacji: tymczasowy `mongod` od skryptów `deploy/mongo/init/` jeszcze zwalnia port 27017, gdy startuje właściwy. Kubernetes uruchamia kontener ponownie, a skrypty init się nie powtarzają (wolumen jest już zainicjowany), więc baza wstaje po kilku sekundach z kompletem kont. Nic nie trzeba robić. Kolejny restart albo inny kod wyjścia to inny problem — sprawdź log poprzedniego kontenera. |
| `timeout: layer … not ready within 5 minutes` | Pod nie wstaje – `kubectl --context rancher-desktop -n shop describe pod <pod>` (zdarzenia na końcu) i `kubectl --context rancher-desktop -n shop logs <pod>`. |
| Job `consul-kv-seed` kończy się `403` / `ACL not found` | `CONSUL_MANAGEMENT_TOKEN` w `deploy/.env` zmieniony, a `consul-0` działa jeszcze ze starą konfiguracją – kroki „Zmiana tokenu zarządzającego” w sekcji „Consul z ACL” (bez kasowania danych). |
| Zmiana w `deploy/postgres/init/`, `deploy/mongo/init/` albo typu kolejki w `definitions.json` nie działa | Skrypty init i typy kolejek działają tylko na pustym wolumenie (jak w compose) – `bash deploy/k8s/down.sh --purge` (usuwa dane). |
| `mkcert not found (certificate of shop.localhost)` | `brew install mkcert && mkcert -install`, potem `bash deploy/k8s/secrets.sh`. |
| Przeglądarka: „Połączenie nie jest prywatne” na `https://shop.localhost` | Urząd mkcert nie jest zaufany w systemie – `mkcert -install` i ponowne uruchomienie przeglądarki. Certyfikat `TRAEFIK DEFAULT CERT` = brak Secretu `shop-tls` – `bash deploy/k8s/secrets.sh`. |
| `curl: (60) SSL certificate problem` | curl bez `--cacert "$(mkcert -CAROOT)/rootCA.pem"`. |
| `404 page not found` (zwykły tekst) | Ingress nie istnieje (`bash deploy/k8s/up.sh platform`) albo inny host niż `shop.localhost`. |
| `502 {"error":"BAD_GATEWAY",…}` z nagłówkiem `server: nginx` na `/api/…` | Nie ma Service `api-gateway` (np. sama warstwa `platform` w trakcie startu): Traefik pomija regułę `/api` bez Service i kieruje żądanie do frontendu, którego nginx nie znajduje Gateway – `bash deploy/k8s/up.sh platform`. |
| `503 no available server` na `/api/…` | Żadna replika Gateway nie jest gotowa (decyzja 14) – `kubectl --context rancher-desktop -n shop get pods -l app.kubernetes.io/name=api-gateway`. |
| pojedyncze `502 Bad Gateway` zwykłym tekstem na `/api/…` | Proces repliki Gateway zakończył się nagle (awaria, restart kontenera) – Traefik zwraca 502 dla żądań w toku; `kubectl --context rancher-desktop -n shop get pods -l app.kubernetes.io/name=api-gateway` (kolumna RESTARTS) i log poprzedniego kontenera (`logs --previous`). |
| Inventory albo Review nie ma w Consulu (Gateway odpowiada `503` na `/api/v1/inventory/…`, `/api/v1/reviews/…`), choć pod działa | Po przerwie bazy (PostgreSQL albo MongoDB) dłuższej niż ok. minuta Consul usuwa ich krytyczny wpis, a obie usługi rejestrują się tylko raz przy starcie (ich kod zmienia właścicielka — decyzja 17 etapu 7). Obejście: `kubectl --context rancher-desktop -n shop rollout restart deploy/inventory-service deploy/review-service`. |
| Nowa usługa albo nowe wywołanie kończy się `connection refused` (w logu usługi: błąd połączenia, circuit breaker otwarty) | Brak reguły w `deploy/k8s/network/` — trzeba dopisać wyjście u wołającego **i** wejście u wołanego (zmiana tabeli połączeń = decyzja Michała). Sprawdzenie: `k describe netpol <wołający>` i `k describe netpol <wołany>`. |
| Health check w Consulu `critical` z `connection refused`, a `/health/ready` w podzie odpowiada | Brak `consul` w regule wejścia usługi albo portu usługi w regule wyjścia `consul` (`network/infra.yaml`). |
| Job albo pod nie rozwiązuje nazw (`Name does not resolve`, `getaddrinfo`) | Brak `dns.yaml` w klastrze (`k get netpol allow-dns`) albo inna etykieta CoreDNS: `kubectl --context rancher-desktop -n kube-system get pods --show-labels` (oczekiwane `k8s-app=kube-dns`). |
| W logu Auth albo Gateway `Consul registration responded with 403 (ACL: CONSUL_HTTP_TOKEN missing or without permission)`; usługa nie pojawia się w Consulu | Pod nie ma tokenu (stary obraz albo Deployment bez `CONSUL_HTTP_TOKEN`) albo token nie istnieje w Consulu (Job `consul-kv-seed` nie działał od dopisania tokenu do `deploy/.env`). `bash deploy/k8s/up.sh infra`, potem `kubectl --context rancher-desktop -n shop rollout restart deploy/auth-service deploy/api-gateway`. |
| Usługa nie rejestruje się w Consulu albo nie czyta KV, w jej logu `403` od Consula | Odmowa pośrednika `consul-guard` albo ACL Consula. `kubectl --context rancher-desktop -n shop logs deploy/consul-guard --prefix --tail=200 \| grep '"deny"'` pokazuje ścieżkę i powód (`reason`) odmowy pośrednika; przepuszczona rejestracja ze `status: 403` = ACL (nazwa spoza listy dozwolonych, token Auth/Gateway). Nowe pole albo wywołanie → sekcja „Pośrednik przed Consulem”. |
| `The StatefulSet "consul" is invalid: spec: Forbidden: updates to statefulset spec …` przy `up.sh` | Klaster postawiony przed pośrednikiem (`serviceName` zmieniony na `consul-server`): jednorazowo `bash deploy/k8s/down.sh && bash deploy/k8s/up.sh all` (dane zostają). |
| Pody `consul-guard` nie są gotowe (`0/1`), usługi bez Consula | `/guard/ready` = serwer Consula nie ma lidera albo jest nieosiągalny: `kubectl --context rancher-desktop -n shop get pods -l app.kubernetes.io/name=consul` i `… logs deploy/consul-guard`. |
| `CONSUL_AUTH_TOKEN in deploy/.env is not a lowercase UUID` albo `… must be different` (z `secrets.sh`) | Wartość wpisana ręcznie. Usunąć linie `CONSUL_AUTH_TOKEN` i `CONSUL_GATEWAY_TOKEN` z `deploy/.env`, `bash deploy/create-secrets.sh`, potem kroki „Zmiana tokenu Auth albo Gateway”. |
| Po restarcie Rancher Desktop panele „Zasoby” są puste albo stoją w miejscu (repliki, HPA, pamięć podów się nie zmieniają); w Prometheusie (Status → Targets) cel `kube-state-metrics` albo `kubelet` ma błąd połączenia; w logu `kubectl --context rancher-desktop -n shop logs deploy/kube-state-metrics` linie błędów (zaczynają się od `E`) | Zmienił się adres maszyny wirtualnej — najczęściej adres API Kubernetesa (rzadziej adres węzła), a polityki `prometheus-node` i `kube-state-metrics-api` oraz konfiguracja Prometheusa mają adresy z ostatniego `up.sh` (sekcja „Wyjątki”, „Dwie reguły `ipBlock`” — tam polecenia porównania). Objaw bywa opóźniony: kube-state-metrics może jeszcze przez jakiś czas działać na połączeniu z API nawiązanym tuż po starcie poda i traci API dopiero, gdy to połączenie się zerwie. Rozwiązanie: `bash deploy/k8s/up.sh monitoring && kubectl --context rancher-desktop -n shop rollout restart deploy/kube-state-metrics` — `up.sh` wylicza adresy od nowa i podmienia reguły (przy zmianie adresu węzła sam restartuje Prometheusa, bo zmienia się jego ConfigMapa), restart kube-state-metrics zamyka stare połączenie z API. |
| Puste panele CPU i pamięci podów albo replik (bez restartu Rancher Desktop) | Najpierw cele Prometheusa (`port-forward` na 19090, sekcja „Metryki”): `curl -s http://127.0.0.1:19090/api/v1/targets \| jq -r '.data.activeTargets[] \| select(.labels.job=="kubelet" or .labels.job=="kube-state-metrics") \| "\(.labels.job) \(.health) \(.lastError)"'` — oczekiwane `up` i pusty błąd. `kubelet` z `403` → brak ClusterRole albo powiązania: `kubectl --context rancher-desktop get clusterrole,clusterrolebinding shop-prometheus-kubelet` (2 obiekty) i `kubectl --context rancher-desktop auth can-i get nodes --subresource=metrics --as=system:serviceaccount:shop:prometheus` (`yes`); brakujące zakłada `bash deploy/k8s/up.sh monitoring`. `kubelet` albo `kube-state-metrics` z `connection refused` / `context deadline exceeded` → poprzedni wiersz. `kube-state-metrics` `up`, ale bez serii `kube_*` → uprawnienia roli: `kubectl --context rancher-desktop -n shop auth can-i list pods --as=system:serviceaccount:shop:kube-state-metrics` (`yes`) i `kubectl --context rancher-desktop -n shop logs deploy/kube-state-metrics \| grep -c -i forbidden` (`0`). Panele CPU (`rate`) potrzebują dwóch próbek — pierwsze wartości ok. 30 s po starcie Prometheusa. |
| Trzeba usunąć wszystko, co sklep założył poza przestrzenią `shop` (np. po zakończeniu projektu) | `down.sh` (także `--purge`) celowo nie usuwa obiektów całego klastra. Jedyne takie obiekty to ClusterRole i ClusterRoleBinding `shop-prometheus-kubelet` (sekcja „Wyjątki”); usuwa je Michał: `kubectl --context rancher-desktop delete clusterrolebinding,clusterrole shop-prometheus-kubelet`. Następne `bash deploy/k8s/up.sh monitoring` (albo `all`) zakłada je od nowa. |
| Panel „Sklep”: wykresy ruchu puste („No data”) albo „Brak odpowiedzi 5xx/4xx” zaraz po starcie | `rate()` potrzebuje dwóch pobrań metryk (co 15 s), więc dane są po ok. 30 s ruchu; nowy pod Prometheusa zaczyna od pustej historii (`emptyDir`). Puść ruch (`bash postman/run.sh k8s`) i odczekaj 30 s. Pusty jest też panel usługi, do której jeszcze nikt nie wysłał żądania (wyłącznik i instancje Gateway tworzy przy pierwszym żądaniu). |
| Panel „Sklep”: wiersz „Ruch przez Gateway” pusty, a w „Zbieraniu” `api-gateway` ma `0` | Prometheus nie zbiera Gateway — Status → Targets w Prometheusie (`lastError`); Gateway bez portu 9080 to stary obraz (`bash deploy/k8s/up.sh platform --build`). |
