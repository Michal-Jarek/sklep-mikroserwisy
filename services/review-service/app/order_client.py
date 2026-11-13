"""Klient Order Service: czy użytkownik kupił produkt (GET /orders/purchased?userId=&productId=).

Zasady z architektury: adres z Consula, timeout 2 s, ponowienie (maks. 2 razy) tylko dla GET,
circuit breaker i brak zgadywania - gdy Order nie odpowiada, opinia jest odrzucana (503).
"""
import logging
from functools import lru_cache

import httpx
import pybreaker
from tenacity import Retrying, retry_if_exception, stop_after_attempt, wait_exponential

from app.config import Settings, get_settings
from app.discovery import ServiceNotFound, ServiceResolver

logger = logging.getLogger(__name__)


class OrderServiceUnavailable(Exception):
    """Order Service nie odpowiedział poprawnie (sieć, timeout, 5xx, otwarty circuit breaker)."""


class _UpstreamError(Exception):
    def __init__(self, message: str, retryable: bool):
        super().__init__(message)
        self.retryable = retryable


class OrderClient:
    def __init__(
        self,
        settings: Settings,
        resolver: ServiceResolver | None = None,
        transport: httpx.BaseTransport | None = None,
        retry_wait_max: float = 1.0,
    ):
        self._settings = settings
        self._resolver = resolver or ServiceResolver(settings)
        self._http = httpx.Client(timeout=settings.http_timeout_seconds, transport=transport)
        self._retry_wait_max = retry_wait_max
        # pybreaker liczy kolejne błędy: po 5 z rzędu obwód jest otwarty przez 30 s (fallback = 503)
        self._breaker = pybreaker.CircuitBreaker(fail_max=5, reset_timeout=30, name="order-service")

    def has_purchased(self, user_id: str, product_id: int, headers: dict[str, str] | None = None) -> bool:
        try:
            return self._breaker.call(self._fetch_with_retry, user_id, product_id, headers or {})
        except pybreaker.CircuitBreakerError:
            logger.warning("Circuit breaker order-service jest otwarty")
            raise OrderServiceUnavailable("circuit breaker open")
        except _UpstreamError as exc:
            raise OrderServiceUnavailable(str(exc))

    def _fetch_with_retry(self, user_id: str, product_id: int, headers: dict[str, str]) -> bool:
        retrying = Retrying(
            stop=stop_after_attempt(3),  # pierwsze wywołanie + maks. 2 ponowienia
            wait=wait_exponential(multiplier=0.2, max=self._retry_wait_max),
            retry=retry_if_exception(lambda e: isinstance(e, _UpstreamError) and e.retryable),
            reraise=True,
        )
        for attempt in retrying:
            with attempt:
                return self._fetch(user_id, product_id, headers)
        raise AssertionError("unreachable")  # pragma: no cover

    def _fetch(self, user_id: str, product_id: int, headers: dict[str, str]) -> bool:
        try:
            base = self._resolver.resolve(self._settings.order_service_name, self._settings.order_service_url)
        except ServiceNotFound as exc:
            raise _UpstreamError(str(exc), retryable=True)
        try:
            resp = self._http.get(
                f"{base}/orders/purchased",
                params={"userId": user_id, "productId": product_id},
                headers=headers,
            )
        except httpx.HTTPError as exc:  # timeout, brak połączenia
            raise _UpstreamError(f"Order Service niedostępny: {exc.__class__.__name__}", retryable=True)

        if resp.status_code >= 500:
            raise _UpstreamError(f"Order Service zwrócił {resp.status_code}", retryable=True)
        if resp.status_code != 200:
            raise _UpstreamError(f"Order Service odrzucił zapytanie ({resp.status_code})", retryable=False)
        try:
            data = resp.json()
        except ValueError:
            raise _UpstreamError("Order Service zwrócił niepoprawny JSON", retryable=False)
        if isinstance(data, bool):
            return data
        if isinstance(data, dict) and isinstance(data.get("purchased"), bool):
            return data["purchased"]
        raise _UpstreamError("Nieoczekiwany format odpowiedzi Order Service", retryable=False)


@lru_cache
def get_order_client() -> OrderClient:
    return OrderClient(get_settings())
