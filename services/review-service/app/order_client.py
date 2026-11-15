"""Klient Order Service: czy użytkownik kupił produkt (GET /orders/purchased?userId=&productId=).

Zasady D2 (docs/patterns.md, sekcja 4): instancja z Consula, wyłącznik (app/circuit_breaker.py), timeout 2 s na próbę,
ponowienie (to jest GET) najwyżej 2 razy po 200 ms i 400 ms, tylko po braku połączenia, timeoucie, 502, 503, 504.
Awaria dla wyłącznika: brak połączenia, timeout, 5xx, 408, 429. Inne 4xx (np. 403) to odpowiedź działającej usługi -
nie awaria. Brak zgadywania: gdy nie da się sprawdzić zakupu, opinia jest odrzucana (503).
"""
import logging
from functools import lru_cache

import httpx
from tenacity import Retrying, retry_if_exception, stop_after_attempt, wait_exponential

from app.circuit_breaker import FAILURE, NOT_COUNTED, SUCCESS, CircuitBreaker, CircuitOpen
from app.config import Settings, get_settings
from app.discovery import ServiceNotFound, ServiceResolver

logger = logging.getLogger(__name__)

RETRYABLE_STATUS = (502, 503, 504)


class OrderServiceUnavailable(Exception):
    """Nie udało się sprawdzić zakupu (sieć, timeout, 5xx, odmowa, otwarty wyłącznik, brak instancji)."""


class _AttemptFailed(Exception):
    def __init__(self, reason: str, retryable: bool):
        super().__init__(reason)
        self.retryable = retryable


class OrderClient:
    def __init__(
        self,
        settings: Settings,
        resolver: ServiceResolver | None = None,
        transport: httpx.BaseTransport | None = None,
        breaker: CircuitBreaker | None = None,
        retry_wait: float = 0.2,
    ):
        self._settings = settings
        self._resolver = resolver or ServiceResolver(settings)
        self._http = httpx.Client(timeout=settings.http_timeout_seconds, transport=transport)
        self._breaker = breaker or CircuitBreaker()
        self._retry_wait = retry_wait

    def has_purchased(self, user_id: str, product_id: str, headers: dict[str, str]) -> bool:
        retrying = Retrying(
            stop=stop_after_attempt(3),  # pierwsza próba + najwyżej 2 ponowienia
            wait=wait_exponential(multiplier=self._retry_wait),  # 200 ms, potem 400 ms
            retry=retry_if_exception(lambda e: isinstance(e, _AttemptFailed) and e.retryable),
            reraise=True,
        )
        try:
            for attempt in retrying:
                with attempt:
                    return self._attempt(user_id, product_id, headers)
        except CircuitOpen:
            logger.warning("Wyłącznik order-service otwarty, zakup niesprawdzony")
            raise OrderServiceUnavailable("circuit open")
        except ServiceNotFound:
            logger.warning("Brak zdrowych instancji order-service")
            raise OrderServiceUnavailable("no instances")
        except _AttemptFailed as exc:
            raise OrderServiceUnavailable(str(exc))
        raise AssertionError("unreachable")  # pragma: no cover

    def _attempt(self, user_id: str, product_id: str, headers: dict[str, str]) -> bool:
        base = self._resolver.resolve(self._settings.order_service_name, self._settings.order_service_url)
        ticket = self._breaker.before()
        outcome = FAILURE  # także przy nieoczekiwanym wyjątku
        try:
            try:
                resp = self._http.get(
                    f"{base}/orders/purchased", params={"userId": user_id, "productId": product_id}, headers=headers
                )
            except httpx.HTTPError as exc:  # brak połączenia, timeout
                logger.warning("Order Service nie odpowiada", extra={"fields": {"reason": type(exc).__name__}})
                raise _AttemptFailed(type(exc).__name__, retryable=True)

            status = resp.status_code
            if status >= 500 or status in (408, 429):
                logger.warning("Order Service zwrócił błąd", extra={"fields": {"upstreamStatus": status}})
                raise _AttemptFailed(f"status {status}", retryable=status in RETRYABLE_STATUS)
            if status != 200:
                outcome = SUCCESS  # odpowiedź działającej usługi, nie awaria
                logger.error("Order Service odrzucił zapytanie", extra={"fields": {"upstreamStatus": status}})
                raise _AttemptFailed(f"status {status}", retryable=False)

            outcome = NOT_COUNTED
            try:
                data = resp.json()
            except ValueError:
                data = None
            if not isinstance(data, dict) or not isinstance(data.get("purchased"), bool):
                logger.error("Odpowiedź Order Service niezgodna z kontraktem")
                raise _AttemptFailed("contract", retryable=False)
            outcome = SUCCESS
            return data["purchased"]
        finally:
            self._breaker.after(ticket, outcome)


@lru_cache
def get_order_client() -> OrderClient:
    return OrderClient(get_settings())
