from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Price = Annotated[str, Field(pattern=r"^[0-9]{1,8}\.[0-9]{2}$")]


class Address(BaseModel):
    model_config = ConfigDict(extra="forbid")
    firstName: Annotated[Text, Field(max_length=100)]
    lastName: Annotated[Text, Field(max_length=100)]
    street: Text
    postalCode: Annotated[Text, Field(max_length=20)]
    city: Annotated[Text, Field(max_length=100)]
    countryCode: Annotated[str, Field(pattern="^[A-Z]{2}$")]


class Payment(BaseModel):
    cardNumber: Annotated[str, Field(pattern=r"^[0-9]{12,19}$", repr=False)]


class Checkout(BaseModel):
    model_config = ConfigDict(extra="forbid")
    shippingAddress: Address
    shippingMethod: Literal["COURIER", "PARCEL_LOCKER", "PICKUP"]
    payment: Payment


class CartItem(BaseModel):
    productId: UUID
    quantity: Annotated[int, Field(strict=True, ge=1, le=999)]


class Cart(BaseModel):
    userId: UUID
    items: Annotated[list[CartItem], Field(min_length=1)]


class Product(BaseModel):
    id: UUID
    name: Text
    price: Price
    currency: Literal["PLN"]
