"""DTO Pydantic: camelCase w JSON, snake_case wewnątrz Pythona."""
from typing import Annotated
from uuid import UUID
from pydantic import BaseModel, ConfigDict, EmailStr, Field, StringConstraints
from pydantic.alias_generators import to_camel

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]

class DTO(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True,
                             from_attributes=True, extra="forbid")

class CreateUser(DTO):
    id: UUID
    first_name: Name
    last_name: Name
    email: Annotated[EmailStr, Field(max_length=254)]

class UpdateUser(DTO):
    first_name: Name
    last_name: Name
    # E-mail jest zarządzany przez Auth; jego zmiana wymaga osobnego przepływu.

class UserView(DTO):
    id: UUID
    first_name: str
    last_name: str
    email: str

class AddressInput(DTO):
    street: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    city: Name
    postal_code: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=20)]
    country_code: Annotated[str, Field(pattern=r"^[A-Z]{2}$")]

class AddressView(AddressInput):
    id: UUID
