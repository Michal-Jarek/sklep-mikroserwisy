# Dokumentacja

Dokumenty dla zespołu, w kolejności czytania:

1. [Decyzje dla usług zespołu](decisions.md) — wiążące zasady D1–D20 (identyfikatory, kwoty, błędy, wyłącznik, Consul, logi, zdrowie, kontener); na górze ściągawka.
2. [Wzorce](patterns.md) — jak spełnić decyzje w praktyce: przykład usługi w FastAPI, wywołanie innej usługi, wpis w compose, migracje.
3. [Zdarzenia (RabbitMQ)](events.md) — jak usługi publikują i odbierają zdarzenia: koperta, kolejki, konta, przykład odbiorcy.
4. [Kontrakt usług dla frontendu](frontend-api.md) — endpointy, które woła frontend: dostęp, pola, błędy i przykłady JSON; propozycja v1 dla Product, Order i Shipping.

5. [Order i Shipping w Rancher Desktop](order-shipping.md) — lokalne uruchomienie obu usług, test przez Gateway i otwarte kwestie integracyjne.

Uruchomienie infrastruktury lokalnie: [deploy/README.md](../deploy/README.md).

Tu trafią też raport z projektu, prezentacja i diagramy architektury.
