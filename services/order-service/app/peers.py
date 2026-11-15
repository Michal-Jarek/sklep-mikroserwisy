"""Calls to Cart, Product, Inventory and Shipping (D2, D5, D11, D13).

Order: instance from Consul (outside the circuit breaker) → breaker → request with a 2 s timeout (shorter when the
purchase deadline is closer; no call at all with less than MIN_CALL_SECONDS left), of which the connection may take
at most 1 s (half of a shorter limit). A failure for the breaker: no connection, timeout, 5xx, 408, 429. GET is retried at most twice (200 and 400 ms) after a connection error, a timeout
or 502/503/504 if it fits before the deadline; other methods only when the connection was never established (the
service did not get the request, Z22).
call() returns every other response (2xx, 4xx); the caller maps the codes it expects and treats the rest
with rejected() — a refusal of another service is an integration error (503 + error log), not bad client input.
"""
import asyncio
import logging
from decimal import Decimal
from typing import Literal

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, ValidationError

from .circuit_breaker import CircuitBreaker, CircuitOpen
from .discovery import NoInstances
from .schemas import Cart, Price, Product

log = logging.getLogger("app.peers")
CALL_TIMEOUT = 2.0
CONNECT_TIMEOUT = 1.0  # at most half of the call limit (CR-1 round 2)
RETRY_DELAYS = (0.2, 0.4)
# CR-4: with less time than this left before the purchase deadline a call would only end in a timeout that counts as
# a failure of the target service in its breaker; it is not made at all (Unavailable "deadline").
MIN_CALL_SECONDS = 0.5


class Unavailable(Exception):
    """The other service did not answer usefully (no instance, open breaker, timeout, 5xx, refusal)."""

    def __init__(self, service: str, reason: str):
        super().__init__(f"{service}: {reason}")
        self.service = service
        self.reason = reason


class BadStatus(Exception):
    def __init__(self, status: int):
        super().__init__(status)
        self.status = status


class DeliveryPrice(BaseModel):
    price: Price
    currency: Literal["PLN"]


def rejected(service: str, response: httpx.Response) -> Unavailable:
    log.error("Service rejected the request", extra={"fields": {
        "target": service, "method": response.request.method, "status": response.status_code}})
    return Unavailable(service, f"HTTP {response.status_code}")


def unavailable(service: str, method: str, reason: str) -> None:
    """One warning per call that ends without a usable answer (no instance, open breaker, timeout, 5xx)."""
    log.warning("Service unavailable", extra={"fields": {"target": service, "method": method, "reason": reason}})


def headers(caller) -> dict[str, str]:
    result = {"X-User-Roles": ",".join(sorted(caller.roles | {"SERVICE"})), "X-Request-Id": caller.request_id}
    if caller.user_id is not None:
        result["X-User-Id"] = str(caller.user_id)
    return result


class Peers:
    def __init__(self, client: httpx.AsyncClient, discovery, settings):
        self.client = client
        self.discovery = discovery
        self.urls = {"shipping": settings.shipping_service_url, "cart": settings.cart_service_url,
                     "inventory": settings.inventory_service_url, "product": settings.product_service_url}
        self.breakers = {name: CircuitBreaker() for name in self.urls}

    async def call(self, name: str, method: str, path: str, caller, deadline: float | None = None,
                   **kwargs) -> httpx.Response:
        loop = asyncio.get_running_loop()
        safe = method in ("GET", "HEAD")
        for index in range(len(RETRY_DELAYS) + 1):
            limit = CALL_TIMEOUT if deadline is None else min(CALL_TIMEOUT, deadline - loop.time())
            if limit < MIN_CALL_SECONDS:
                unavailable(name, method, "deadline")
                raise Unavailable(name, "deadline")
            try:
                url = self.urls[name] or await self.discovery.resolve(f"{name}-service")
            except NoInstances:
                unavailable(name, method, "NoInstances")
                raise Unavailable(name, "NoInstances") from None

            # CR-1 round 2: the connect phase ends before the whole limit, so an address that does not answer
            # (a container or pod stopped a moment ago, still on the list) gives ConnectTimeout (request never sent:
            # nothing to release, POST may go to another instance), not the bare TimeoutError of the limit below.
            timeout = httpx.Timeout(limit, connect=min(CONNECT_TIMEOUT, limit / 2))

            async def attempt():
                async with asyncio.timeout(limit):
                    response = await self.client.request(method, url.rstrip("/") + path, headers=headers(caller),
                                                          timeout=timeout, **kwargs)
                if response.status_code >= 500 or response.status_code in (408, 429):
                    raise BadStatus(response.status_code)
                return response

            try:
                return await self.breakers[name].call(attempt)
            except CircuitOpen:
                unavailable(name, method, "CircuitOpen")
                raise Unavailable(name, "CircuitOpen") from None
            except (httpx.HTTPError, TimeoutError, BadStatus) as exc:
                reason = f"HTTP {exc.status}" if isinstance(exc, BadStatus) else type(exc).__name__
                not_connected = isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout))
                transient = isinstance(exc, (httpx.TransportError, TimeoutError)) or (
                    isinstance(exc, BadStatus) and exc.status in (502, 503, 504))
                if index < len(RETRY_DELAYS) and (not_connected or (safe and transient)):
                    delay = RETRY_DELAYS[index]
                    if deadline is None or loop.time() + delay + MIN_CALL_SECONDS <= deadline:
                        await asyncio.sleep(delay)
                        continue
                unavailable(name, method, reason)
                raise Unavailable(name, reason) from None
        raise AssertionError("unreachable")

    async def snapshot(self, caller, data, deadline: float) -> dict:
        """Cart, delivery price and current prices (step 1 of the purchase)."""
        response = await self.call("cart", "GET", "/cart", caller, deadline)
        if response.status_code != 200:
            raise rejected("cart", response)
        try:
            body = response.json()
            if isinstance(body, dict) and body.get("items") == []:
                raise HTTPException(409, {"error": "CART_EMPTY", "message": "Koszyk jest pusty"})
            cart = Cart.model_validate(body)
            if cart.userId != caller.user_id or len({x.productId for x in cart.items}) != len(cart.items):
                raise ValueError("invalid cart")
            response = await self.call("shipping", "GET", f"/shipping/methods/{data.shippingMethod}", caller,
                                       deadline)
            if response.status_code != 200:
                raise rejected("shipping", response)
            fee = DeliveryPrice.model_validate(response.json()).price
            total = Decimal(fee)
            items = []
            for line in cart.items:
                response = await self.call("product", "GET", f"/products/{line.productId}", caller, deadline)
                if response.status_code == 404:
                    raise HTTPException(409, {"error": "PRODUCT_UNAVAILABLE", "message": "Produkt został wycofany"})
                if response.status_code != 200:
                    raise rejected("product", response)
                product = Product.model_validate(response.json())
                if product.id != line.productId:
                    raise ValueError("invalid product")
                items.append(dict(productId=str(product.id), name=product.name,
                                  quantity=line.quantity, unitPrice=product.price))
                total += line.quantity * Decimal(product.price)
        except (ValidationError, ValueError) as exc:
            log.error("Response does not match the contract", extra={"fields": {"reason": type(exc).__name__}})
            raise Unavailable("cart/shipping/product", type(exc).__name__) from None
        return dict(items=items, total=format(total, ".2f"), currency="PLN", shippingCost=fee,
                    **data.model_dump(exclude={"payment"}))
