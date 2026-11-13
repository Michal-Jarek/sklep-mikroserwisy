"""Reguły biznesowe i granice transakcji profilu i adresów."""
from uuid import UUID
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
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

    def create(self, data: CreateUser) -> tuple[UserView, bool]:
        try:
            return self._create(data)
        except IntegrityError:
            # Concurrent Auth retries can race on the primary key. The losing
            # transaction reads the committed winner and applies the same rule.
            self.session.rollback()
            existing = self.repo.get(data.id)
            if existing is not None and (existing.first_name, existing.last_name, existing.email) == (data.first_name, data.last_name, data.email):
                return UserView.model_validate(existing), False
            raise HTTPException(409, "Profil o tym ID ma inne dane") from None

    def _create(self, data: CreateUser) -> tuple[UserView, bool]:
        with self.session.begin():
            existing = self.repo.get(data.id)
            if existing is not None:
                expected = (data.first_name, data.last_name, data.email)
                if (existing.first_name, existing.last_name, existing.email) != expected:
                    raise HTTPException(409, "Profil o tym ID ma inne dane")
                return UserView.model_validate(existing), False
            profile = UserProfile(id=data.id, first_name=data.first_name,
                                  last_name=data.last_name, email=data.email)
            self.session.add(profile)
            self.session.flush()  # Wymusza sprawdzenie ograniczeń UNIQUE przed odpowiedzią.
            result = UserView.model_validate(profile)
        return result, True

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
            # Serialize address additions per profile in PostgreSQL.
            if self.session.scalar(select(UserProfile).where(UserProfile.id == user_id).with_for_update()) is None:
                raise HTTPException(404, "Profil nie istnieje")
            if len(self.repo.addresses(user_id)) >= 50:
                raise HTTPException(409, "Maksymalnie 50 adresów")
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
