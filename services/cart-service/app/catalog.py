"""REST do katalogu i magazynu: discovery, timeout, retry i fallback."""
import asyncio
from typing import Annotated
from uuid import UUID
import httpx
from fastapi import HTTPException
from pydantic import BaseModel, Field, StrictInt
from .circuit_breaker import CircuitBreaker, ResourceMissing
from .config import Settings
from .discovery import Discovery
from .schemas import Price
from .security import Caller

class Product(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=200, pattern=r".*\S.*")]
    price: Price

class Inventory(BaseModel):
    available: Annotated[StrictInt, Field(ge=0)]

class CatalogClient:
    def __init__(self, client: httpx.AsyncClient, discovery: Discovery, settings: Settings):
        self.client = client
        self.discovery = discovery
        self.overrides = {"product-service": settings.product_service_url,
                          "inventory-service": settings.inventory_service_url}
        self.breakers = {name: CircuitBreaker() for name in self.overrides}

    async def fetch(self, name: str, path: str, caller: Caller, schema: type[BaseModel]):
        for attempt in range(3):
            try:
                base = self.overrides[name] or await self.discovery.resolve(name)
                # wait_for obejmuje cały GET, httpx dodatkowo ogranicza etapy transportu.
                response = await asyncio.wait_for(self.client.get(base.rstrip("/") + path, headers={
                    "X-User-Id": str(caller.user_id),
                    "X-User-Roles": ",".join(sorted(caller.roles | {"SERVICE"})),
                    "X-Request-Id": caller.request_id,
                }), timeout=2)
                if response.status_code == 404:
                    raise ResourceMissing()
                response.raise_for_status()
                return schema.model_validate(response.json())
            except ResourceMissing:
                raise
            except Exception:
                if attempt == 2:
                    raise
                await asyncio.sleep(0.1 * 2 ** attempt)

    async def product(self, product_id: UUID, caller: Caller) -> Product:
        try:
            return await self.breakers["product-service"].call(
                lambda: self.fetch("product-service", f"/products/{product_id}", caller, Product))
        except ResourceMissing:
            raise HTTPException(404, "Produkt nie istnieje") from None
        except Exception:
            raise HTTPException(503, "Nie można pobrać aktualnej ceny produktu") from None

    async def available(self, product_id: UUID, caller: Caller) -> int | None:
        try:
            result = await self.breakers["inventory-service"].call(
                lambda: self.fetch("inventory-service", f"/inventory/{product_id}", caller, Inventory))
            return result.available
        except Exception:
            # Order sprawdzi stan i zarezerwuje towar; koszyk może poczekać.
            return None
