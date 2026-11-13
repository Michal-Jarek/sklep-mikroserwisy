from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import JSON, Column, Integer, String
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class Shipment(Base):
    __tablename__ = "shipments"
    order_id = Column(String(36), primary_key=True)
    user_id = Column(String(36), nullable=False, index=True)
    # An early cancellation needs only an order reference, never a shipping label.
    id = Column(String(36), unique=True)
    tracking = Column(String(34), unique=True)
    status = Column(String(16), nullable=False)
    destination = Column(JSON)
    method = Column(String(24))
    cost = Column(String(20))
    currency = Column(String(3))


class History(Base):
    __tablename__ = "shipping_history"
    seq = Column(Integer, primary_key=True)
    shipment_id = Column(String(36), nullable=False, index=True)
    status = Column(String(16), nullable=False)
    at = Column(String(32), nullable=False)


class Processed(Base):
    __tablename__ = "shipping_processed"
    id = Column(String(36), primary_key=True)


class Outbox(Base):
    __tablename__ = "shipping_outbox"
    seq = Column(Integer, primary_key=True)
    envelope = Column(JSON, nullable=False)


def change_status(db, shipment, target, request_id):
    previous = shipment.status
    shipment.status = target
    at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    db.add(History(shipment_id=shipment.id, status=target, at=at))
    db.add(Outbox(envelope={
        "eventId": str(uuid4()), "version": 1, "type": "shipment.status_changed",
        "occurredAt": at,
        "requestId": request_id, "payload": {
            "shipmentId": shipment.id, "orderId": shipment.order_id, "userId": shipment.user_id,
            "oldStatus": previous, "newStatus": target, "trackingNumber": shipment.tracking,
        },
    }))
