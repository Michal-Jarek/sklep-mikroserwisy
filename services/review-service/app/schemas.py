from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

from app.ids import UuidText


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class ReviewCreate(CamelModel):
    model_config = ConfigDict(extra="forbid")  # nieznane pola w treści to 400

    product_id: UuidText  # zapisywany małymi literami
    rating: int = Field(ge=1, le=5, strict=True)  # strict: 4.0, "4" i true to 400
    comment: str | None = Field(default=None, max_length=2000)

    @field_validator("comment")
    @classmethod
    def blank_comment_is_none(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None


class ReviewOut(CamelModel):
    id: str
    product_id: str
    user_id: str
    rating: int
    comment: str | None
    created_at: datetime


class ReviewPage(CamelModel):
    items: list[ReviewOut]
    page: int
    size: int
    total: int


class ReviewSummary(CamelModel):
    product_id: str
    average_rating: float | None
    review_count: int
