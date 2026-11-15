"""Tables created at start (create_all does not change existing tables: a changed column needs a new table name)."""
from sqlalchemy import JSON, Column, DateTime, Integer, String, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (UniqueConstraint("user_id", "checkout_key"),)
    id = Column(String(36), primary_key=True)
    user_id = Column(String(36), nullable=False, index=True)
    checkout_key = Column(String(36), nullable=False)
    status = Column(String(30), nullable=False)
    snapshot = Column(JSON, nullable=False)
    # A purchase attempt in progress owns the NEW order until this time (instead of a row lock held during calls
    # to other services); a second request with the same Idempotency-Key gets 503 until then.
    attempt_until = Column(DateTime(timezone=True))


class Outbox(Base):
    __tablename__ = "outbox_events"
    seq = Column(Integer, primary_key=True)
    envelope = Column(JSON, nullable=False)
    # Lease of the relay that took the row; empty or past = free to send.
    locked_until = Column(DateTime(timezone=True))


class Processed(Base):
    __tablename__ = "order_processed"
    id = Column(String(36), primary_key=True)
