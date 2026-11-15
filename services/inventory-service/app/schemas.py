from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.ids import UuidText


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

    quantity: int = Field(ge=0, le=1_000_000, strict=True)  # strict: true i "10" to 400


class ReservationItem(CamelModel):
    model_config = ConfigDict(extra="forbid")

    product_id: UuidText
    quantity: int = Field(gt=0, le=10_000, strict=True)


class ReservationIn(CamelModel):
    model_config = ConfigDict(extra="forbid")

    order_id: UuidText  # zapisywany małymi literami: ten sam UUID wielkimi literami to ta sama rezerwacja
    items: list[ReservationItem] = Field(min_length=1, max_length=100)


class ReservationOut(CamelModel):
    order_id: str
    status: str
    items: list[ReservationItem]
