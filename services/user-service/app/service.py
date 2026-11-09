"""Reguły biznesowe i granice transakcji profilu i adresów."""
from uuid import UUID
from fastapi import HTTPException
from sqlalchemy.orm import Session
from .models import Address, UserProfile
from .repository import ProfileRepository
from .schemas import AddressInput, AddressView, CreateUser, UpdateUser, UserView

class ProfileService:
    def __init__(self, session: Session):
        self.session = session
        self.repo = ProfileRepository(session)

    def require(self, user_id: UUID) -> UserProfile:
        profile = self.repo.get(user_id)
        if profile is None:
            raise HTTPException(404, "Profil nie istnieje")
        return profile

    def get(self, user_id: UUID) -> UserView:
        return UserView.model_validate(self.require(user_id))

    def create(self, data: CreateUser) -> UserView:
        with self.session.begin():
            if self.repo.get(data.id) is not None:
                raise HTTPException(409, "Profil już istnieje")
            profile = UserProfile(id=data.id, first_name=data.first_name,
                                  last_name=data.last_name, email=str(data.email).lower())
            self.session.add(profile)
            self.session.flush()  # Wymusza sprawdzenie ograniczeń UNIQUE przed odpowiedzią.
            result = UserView.model_validate(profile)
        return result

    def update(self, user_id: UUID, data: UpdateUser) -> UserView:
        with self.session.begin():
            profile = self.require(user_id)
            profile.first_name = data.first_name
            profile.last_name = data.last_name
            result = UserView.model_validate(profile)
        return result

    def addresses(self, user_id: UUID) -> list[AddressView]:
        self.require(user_id)
        return [AddressView.model_validate(item) for item in self.repo.addresses(user_id)]

    def add_address(self, user_id: UUID, data: AddressInput) -> AddressView:
        with self.session.begin():
            self.require(user_id)
            address = Address(user_id=user_id, **data.model_dump())
            self.session.add(address)
            self.session.flush()
            result = AddressView.model_validate(address)
        return result

    def delete_address(self, user_id: UUID, address_id: UUID) -> None:
        with self.session.begin():
            self.require(user_id)
            address = self.repo.owned_address(user_id, address_id)
            if address is None:
                raise HTTPException(404, "Adres nie istnieje")
            self.session.delete(address)
