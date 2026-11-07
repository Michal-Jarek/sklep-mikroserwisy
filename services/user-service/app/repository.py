"""Zapytania do własnej bazy; brak SQL składanego z danych klienta."""
from uuid import UUID
from sqlalchemy import select
from sqlalchemy.orm import Session
from .models import Address, UserProfile

class ProfileRepository:
    def __init__(self, session: Session):
        self.session = session

    def get(self, user_id: UUID) -> UserProfile | None:
        return self.session.get(UserProfile, user_id)

    def addresses(self, user_id: UUID) -> list[Address]:
        return list(self.session.scalars(select(Address).where(Address.user_id == user_id).order_by(Address.id)))

    def owned_address(self, user_id: UUID, address_id: UUID) -> Address | None:
        return self.session.scalar(select(Address).where(Address.id == address_id, Address.user_id == user_id))
