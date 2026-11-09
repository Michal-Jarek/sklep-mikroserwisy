"""Kontrakt JSON i obliczenia pieniężne bez liczb zmiennoprzecinkowych."""
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, StrictInt
from pydantic.alias_generators import to_camel

Quantity = Annotated[StrictInt, Field(ge=1, le=999)]
Price = Annotated[str, Field(pattern=r"^[0-9]{1,8}\.[0-9]{2}$")]

class DTO(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")

class AddItem(DTO):
    product_id: UUID
    quantity: Quantity

class ChangeQuantity(DTO):
    quantity: Quantity

class Item(DTO):
    product_id: UUID
    name: Annotated[str, Field(min_length=1, max_length=200)]
    unit_price: Price
    quantity: Quantity

class ItemView(Item):
    subtotal: str

class CartView(DTO):
    user_id: UUID
    currency: Literal["PLN"] = "PLN"
    items: list[ItemView]
    total: str

class CartMutation(CartView):
    inventory_checked: bool


def cents(price: str) -> int:
    return int(Decimal(price) * 100)


def money(value: int) -> str:
    return format(Decimal(value) / 100, ".2f")
