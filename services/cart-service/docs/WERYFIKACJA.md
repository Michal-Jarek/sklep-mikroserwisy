# Weryfikacja po dopasowaniu struktury — 7 listopada 2026

- pytest: 32 testów, wszystkie przeszły, 0 pominiętych.
- Obraz Docker zbudowany z katalogu `services/cart-service`.
- Lokalny zestaw uruchomiony z `services/user-service/dev/compose.yaml`.
- `/health/live` oraz `/health/ready`: odpowiedź 200.
- Rejestracja w prawdziwym Consulu: health check w stanie passing.
- Kolekcja Postman wykonana przez Newman: 5 żądań i 5 asercji, 0 błędów.
- Manifesty Kubernetes są poprawnym YAML i wskazują namespace `shop`.

Testy Cart wykonano na prawdziwym Redisie 7.4. Sprawdzono m.in. kwoty, ilości, TTL, równoległe zmiany, fallback Inventory, circuit breaker i ograniczenie SERVICE. W sprawdzeniu HTTP oraz kolekcji Postman Product i Inventory były tymczasowymi atrapami HTTP zarejestrowanymi w prawdziwym Consulu.

Łącznie obie usługi mają 49 testów pytest oraz 12 sprawdzonych żądań i asercji Postman. Nie wykonano wdrożenia w docelowym Kubernetesie ani integracji z rzeczywistym kodem pozostałych usług. Consul KV pozostaje niezaimplementowany. TestClient User zgłasza jedno ostrzeżenie o przestarzałym aliasie AnyIO, bez wpływu na wynik testów.

Porównanie z przesłanym szkieletem potwierdziło, że pliki poza `services/user-service/` i `services/cart-service/` nie zostały zmienione. Wspólne metadane repozytorium i polityki sieciowe wymagają uzgodnienia z architektem.
