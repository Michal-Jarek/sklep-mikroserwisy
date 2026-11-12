# Integracja user-service

Wszystkie pliki tej usługi znajdują się w `services/user-service/`. Kolekcja Postman jest w `postman/`, manifesty aplikacji w `k8s/`, a opis API w `docs/KONTRAKT.md`.

## Wspólna infrastruktura

- Namespace: `shop`; adres Consula: `http://consul:8500`.
- Nazwy usług i etykiety podów: `app: user-service`, `app: cart-service` oraz nazwy pozostałych usług z głównego README repozytorium.
- Własny magazyn danych; brak bezpośredniego dostępu do baz innych usług.
- Sekrety i infrastruktura są dodawane przez architekta w `deploy/`. Plik `network-policy.proposed.yaml` jest propozycją do przekazania właścicielowi wspólnego `deploy/k8s/`; ten PR nie zmienia plików deploy.
- Gateway usuwa nagłówki tożsamości klienta i dodaje `X-User-Id`, `X-User-Roles` oraz `X-Request-Id`. JWT weryfikuje Gateway.
- Dla usług nie są przewidziane publiczne Ingress, NodePort ani LoadBalancer.

## Auth i Notification

Auth wywołuje POST `/users` z rolą SERVICE, przekazując UUID konta oraz dane profilu. Notification może pobierać profil przez GET `/users/{id}` z rolą SERVICE. Tworzenie profilu nie publikuje zdarzeń RabbitMQ. Zmiana e-maila wymaga osobnego uzgodnienia z Auth.

## Konfiguracja bazy

Domyślnie `postgres:5432` w klastrze, baza `user_db` i użytkownik `user_service`. Hasło pochodzi z Secret `user-db-secret`. Dla innej nazwy wspólnego serwera PostgreSQL wystarczy zmienić DB_HOST w manifestach aplikacji i migracji. Nie jest wymagany osobny fizyczny serwer bazy dla User.

## Konfiguracja centralna

Konfiguracja jest odczytywana ze zmiennych środowiskowych i lokalnego `.env`. Przy starcie odczytywane jest `logLevel` z Consul KV `config/<usługa>/data`. Zmienne środowiskowe i lokalne `.env` mają pierwszeństwo; bez Consula start jest dozwolony. Discovery i health checki Consula są zaimplementowane.
