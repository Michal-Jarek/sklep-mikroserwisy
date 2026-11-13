from sqlalchemy import JSON, Column, Integer, String, UniqueConstraint
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


class Outbox(Base):
    __tablename__ = "order_outbox"
    seq = Column(Integer, primary_key=True)
    envelope = Column(JSON, nullable=False)


class Processed(Base):
    __tablename__ = "order_processed"
    id = Column(String(36), primary_key=True)
