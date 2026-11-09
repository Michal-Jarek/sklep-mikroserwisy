# Kubernetes — cart-service

Manifesty są przeznaczone dla namespace `shop`. Namespace, bazy, Consul, sekrety i polityki sieciowe są wspólną infrastrukturą i wymagają uzgodnienia z architektem.

`app.yaml` zawiera Deployment oraz Service typu ClusterIP. Obraz: `cart-service:0.1.0`. Przy rejestracji w Consulu aplikacja przekazuje adres poda i jego nazwę jako identyfikator instancji.

Cart wymaga Secret `cart-redis-secret` z kluczem `url` zawierającym pełny adres Redisa, oraz Consula pod adresem `http://consul:8500`.

```sh
kubectl apply -f services/cart-service/k8s/app.yaml
```

Propozycja reguł dla wspólnej NetworkPolicy znajduje się w `../docs/network-policy.proposed.yaml`. W docelowym repo polityki należą do `deploy/k8s/`; plik wymaga przeglądu i przeniesienia przez architekta. Nie jest stosowany przez powyższe polecenia. Izolacja sieciowa jest warunkiem zaufania nagłówkom Gateway.
