import asyncio
from decimal import Decimal

import httpx
from fastapi import HTTPException
from pydantic import ValidationError

from .circuit_breaker import CircuitBreaker, CircuitOpen
from pydantic import BaseModel
from typing import Literal
from .schemas import Cart, Product, Price


class DeliveryPrice(BaseModel):
    price: Price
    currency: Literal["PLN"]


class Peers:
    def __init__(self, client, discovery, settings):
        self.client = client
        self.discovery = discovery
        self.urls = {"shipping": settings.shipping_service_url, "cart": settings.cart_service_url, "inventory": settings.inventory_service_url,
                     "product": settings.product_service_url}
        self.breakers = {name: CircuitBreaker() for name in self.urls}

    async def call(self, name, method, path, caller, **kwargs):
        async def attempt():
            async with asyncio.timeout(2):
                url = self.urls[name] or await self.discovery.resolve(name + "-service")
                response = await self.client.request(method, url.rstrip("/") + path,
                    headers={"X-User-Roles": ",".join(sorted(caller.roles | {"SERVICE"})), "X-User-Id": str(caller.user_id),
                             "X-Request-Id": caller.request_id}, **kwargs)
                if response.status_code >= 500 or response.status_code in (408, 429):
                    response.raise_for_status()
                return response

        for index in range(3):
            try:
                result = await self.breakers[name].call(attempt)
            except (RuntimeError, CircuitOpen, httpx.HTTPError, TimeoutError) as exc:
                retry = isinstance(exc, (httpx.TransportError, TimeoutError)) or (
                    isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in (502, 503, 504))
                if method == "GET" and index < 2 and retry:
                    await asyncio.sleep(0.2 * (index + 1))
                    continue
                raise HTTPException(503, f"Usługa {name} niedostępna") from None
            if not result.is_success:
                if name == "product" and result.status_code == 404:
                    raise HTTPException(409, {"error": "PRODUCT_UNAVAILABLE", "message": "Produkt został wycofany"})
                if name == "inventory" and result.status_code in (404, 409):
                    raise HTTPException(409, {"error": "INSUFFICIENT_STOCK", "message": "Brak zapasu"})
                code = result.status_code if result.status_code in (400, 404, 409) else 503
                raise HTTPException(code, f"Usługa {name} odrzuciła żądanie")
            return result

    async def snapshot(self, caller, data):
        raw = await self.call("cart", "GET", "/cart", caller)
        try:
            body = raw.json()
            if isinstance(body, dict) and body.get("items") == []:
                raise HTTPException(409, {"error":"CART_EMPTY", "message":"Koszyk jest pusty"})
            cart = Cart.model_validate(body)
            if cart.userId != caller.user_id or len({x.productId for x in cart.items}) != len(cart.items):
                raise ValueError("invalid cart")
            items = []
            delivery = await self.call("shipping", "GET", f"/shipping/methods/{data.shippingMethod}", caller)
            fee = DeliveryPrice.model_validate(delivery.json()).price
            total = Decimal(fee)
            for line in cart.items:
                response = await self.call("product", "GET", f"/products/{line.productId}", caller)
                product = Product.model_validate(response.json())
                if product.id != line.productId:
                    raise ValueError("invalid product")
                items.append(dict(productId=str(product.id), name=product.name,
                                  quantity=line.quantity, unitPrice=product.price))
                total += line.quantity * Decimal(product.price)
        except (ValidationError, ValueError) as exc:
            raise HTTPException(503, "Niepoprawna odpowiedź koszyka lub katalogu") from exc
        return dict(items=items, total=format(total, ".2f"), currency="PLN", shippingCost=fee,
                    **data.model_dump(exclude={"payment"}))
