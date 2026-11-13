"""Bounded parallel REST reads; only transient transport failures are retried."""
import asyncio
import json
import logging
from typing import Annotated, Literal
from uuid import UUID
import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field, StrictInt, ValidationError
from .circuit_breaker import CircuitBreaker, ResourceMissing, ContractError
from .config import Settings
from .discovery import Discovery
from .schemas import Price
from .security import Caller

logger = logging.getLogger("shop.catalog")

class Product(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=200, pattern=r".*\S.*")]
    price: Price
    currency: Literal["PLN"]

class Inventory(BaseModel):
    available: Annotated[StrictInt, Field(ge=0)]

class CatalogClient:
    def __init__(self, client: httpx.AsyncClient, discovery: Discovery, settings: Settings):
        self.client = client
        self.discovery = discovery
        self.overrides = {"product-service": settings.product_service_url,
                          "inventory-service": settings.inventory_service_url}
        self.breakers = {name: CircuitBreaker() for name in self.overrides}

    async def fetch(self, name, path, caller, schema):
        # Discovery is outside the retry loop: at most 2 s, then 3 x 2 s + 0.6 s.
        base = self.overrides[name] or await self.discovery.resolve(name)
        for attempt in range(3):
            try:
                response = await asyncio.wait_for(self.client.get(base.rstrip("/") + path, headers={
                    "X-User-Id": str(caller.user_id),
                    "X-User-Roles": ",".join(sorted(caller.roles | {"SERVICE"})),
                    "X-Request-Id": caller.request_id,
                }), timeout=2)
            except (httpx.TransportError, TimeoutError):
                if not self.overrides[name]:
                    self.discovery.reject(name, base)
                if attempt == 2:
                    raise
            else:
                if response.status_code == 404:
                    raise ResourceMissing()
                if response.status_code in {502, 503, 504}:
                    if attempt == 2:
                        response.raise_for_status()
                elif response.status_code >= 500 or response.status_code in {408, 429}:
                    # These count as failures, but D2 does not permit retries.
                    response.raise_for_status()
                elif not 200 <= response.status_code < 300:
                    raise ContractError()
                else:
                    try:
                        return schema.model_validate(response.json())
                    except (ValueError, ValidationError) as exc:
                        raise ContractError() from exc
            await asyncio.sleep(0.2 * 2 ** attempt)
            if not self.overrides[name]:
                base = await self.discovery.resolve(name)

    def log_failure(self, name, caller, exc):
        logger.warning(json.dumps({"message": "Upstream read failed", "targetService": name,
            "errorType": type(exc).__name__, "userId": str(caller.user_id), "requestId": caller.request_id}))

    async def product(self, product_id: UUID, caller: Caller) -> Product:
        try:
            return await self.breakers["product-service"].call(
                lambda: self.fetch("product-service", f"/products/{product_id}", caller, Product))
        except ResourceMissing:
            raise HTTPException(404, "Produkt nie istnieje") from None
        except Exception as exc:
            self.log_failure("product-service", caller, exc)
            raise HTTPException(503, "Nie można pobrać aktualnej ceny produktu") from None

    async def available(self, product_id: UUID, caller: Caller) -> int | None:
        try:
            result = await self.breakers["inventory-service"].call(
                lambda: self.fetch("inventory-service", f"/inventory/{product_id}", caller, Inventory))
            return result.available
        except ResourceMissing:
            # A missing inventory record means zero available stock (N11).
            return 0
        except Exception as exc:
            self.log_failure("inventory-service", caller, exc)
            return None
