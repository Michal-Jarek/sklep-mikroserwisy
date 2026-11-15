"""Incoming events: envelope rules (docs/events.md) and their effect in shipping_db."""
import json
import logging
import re
from typing import Annotated, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .models import Processed, Shipment, change_status

log = logging.getLogger("shipping.events")
Text = Annotated[str, Field(min_length=1, max_length=200)]
REQUEST_ID = re.compile(r"[A-Za-z0-9._-]{1,64}")  # the same rule as X-Request-Id in the Gateway
DISPATCHED = ("SHIPPED", "IN_TRANSIT", "DELIVERED")


class InvalidEvent(ValueError):
    """A message that will never succeed: it goes to the DLQ at once, without retries."""

    def __init__(self, reason: str, event_id: str | None = None, request_id: str | None = None):
        super().__init__(reason)
        self.event_id = event_id
        self.request_id = request_id


class Address(BaseModel):
    firstName: Text
    lastName: Text
    street: Text
    city: Text
    postalCode: Text
    countryCode: Annotated[str, Field(pattern="^[A-Z]{2}$")]


class Creation(BaseModel):
    orderId: UUID
    userId: UUID
    shippingMethod: Literal["COURIER", "PARCEL_LOCKER", "PICKUP"]
    shippingCost: Annotated[str, Field(pattern=r"^[0-9]+\.[0-9]{2}$")]
    currency: Literal["PLN"]
    shippingAddress: Address


class Reference(BaseModel):
    orderId: UUID
    userId: UUID


def parse_envelope(body: bytes, routing_key: str) -> dict:
    """Checks the envelope; every problem raises InvalidEvent. Returns it with eventId and requestId normalized."""
    try:
        event = json.loads(body)
    except (ValueError, TypeError):
        raise InvalidEvent("body is not JSON") from None
    if not isinstance(event, dict):
        raise InvalidEvent("envelope is not an object")
    request_id = event.get("requestId")
    if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
        request_id = str(uuid4())
    raw_id = event.get("eventId")
    try:
        event_id = str(UUID(raw_id))
    except (ValueError, TypeError, AttributeError):
        raise InvalidEvent("eventId is not a UUID", str(raw_id)[:64] if raw_id is not None else None,
                           request_id) from None
    if (event.get("type") != routing_key or type(event.get("version")) is not int or event["version"] != 1
            or not isinstance(event.get("occurredAt"), str) or not isinstance(event.get("payload"), dict)):
        raise InvalidEvent("invalid envelope", event_id, request_id)
    return {**event, "eventId": event_id, "requestId": request_id}


def handle(factory, event: dict) -> tuple[str, str | None]:
    """Applies one event in a single transaction together with its eventId (idempotent).

    Returns (outcome, orderId); outcome is "processed", "duplicate" (eventId seen before) or "ignored" (other type).
    """
    key = event["type"]
    if key not in ("order.created", "order.cancelled"):
        return "ignored", None
    try:
        model = Creation if key == "order.created" else Reference
        data = model.model_validate(event["payload"])
    except ValidationError:
        raise InvalidEvent("invalid payload", event["eventId"]) from None
    creation = data if key == "order.created" else None
    order_id, user_id = str(data.orderId), str(data.userId)

    with factory.begin() as db:
        insert = sqlite_insert if db.get_bind().dialect.name == "sqlite" else pg_insert
        # RETURNING, not rowcount: SQLAlchemy with psycopg reports rowcount -1 for this insert (also on conflict).
        new = db.scalar(insert(Processed).values(id=event["eventId"]).on_conflict_do_nothing(index_elements=["id"])
                        .returning(Processed.id))
        if new is None:
            return "duplicate", order_id
        # Creating a row before locking also serializes creation vs. cancellation of a new order.
        db.execute(insert(Shipment).values(order_id=order_id, user_id=user_id, status="NEW")
                   .on_conflict_do_nothing(index_elements=["order_id"]))
        shipment = db.scalar(select(Shipment).where(Shipment.order_id == order_id).with_for_update())
        if shipment.user_id is None:
            shipment.user_id = user_id  # placeholder written by POST /shipments/cancel
        elif shipment.user_id != user_id:
            raise InvalidEvent("inconsistent userId for order", event["eventId"])
        if creation and shipment.status == "NEW":
            shipment.id = str(uuid4())
            shipment.destination = creation.shippingAddress.model_dump()
            shipment.method = creation.shippingMethod
            shipment.cost = creation.shippingCost
            shipment.currency = creation.currency
            shipment.status = None  # First public state has no predecessor.
            change_status(db, shipment, "PREPARING", event["requestId"])
        elif creation and shipment.status == "CANCELLED" and shipment.id is None:
            # Z10: cancelled before the shipment existed (placeholder). The shipment is created as CANCELLED with one
            # event null -> CANCELLED, so Order cancels the order if it missed the answer of POST /shipments/cancel.
            # No delivery address is kept for a parcel that will never be sent.
            shipment.id = str(uuid4())
            shipment.method = creation.shippingMethod
            shipment.cost = creation.shippingCost
            shipment.currency = creation.currency
            shipment.status = None
            change_status(db, shipment, "CANCELLED", event["requestId"])
        elif not creation:
            if shipment.status == "NEW":
                shipment.status = "CANCELLED"
            elif shipment.status == "PREPARING":
                change_status(db, shipment, "CANCELLED", event["requestId"])
            elif shipment.status in DISPATCHED:
                # With POST /shipments/cancel (Order asks first) this should never happen.
                log.error("Cancellation inconsistency: order.cancelled for a dispatched shipment, ignored",
                          extra={"fields": {"eventId": event["eventId"], "type": key, "orderId": order_id,
                                            "status": shipment.status}})
    return "processed", order_id
