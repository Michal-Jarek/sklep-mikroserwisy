# Integracja cart-service

Wszystkie pliki tej usługi znajdują się w `services/cart-service/`. Kolekcja Postman jest w `postman/`, manifesty aplikacji w `k8s/`, a opis API w `docs/KONTRAKT.md`.

## Wspólna infrastruktura

- Namespace: `shop`; adres Consula: `http://consul:8500`.
- Nazwy usług i etykiety podów: `app: user-service`, `app: cart-service` oraz nazwy pozostałych usług z głównego README repozytorium.
- Własny magazyn danych; brak bezpośredniego dostępu do baz innych usług.
- Sekrety i infrastruktura są dodawane przez architekta w `deploy/`. Plik `network-policy.proposed.yaml` jest propozycją do przekazania właścicielowi wspólnego `deploy/k8s/`; ten PR nie zmienia plików deploy.
- Gateway usuwa nagłówki tożsamości klienta i dodaje `X-User-Id`, `X-User-Roles` oraz `X-Request-Id`. JWT weryfikuje Gateway.
- Dla usług nie są przewidziane publiczne Ingress, NodePort ani LoadBalancer.

## Product, Inventory i Order

Product rejestruje się jako `product-service` i zwraca nazwę oraz `price` w formacie np. `"19.99"`. Inventory rejestruje się jako `inventory-service` i zwraca całkowitą liczbę `available`. Kontrakty wymagają potwierdzenia przy implementacji tych usług.

Order pobiera GET `/cart` z ID klienta i rolą SERVICE. Po zakupie wywołuje DELETE `/cart/{userId}`. Wyczyszczenie usuwa cały bieżący koszyk; wersjonowanie migawki zakupowej wymaga wspólnej zmiany kontraktu.

## Konfiguracja centralna

Konfiguracja jest odczytywana ze zmiennych środowiskowych i lokalnego `.env`. Przy starcie odczytywane jest `logLevel` z Consul KV `config/<usługa>/data`. Zmienne środowiskowe i lokalne `.env` mają pierwszeństwo; bez Consula start jest dozwolony. Discovery i health checki Consula są zaimplementowane.
