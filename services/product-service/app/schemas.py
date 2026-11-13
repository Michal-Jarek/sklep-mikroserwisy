"""JSON of the API (docs/frontend-api.md, section Product): camelCase in JSON, snake_case in Python."""

import uuid
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator
from pydantic.alias_generators import to_camel

# Amount as text with two decimals, never a JSON number (D3).
PRICE_PATTERN = r"^[0-9]{1,8}\.[0-9]{2}$"
# Query filter: 10, 10.5 or 10.50 (frontend-api.md, GET /products).
PRICE_FILTER_PATTERN = r"^\d{1,8}(\.\d{1,2})?$"
SortOrder = Literal["NAME", "PRICE_ASC", "PRICE_DESC", "NEWEST"]


class DTO(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class ProductInput(DTO):
    """Body of POST and PUT /products (PUT replaces the whole product)."""

    # Unknown fields -> 400; text fields are trimmed before length checks (frontend-api.md, common rules).
    model_config = ConfigDict(alias_generator=to_camel, extra="forbid", str_strip_whitespace=True)

    name: Annotated[str, Field(min_length=1, max_length=200)]
    description: Annotated[str, Field(max_length=5000)] = ""
    price: Annotated[str, Field(pattern=PRICE_PATTERN)]
    currency: Literal["PLN"]
    category_id: uuid.UUID
    image_url: Annotated[str, StringConstraints(max_length=2000, pattern=r"^https://\S+$")] | None = None

    @field_validator("price")
    @classmethod
    def at_least_one_grosz(cls, value: str) -> str:
        if Decimal(value) < Decimal("0.01"):
            raise ValueError("price must be at least 0.01")
        return value


class CategoryView(DTO):
    id: uuid.UUID
    name: str


class Rating(DTO):
    average: float | None
    count: int


class Availability(DTO):
    available: int
    in_stock: bool


class ProductSummary(DTO):
    id: uuid.UUID
    name: str
    price: str
    currency: str
    category_id: uuid.UUID
    image_url: str | None


class ProductDetail(DTO):
    id: uuid.UUID
    name: str
    description: str
    price: str
    currency: str
    category: CategoryView
    image_url: str | None
    # null: Review / Inventory unavailable, or a call with role SERVICE (D4).
    rating: Rating | None
    availability: Availability | None
    created_at: str
    updated_at: str


class ProductPage(DTO):
    items: list[ProductSummary]
    page: int
    size: int
    total: int
