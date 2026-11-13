"""Wyszukiwanie instancji usługi w Consulu + round robin po stronie klienta (cache listy 10 s)."""
import itertools
import logging
import threading
import time

import httpx

from app.config import Settings

logger = logging.getLogger(__name__)


class ServiceNotFound(Exception):
    pass


class ServiceResolver:
    def __init__(self, settings: Settings, ttl: float = 10.0, transport: httpx.BaseTransport | None = None):
        self._settings = settings
        self._ttl = ttl
        self._client = httpx.Client(timeout=settings.http_timeout_seconds, transport=transport)
        self._cache: dict[str, tuple[float, list[str]]] = {}
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
            logger.warning("Zapytanie do Consula o %s nieudane: %s", name, exc)
            # przy awarii Consula korzystamy ze starej listy, jeśli jeszcze ją mamy
            return cached[1] if cached else []
        with self._lock:
            self._cache[name] = (now + self._ttl, urls)
        return urls
