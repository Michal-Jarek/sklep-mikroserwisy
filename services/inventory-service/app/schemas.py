from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.ids import ProductId


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class StockOut(CamelModel):
    product_id: str
    quantity: int
    reserved: int
    available: int
    in_stock: bool


class StockIn(CamelModel):
    model_config = ConfigDict(extra="forbid")  # nieznane pola w treści to 400

    quantity: int = Field(ge=0, le=1_000_000)


class ReservationItem(CamelModel):
    product_id: ProductId
    quantity: int = Field(gt=0, le=10_000)


class ReservationIn(CamelModel):
    order_id: str = Field(min_length=1, max_length=64)
    items: list[ReservationItem] = Field(min_length=1, max_length=100)


class ReservationOut(CamelModel):
    order_id: str
    status: str
    items: list[ReservationItem]
