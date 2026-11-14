"""Calls to Review and Inventory for the product page (docs/patterns.md, section 4; D2, D5, D11).

Both are optional for Product: when one does not answer, the page still works and the field is null
(frontend-api.md, GET /products/{productId}). Rules per attempt:

| result                              | failure for breaker? | retry (GET)? |
| no connection, timeout 2 s          | yes                  | yes          |
| 502, 503, 504                       | yes                  | yes          |
| other 5xx, 408, 429                 | yes                  | no           |
| other 4xx (e.g. 404)                | no                   | no           |
| 2xx                                 | no (success)         | -            |

At most 3 attempts (retries after 200 ms and 400 ms), each only if it fits before the deadline.
"""

import asyncio
import uuid
from time import monotonic

import httpx

from .breaker import CircuitBreaker, CircuitOpen
from .consul import Discovery
from .logs import logger, reason
from .web import Identity

ATTEMPT_TIMEOUT = 2.0
BACKOFF = (0.2, 0.4)
RETRY_STATUSES = {502, 503, 504}
REVIEW = "review-service"
INVENTORY = "inventory-service"


class Unavailable(Exception):
    """The other service gave no usable answer (failure, open breaker, no instance, deadline)."""


class _Failure(Exception):
    def __init__(self, retry: bool, detail: str):
        super().__init__(detail)
        self.retry = retry


class ServiceClient:
    def __init__(self, http: httpx.AsyncClient, discovery: Discovery, name: str):
        self.http = http
        self.discovery = discovery
        self.name = name
        self.breaker = CircuitBreaker()

    async def get(self, path: str, headers: dict[str, str], deadline: float) -> httpx.Response:
        """A GET with the rules above. Returns a 2xx or a 4xx response; raises Unavailable otherwise."""
        first = await self.discovery.pick(self.name)
        if first is None:
            # No instance: fallback without a call, not a failure for the breaker (patterns.md, section 4).
            raise Unavailable(f"{self.name}: no healthy instance in Consul")
        try:
            return await self.breaker.call(lambda: self._attempts(path, headers, deadline, first))
        except CircuitOpen:
            raise Unavailable(f"{self.name}: circuit breaker open") from None
        except _Failure as exc:
            raise Unavailable(f"{self.name}: {exc}") from None

    async def _attempts(self, path: str, headers: dict[str, str], deadline: float, first: str) -> httpx.Response:
        last: _Failure | None = None
        for attempt in range(1 + len(BACKOFF)):
            if attempt:
                pause = BACKOFF[attempt - 1]
                # The next attempt only if it can start before the deadline (D5).
                if monotonic() + pause >= deadline:
                    break
                await asyncio.sleep(pause)
            remaining = deadline - monotonic()
            if remaining <= 0:
                break
            base = first if attempt == 0 else await self.discovery.pick(self.name)
            if base is None:
                break  # every known instance failed to connect
            try:
                response = await self.http.get(base + path, headers=headers, timeout=min(ATTEMPT_TIMEOUT, remaining))
            except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                self.discovery.drop(self.name, base)  # try another instance next time
                last = _Failure(True, f"no connection ({type(exc).__name__})")
                continue
            except httpx.TimeoutException:
                last = _Failure(True, "timeout")
                continue
            except httpx.HTTPError as exc:
                last = _Failure(True, type(exc).__name__)
                continue
            status = response.status_code
            if status in RETRY_STATUSES:
                last = _Failure(True, f"HTTP {status}")
                continue
            if status >= 500 or status in (408, 429):
                raise _Failure(False, f"HTTP {status}")
            return response  # 2xx and other 4xx: an answer of a working service
        raise last or _Failure(False, "deadline exceeded")


class Enrichment:
    """rating from Review and availability from Inventory, both with fallback null."""

    def __init__(self, http: httpx.AsyncClient, discovery: Discovery):
        self.review = ServiceClient(http, discovery, REVIEW)
        self.inventory = ServiceClient(http, discovery, INVENTORY)

    async def rating(self, product_id: uuid.UUID, who: Identity, deadline: float) -> dict | None:
        try:
            response = await self.review.get(f"/reviews/summary/{product_id}", who.call_headers(), deadline)
        except Unavailable as exc:
            logger.warning("Rating not available", extra=reason(exc))
            return None
        if response.status_code != 200:
            return None
        try:
            data = response.json()
            count = data["reviewCount"]
            average = data["averageRating"]
            if not isinstance(count, int) or isinstance(count, bool) or count < 0:
                raise ValueError("reviewCount")
            if average is not None and (isinstance(average, bool) or not isinstance(average, int | float)):
                raise ValueError("averageRating")
        except (ValueError, KeyError, TypeError) as exc:
            # A 2xx that breaks the contract: no data, logged as an error, not a breaker failure (D2).
            logger.error("Review answered outside the contract", extra=reason(exc))
            return None
        return {"average": round(float(average), 1) if average is not None and count > 0 else None, "count": count}

    async def availability(self, product_id: uuid.UUID, who: Identity, deadline: float) -> dict | None:
        try:
            response = await self.inventory.get(f"/inventory/{product_id}", who.call_headers(), deadline)
        except Unavailable as exc:
            logger.warning("Availability not available", extra=reason(exc))
            return None
        if response.status_code == 404:
            return {"available": 0, "inStock": False}  # no stock entry yet = 0 pieces (frontend-api.md)
        if response.status_code != 200:
            return None
        try:
            data = response.json()
            available = data["available"]
            in_stock = data["inStock"]
            if not isinstance(available, int) or isinstance(available, bool) or available < 0:
                raise ValueError("available")
            if not isinstance(in_stock, bool):
                raise ValueError("inStock")
        except (ValueError, KeyError, TypeError) as exc:
            logger.error("Inventory answered outside the contract", extra=reason(exc))
            return None
        return {"available": available, "inStock": in_stock}

    async def for_product(self, product_id: uuid.UUID, who: Identity) -> tuple[dict | None, dict | None]:
        """Both calls at the same time, with a common deadline of 8 s (D5)."""
        deadline = monotonic() + 8.0
        rating, availability = await asyncio.gather(
            self.rating(product_id, who, deadline),
            self.availability(product_id, who, deadline),
        )
        return rating, availability
