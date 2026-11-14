"""Zdarzenia RabbitMQ (koperta: eventId, type, occurredAt, version, payload, requestId).

parse_envelope() sprawdza kopertę; każda niezgodność to InvalidEvent, czyli odrzucenie bez ponowień.
handle_event() zakłada poprawną kopertę; wyjątek z niego oznacza błąd chwilowy (ponowienie).
W logach nie ma danych z payload.
"""
import json
import logging

from app import db as database
from app import service

logger = logging.getLogger(__name__)

ORDER_CANCELLED = "order.cancelled"
SHIPMENT_STATUS_CHANGED = "shipment.status_changed"
SUPPORTED_VERSIONS = {1}


class InvalidEvent(Exception):
    """Zdarzenie z błędną kopertą - nie ma sensu go ponawiać."""


def _is_text(value) -> bool:
    return isinstance(value, str) and value != ""


def parse_envelope(body: bytes, routing_key: str | None) -> dict:
    try:
        envelope = json.loads(body)
    except ValueError:
        raise InvalidEvent("niepoprawny JSON")
    if not isinstance(envelope, dict):
        raise InvalidEvent("koperta nie jest obiektem")

    if not _is_text(envelope.get("eventId")):
        raise InvalidEvent("eventId musi być niepustym tekstem")
    event_type = envelope.get("type")
    if not _is_text(event_type):
        raise InvalidEvent("type musi być niepustym tekstem")
    version = envelope.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version not in SUPPORTED_VERSIONS:
        raise InvalidEvent("nieznana wersja zdarzenia")
    # chroni przed podsunięciem zdarzenia innego typu pod cudzym kluczem routingu
    if event_type != routing_key:
        raise InvalidEvent("type różny od klucza routingu")
    if envelope.get("requestId") is not None and not isinstance(envelope["requestId"], str):
        raise InvalidEvent("requestId musi być tekstem")

    payload = envelope.get("payload")
    if not isinstance(payload, dict):
        raise InvalidEvent("payload musi być obiektem")
    if event_type in (ORDER_CANCELLED, SHIPMENT_STATUS_CHANGED) and not _is_text(payload.get("orderId")):
        raise InvalidEvent("payload.orderId musi być niepustym tekstem")
    if event_type == SHIPMENT_STATUS_CHANGED and not _is_text(payload.get("newStatus")):
        raise InvalidEvent("payload.newStatus musi być niepustym tekstem")
    return envelope


def handle_event(envelope: dict) -> None:
    event_type = envelope["type"]
    event_id = envelope["eventId"]
    payload = envelope["payload"]

    if event_type == ORDER_CANCELLED:
        with database.session_scope() as db:
            released = service.release(db, payload["orderId"], event_id)
        logger.info("Zdarzenie %s (%s): zwolniono %s pozycji rezerwacji", event_id, event_type, released)
    elif event_type == SHIPMENT_STATUS_CHANGED:
        if payload["newStatus"] != "SHIPPED":
            logger.info("Zdarzenie %s (%s): status inny niż SHIPPED, bez zmian", event_id, event_type)
            return
        with database.session_scope() as db:
            issued = service.issue(db, payload["orderId"], event_id)
        logger.info("Zdarzenie %s (%s): wydano towar dla %s pozycji rezerwacji", event_id, event_type, issued)
    else:
        logger.info("Zdarzenie %s: pomijam nieobsługiwany typ %s", event_id, event_type)
