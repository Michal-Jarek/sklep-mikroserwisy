<!-- PR do gałęzi `develop` (nie do `main`). Odnośniki niżej prowadzą do plików w gałęzi `develop`. -->

## Co zmieniam

<!-- Jedno, dwa zdania: co działa inaczej po tej zmianie. -->

## Której usługi dotyczy

<!-- np. services/order-service -->

## Zmiana kontraktu?

Kontrakt = ścieżki, pola JSON, kody odpowiedzi, zdarzenia. Zasada: [docs/decisions.md — D9](https://github.com/Michal-Jarek/sklep-mikroserwisy/blob/develop/docs/decisions.md#d9--własność-kodu-pr-i-dokumenty).

- [ ] Nie
- [ ] Tak — co się zmienia i które usługi to wołają (zgoda ich właścicieli):

## Potrzebna zmiana w `deploy/` lub Gateway (dla Michała)

Zmienne środowiskowe, baza, kolejka, trasa w Gateway, nowy endpoint wewnętrzny, wpis w compose. Co podać: [docs/patterns.md — „Co podać Michałowi w opisie PR”](https://github.com/Michal-Jarek/sklep-mikroserwisy/blob/develop/docs/patterns.md#co-podać-michałowi-w-opisie-pr).

- [ ] Nie
- [ ] Tak:

## Jak sprawdziłem

- [ ] Usługa się uruchamia (lokalnie albo w Rancher Desktop)
- [ ] /health/live i /health/ready odpowiadają 200
- [ ] Testy jednostkowe przechodzą
- [ ] Kolekcja Postman usługi przechodzi
- [ ] Brak haseł i kluczy w zmianie (tylko .env.example bez wartości)
- [ ] `.dockerignore` wyklucza `.env` we wszystkich folderach (`**/.env`, `**/.env.*`)
- [ ] Przeczytałem [docs/decisions.md](https://github.com/Michal-Jarek/sklep-mikroserwisy/blob/develop/docs/decisions.md)
