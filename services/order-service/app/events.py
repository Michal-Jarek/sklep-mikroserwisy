"""Incoming events (docs/events.md): envelope check and the effect of shipment.status_changed on the order.

parse_envelope() raises InvalidEvent for anything a retry cannot fix (the consumer rejects it to order.dlq at once).
handle() only works with the database; every exception there is temporary and is retried by the consumer.
"""
import json
import logging
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy.orm import Session, sessionmaker

from . import store
from .http_support import valid_request_id
from .models import Order

log = logging.getLogger("app.events")

SHIPMENT_STATUSES = ("PREPARING", "SHIPPED", "IN_TRANSIT", "DELIVERED", "CANCELLED")
# Order status after a shipment status, and the order statuses it may follow (statuses never go back).
ORDER_STATUS_AFTER = {"SHIPPED": ("SHIPPED", ("PAID",)), "DELIVERED": ("DELIVERED", ("PAID", "SHIPPED"))}


class InvalidEvent(ValueError):
    pass


@dataclass(frozen=True)
class Event:
    event_id: str
    type: str
    request_id: str
    order_id: str | None = None
    user_id: str | None = None
    new_status: str | None = None


def parse_envelope(body: bytes, routing_key: str | None) -> Event:
    try:
        event = json.loads(body)
    except ValueError:
        raise InvalidEvent("invalid JSON") from None
    if not isinstance(event, dict) or any(not isinstance(event.get(k), str)
                                          for k in ("type", "eventId", "requestId", "occurredAt")):
        raise InvalidEvent("envelope fields")
    try:
        event_id = str(UUID(event["eventId"]))
    except ValueError:
        raise InvalidEvent("eventId is not a UUID") from None
    if type(event.get("version")) is not int or event["version"] != 1 or not isinstance(event.get("payload"), dict):
        raise InvalidEvent("version or payload")
    # Broker permissions apply to the routing key, not to the body: only the key tells who could send the event.
    if routing_key != event["type"]:
        raise InvalidEvent("type differs from the routing key")
    request_id = valid_request_id(event["requestId"])
    if event["type"] != "shipment.status_changed":
        return Event(event_id, event["type"], request_id)
    payload = event["payload"]
    if payload.get("newStatus") not in SHIPMENT_STATUSES:
        raise InvalidEvent("newStatus")
    try:
        order_id, user_id = str(UUID(payload["orderId"])), str(UUID(payload["userId"]))
    except (KeyError, TypeError, ValueError, AttributeError):
        raise InvalidEvent("orderId or userId") from None
    return Event(event_id, event["type"], request_id, order_id, user_id, payload["newStatus"])


def handle(factory: sessionmaker, event: Event) -> str:
    """Applies the event and stores its eventId in one transaction.

    Returns "processed", "duplicate" (eventId seen before, no effect) or "ignored" (type not handled by Order).
    """
    if event.type != "shipment.status_changed":
        return "ignored"
    with factory.begin() as db:
        if not store.mark_processed(db, event.event_id):
            return "duplicate"
        apply_shipment_status(db, event)
    return "processed"


def apply_shipment_status(db: Session, event: Event) -> None:
    order = db.get(Order, event.order_id)
    if order is None or order.user_id != event.user_id:
        log.warning("Shipment status for an unknown order", extra={"fields": {
            "eventId": event.event_id, "type": event.type, "orderId": event.order_id}})
        return
    if event.new_status == "CANCELLED":
        # Self-repair: Shipping cancelled the shipment (POST /shipments/cancel), but the cancellation in Order
        # did not get saved. The conditional change keeps exactly one order.cancelled per order.
        if order.status in store.OPEN_STATES:
            store.transition(db, order, store.OPEN_STATES, "CANCELLED", "order.cancelled", event.request_id)
        return
    if order.status == "CANCELLED" and event.new_status in ("SHIPPED", "IN_TRANSIT", "DELIVERED"):
        log.error("Cancellation inconsistency: shipment dispatched for a cancelled order", extra={"fields": {
            "eventId": event.event_id, "type": event.type, "orderId": order.id, "newStatus": event.new_status}})
        return
    if event.new_status in ORDER_STATUS_AFTER:
        status, allowed = ORDER_STATUS_AFTER[event.new_status]
        if order.status in allowed:
            store.transition(db, order, allowed, status)
    # PREPARING and IN_TRANSIT do not change the order status.
