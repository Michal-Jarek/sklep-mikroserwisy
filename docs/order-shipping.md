# Order i Shipping w Rancher Desktop

Instrukcja dotyczy lokalnej gałęzi z implementacją obu usług. Wymagania platformy opisuje [deploy/README.md](../deploy/README.md). Na Windows użyj Git Bash w katalogu głównym repozytorium i Rancher Desktop z silnikiem dockerd (moby). Wymagany jest działający WSL 2.

## Start stosu

Pliki rozszerzające Compose znajdują się w katalogach właściciela usług. Pierwszym plikiem musi być deploy/compose.yaml, ponieważ względem jego katalogu Compose rozwiązuje ścieżki build. Profil full-shop zapewnia m.in. Gateway, Cart, Product i Inventory.

```bash
docker compose version
bash deploy/create-secrets.sh
shop=(docker compose -f deploy/compose.yaml -f services/order-service/compose.rancher.yaml -f services/shipping-service/compose.rancher.yaml --profile full-shop)
"${shop[@]}" config --quiet
"${shop[@]}" up -d --wait --build
"${shop[@]}" ps order-service shipping-service
```

Obie usługi powinny mieć stan healthy. Tabele tworzą się przy starcie w wydzielonych bazach order_db i shipping_db. Platforma dostarcza hasła przez deploy/.env, konta brokera, exchange shop.events i kolejki. Usługi rejestrują adres kontenera w Consulu, nie publikują portów backendu na hoście.

```bash
curl -fsS 'http://127.0.0.1:8500/v1/health/service/order-service?passing=true'
curl -fsS 'http://127.0.0.1:8500/v1/health/service/shipping-service?passing=true'
curl -fsS http://127.0.0.1:8090/api/v1/shipping/methods
"${shop[@]}" logs --tail=40 order-service shipping-service
```

Oba wyniki Consula powinny być niepustymi tablicami. Cennik przez frontend i Gateway powinien zwrócić COURIER, PARCEL_LOCKER i PICKUP. W razie 503 sprawdź rejestrację, sondy i logi kontenerów. Po demonstracji wykonaj `"${shop[@]}" stop` w tym samym oknie Git Bash.

## Zakup i przesyłka

Po uzgodnieniu identyfikatorów z Inventory przygotuj stan produktu, zaloguj klienta i dodaj produkt do koszyka. Wyślij zamówienie z przykładu w [kontrakcie](frontend-api.md#order). Sprawdź PAID, opróżnienie koszyka i pojawienie się przesyłki PREPARING. Administrator nadaje paczkę przez PATCH /shipments/{id}/status. Po dostarczeniu zdarzenia Order powinien pokazać SHIPPED i odrzucić anulowanie. Dla drugiego koszyka użyj testowej karty kończącej się cyfrą 0 i sprawdź PAYMENT_FAILED, zwolnioną rezerwację oraz zachowany koszyk.

## Stan weryfikacji przed MR

- Walidacja połączonej konfiguracji przez Docker Compose 2.39.4 (config --quiet) przeszła. Lista usług profilu zawiera order-service i shipping-service. Oba serwery uruchomiono też lokalnie przez Uvicorn.
- Przeszło 8 testów Order i 6 Shipping. Dodatkowa próba między rzeczywistymi aplikacjami potwierdziła cenę paczkomatu, PAID, utworzenie przesyłki i odmowę anulowania po SHIPPED. W próbie przekazano zdarzenia bezpośrednio między odbiorcami. Testy używają SQLite i atrap połączeń z pozostałymi usługami. Sprawdzają m.in. symulację płatności, odpowiedź magazynu, anulowanie, uprawnienia, powtarzane zdarzenia i historię statusów.
- 14.11.2026 na stanowisku z Rancher Desktop potwierdzono HTTP 200 dla strony sklepu na porcie 8090 i dla GET /api/v1/shipping/methods. Cennik zwrócił trzy metody dostawy. Sesja sprawdzająca nie miała dostępu do gniazda Docker Engine, a odczyt sond Consula przekroczył limit czasu. Po zalogowaniu przez Gateway sprawdzono GET /orders?page=1&size=1 i GET /shipments?page=1&size=1. Obie usługi odpowiedziały HTTP 200 i zwróciły poprawną strukturę strony. Ten test potwierdza odczyt z obu usług. Zakup z rezerwacją oraz dostarczenie zdarzenia przez RabbitMQ pozostają do sprawdzenia.
- W sprawdzonym develop (4d5e220) ReservationItem.product_id w Inventory wymaga liczby całkowitej. Kontrakt D1 i katalog produktów używają UUID. Dopóki Inventory nie przyjmie UUID, próba rzeczywistej rezerwacji produktu z katalogu może zakończyć się błędem. Order wysyła UUID bez przeliczania.
- Scenariusze S80/S81 w [wspólnym runnerze](../postman/README.md) są znacznikami etapu 8. Obecny runner zgłosi błąd po wykryciu zarejestrowanych usług. Przed odbiorem trzeba zastąpić znaczniki sprawdzeniem rzeczywistego zakupu.
- Do uzgodnienia pozostaje równoczesne nadanie i anulowanie przed dotarciem zdarzenia do Order. Lokalne testy sekwencyjne nie dowodzą atomowości między usługami.
