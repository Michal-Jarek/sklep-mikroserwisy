"""Operacje koszyka: ceny, ilości, własność i optymistyczne współbieżne zmiany."""
import asyncio
import random
from uuid import UUID
from pydantic import ValidationError
from fastapi import HTTPException
from .catalog import CatalogClient
from .schemas import CartMutation, CartView, Item, ItemView, cents, money
from .security import Caller
from .store import CartStore

class CartService:
    def __init__(self, store: CartStore, catalog: CatalogClient):
        self.store = store
        self.catalog = catalog

    async def get(self, user_id: UUID) -> CartView:
        try:
            items = await self.store.all(user_id)
        except ValidationError:
            raise HTTPException(503, "Zapis koszyka jest niepoprawny") from None
        return self.view(user_id, items)

    def view(self, user_id, items):
        return CartView(user_id=user_id,
            items=[ItemView(**item.model_dump(), subtotal=money(cents(item.unit_price) * item.quantity)) for item in items],
            total=money(sum(cents(item.unit_price) * item.quantity for item in items)))

    async def change(self, caller: Caller, product_id: UUID, amount: int, *, add: bool) -> CartMutation:
        try:
            return await asyncio.wait_for(self._change(caller, product_id, amount, add=add), timeout=8)
        except TimeoutError:
            raise HTTPException(503, "Przekroczono czas zmiany koszyka") from None

    async def _change(self, caller: Caller, product_id: UUID, amount: int, *, add: bool) -> CartMutation:
        if not add and await self.store.raw(caller.user_id, product_id) is None:
            raise HTTPException(404, "Pozycja nie istnieje w koszyku")
        # Explicit total deadline also covers discovery, retries and cancelled peers.
        async def dependencies():
            async with asyncio.TaskGroup() as group:
                product = group.create_task(self.catalog.product(product_id, caller))
                stock = group.create_task(self.catalog.available(product_id, caller))
            return product.result(), stock.result()
        try:
            product, available = await asyncio.wait_for(dependencies(), timeout=8)
        except ExceptionGroup as group:
            for exc in group.exceptions:
                if isinstance(exc, HTTPException):
                    raise exc
            raise HTTPException(503, "Zależność koszyka jest niedostępna") from None
        except TimeoutError:
            raise HTTPException(503, "Przekroczono czas odczytu zależności") from None
        for attempt in range(64):
            snapshot = await self.store.snapshot(caller.user_id)
            try:
                items = {key: Item.model_validate_json(value) for key, value in snapshot.items()}
                if any(str(item.product_id) != key for key, item in items.items()):
                    raise ValueError("Inconsistent item key")
            except (ValueError, ValidationError):
                raise HTTPException(503, "Zapis koszyka jest niepoprawny") from None
            old = snapshot.get(str(product_id))
            if not add and old is None:
                raise HTTPException(404, "Pozycja nie istnieje w koszyku")
            previous = Item.model_validate_json(old).quantity if old else 0
            quantity = previous + amount if add else amount
            if quantity > 999:
                raise HTTPException(409, "Maksymalnie 999 sztuk produktu")
            if available is not None and quantity > available:
                raise HTTPException(409, "Brak wystarczającej liczby sztuk")
            item = Item(product_id=product_id, name=product.name, unit_price=product.price, quantity=quantity)
            items[str(product_id)] = item
            # Validate/build the entire response before committing. CAS checks the whole
            # snapshot so a corrupt concurrent entry cannot cause a write followed by 500.
            cart = self.view(caller.user_id, sorted(items.values(), key=lambda item: str(item.product_id)))
            if await self.store.compare_and_set(caller.user_id, product_id, old, item, snapshot):
                return CartMutation(**cart.model_dump(), inventory_checked=available is not None)
            await asyncio.sleep(random.uniform(0.001, min(0.02, 0.001 * (attempt + 1))))
        raise HTTPException(409, "Koszyk zmienił się równolegle; ponów operację")

    async def remove(self, user_id: UUID, product_id: UUID) -> None:
        await self.store.remove(user_id, product_id)

    async def clear(self, user_id: UUID) -> None:
        await self.store.clear(user_id)
