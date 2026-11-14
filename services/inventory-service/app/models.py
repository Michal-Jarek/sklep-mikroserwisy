from datetime import datetime, timezone

from sqlalchemy import CheckConstraint, DateTime, Integer, String, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

ACTIVE = "ACTIVE"
RELEASED = "RELEASED"
ISSUED = "ISSUED"  # towar wydany przy wysyłce


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class InventoryItem(Base):
    """Stan magazynowy produktu. Dostępne = quantity - reserved."""

    __tablename__ = "inventory_items"
    __table_args__ = (
        CheckConstraint("quantity >= 0", name="ck_inventory_quantity_nonneg"),
        CheckConstraint("reserved >= 0", name="ck_inventory_reserved_nonneg"),
        CheckConstraint("reserved <= quantity", name="ck_inventory_reserved_le_quantity"),
    )

    product_id: Mapped[str] = mapped_column(String(36), primary_key=True)  # UUID zapisany tekstem
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    reserved: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)

    @property
    def available(self) -> int:
        return self.quantity - self.reserved


class Reservation(Base):
    """Rezerwacja towaru dla jednego zamówienia (jeden wiersz na produkt)."""

    __tablename__ = "reservations"
    __table_args__ = (UniqueConstraint("order_id", "product_id", name="uq_reservation_order_product"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    order_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    product_id: Mapped[str] = mapped_column(String(36), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=ACTIVE)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class ProcessedEvent(Base):
    """Identyfikatory przetworzonych zdarzeń RabbitMQ (idempotencja konsumenta)."""

    __tablename__ = "processed_events"

    event_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    processed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
