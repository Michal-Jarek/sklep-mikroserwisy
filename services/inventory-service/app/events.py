"""Obsługa zdarzeń RabbitMQ (koperta: eventId, type, occurredAt, version, payload)."""
import logging

from app import db as database
from app import service

logger = logging.getLogger(__name__)


def handle_event(envelope: dict) -> None:
    """Przetwarza jedno zdarzenie. Wyjątek oznacza ponowienie (a po limicie prób - kolejkę błędów)."""
    if not isinstance(envelope, dict):
        raise ValueError("Zdarzenie musi być obiektem JSON")

    event_type = envelope.get("type")
    if event_type != "order.cancelled":
        logger.info("Pomijam zdarzenie typu %s", event_type)
        return

    event_id = envelope.get("eventId")
    order_id = (envelope.get("payload") or {}).get("orderId")
    if not event_id or order_id in (None, ""):
        raise ValueError("Zdarzenie order.cancelled bez eventId lub payload.orderId")

    with database.session_scope() as db:
        released = service.release(db, str(order_id), str(event_id))
    logger.info("order.cancelled: zwolniono %s pozycji rezerwacji (zdarzenie %s)", released, event_id)
