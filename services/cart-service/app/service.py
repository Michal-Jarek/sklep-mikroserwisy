"""Operacje koszyka: ceny, ilości, własność i optymistyczne współbieżne zmiany."""
from uuid import UUID
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
        items = await self.store.all(user_id)
        return CartView(user_id=user_id,
            items=[ItemView(**item.model_dump(), subtotal=money(cents(item.unit_price) * item.quantity)) for item in items],
            total=money(sum(cents(item.unit_price) * item.quantity for item in items)))

    async def change(self, caller: Caller, product_id: UUID, amount: int, *, add: bool) -> CartMutation:
        product = await self.catalog.product(product_id, caller)
        available = await self.catalog.available(product_id, caller)
        for _ in range(8):
            old = await self.store.raw(caller.user_id, product_id)
            if not add and old is None:
                raise HTTPException(404, "Pozycja nie istnieje w koszyku")
            previous = Item.model_validate_json(old).quantity if old else 0
            quantity = previous + amount if add else amount
            if quantity > 999:
                raise HTTPException(409, "Maksymalnie 999 sztuk produktu")
            if available is not None and quantity > available:
                raise HTTPException(409, "Brak wystarczającej liczby sztuk")
            item = Item(product_id=product_id, name=product.name, unit_price=product.price, quantity=quantity)
            if await self.store.compare_and_set(caller.user_id, product_id, old, item):
                cart = await self.get(caller.user_id)
                return CartMutation(**cart.model_dump(), inventory_checked=available is not None)
        raise HTTPException(409, "Koszyk zmienił się równolegle; ponów operację")

    async def remove(self, user_id: UUID, product_id: UUID) -> None:
        await self.store.remove(user_id, product_id)

    async def clear(self, user_id: UUID) -> None:
        await self.store.clear(user_id)
