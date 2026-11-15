"""Wyszukiwanie instancji usługi w Consulu + round robin po stronie klienta (cache listy 10 s).

Pusta lista `passing` z Consula (np. przez 1–2 s po restarcie Consula, zanim checki przejdą) nie trafia do cache;
każde kolejne wywołanie pyta Consula od nowa, więc powrót instancji widać od razu. W tym czasie używamy ostatniej
niepustej listy, dopóki seria pustych odpowiedzi trwa najwyżej EMPTY_ANSWERS_MAX s (licząc od pierwszej pustej;
niepusta odpowiedź zeruje licznik). Awaria Consula nie postarza listy - wtedy działa ścieżka z ostatnią znaną listą.
ServiceNotFound dopiero, gdy Consul zwraca pustą listę dłużej niż EMPTY_ANSWERS_MAX s albo nie mamy żadnej listy.
"""
import itertools
import logging
import threading
import time

import httpx

from app.config import Settings

logger = logging.getLogger(__name__)


# Jak długo Consul może bez przerwy zwracać pustą listę, a my wciąż używamy ostatniej niepustej. Restart Consula daje
# ~1–2 s pustej listy; 30 s to zapas na wolniejszy start checków. Instancja naprawdę wyłączona przestaje być wołana
# najpóźniej po 30 s (wcześniej i tak chronią nas wyłącznik i ponowienia w kliencie Order).
EMPTY_ANSWERS_MAX = 30.0

# Po błędzie zapytania do Consula (np. zawieszony Consul: 2 s czekania na timeout) ostatnią listę trzymamy w cache
# przez zwykłe TTL, licząc od chwili błędu (CR-14). Kolejne próby tego samego żądania (do 2 × (2 s + odstęp) przy
# niedziałającym Order) i następne żądania nie czekają wtedy znowu na Consula; 2 s nie wystarczały na ponowienia.

OK, STALE, EMPTY = "ok", "stale", "empty"


class ServiceNotFound(Exception):
    pass


class ServiceResolver:
    def __init__(self, settings: Settings, ttl: float = 10.0, transport: httpx.BaseTransport | None = None):
        self._settings = settings
        self._ttl = ttl
        self._client = httpx.Client(timeout=settings.http_timeout_seconds, transport=transport)
        self._cache: dict[str, tuple[float, list[str]]] = {}
        self._last_good: dict[str, list[str]] = {}  # ostatnia niepusta lista z Consula
        self._empty_since: dict[str, float] = {}  # pierwsza pusta odpowiedź w bieżącej serii pustych
        self._state: dict[str, str] = {}
        self._counter = itertools.count()
        self._lock = threading.Lock()

    def resolve(self, name: str, fallback_url: str = "") -> str:
        """Zwraca bazowy URL kolejnej zdrowej instancji. Gdy Consul nie działa, używa adresu zapasowego."""
        if self._settings.consul_enabled:
            urls = self._instances(name)
            if urls:
                return urls[next(self._counter) % len(urls)]
        if fallback_url:
            return fallback_url.rstrip("/")
        raise ServiceNotFound(f"Brak zdrowych instancji usługi {name}")

    def _instances(self, name: str) -> list[str]:
        now = time.monotonic()
        with self._lock:
            cached = self._cache.get(name)
            if cached and cached[0] > now:
                return cached[1]
        try:
            s = self._settings
            resp = self._client.get(
                f"http://{s.consul_host}:{s.consul_port}/v1/health/service/{name}", params={"passing": "true"}
            )
            resp.raise_for_status()
            urls = []
            for entry in resp.json():
                svc = entry.get("Service", {})
                host = svc.get("Address") or entry.get("Node", {}).get("Address")
                if host and svc.get("Port"):
                    urls.append(f"http://{host}:{svc['Port']}")
        except (httpx.HTTPError, ValueError) as exc:
            # tylko klasa wyjątku: treść może zawierać adresy i odpowiedź Consula
            logger.warning("Zapytanie do Consula o %s nieudane", name, extra={"fields": {"reason": type(exc).__name__}})
            if not cached:
                return []
            # przy awarii Consula korzystamy ze starej listy; awaria nie postarza listy
            with self._lock:  # od chwili błędu, nie od początku zapytania (timeout trwał już 2 s)
                self._cache[name] = (time.monotonic() + self._ttl, cached[1])
            return cached[1]
        with self._lock:
            if urls:
                self._cache[name] = (now + self._ttl, urls)
                self._last_good[name] = urls
                self._empty_since.pop(name, None)
                self._set_state(name, OK)
                return urls
            since = self._empty_since.setdefault(name, now)
            last = self._last_good.get(name)
            if last and now - since <= EMPTY_ANSWERS_MAX:
                self._set_state(name, STALE, len(last), now - since)
                return last
            self._set_state(name, EMPTY)
            return []

    def _set_state(self, name: str, state: str, count: int = 0, age: float = 0.0) -> None:
        """Jedna linia logu na zmianę stanu listy (wywoływane pod blokadą)."""
        previous = self._state.get(name, OK)
        self._state[name] = state
        if state == previous:
            return
        if state == STALE:
            logger.warning(
                "Consul zwraca pustą listę %s, używam ostatniej znanej (%d instancji, puste od %.1f s)", name, count, age
            )
        elif state == EMPTY:
            logger.warning("Consul zwraca pustą listę %s, brak listy do użycia", name)
        else:
            logger.info("Consul znów zwraca instancje %s", name)
