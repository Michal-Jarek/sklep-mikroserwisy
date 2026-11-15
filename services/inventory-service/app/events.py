"""Zdarzenia RabbitMQ (koperta: eventId, type, occurredAt, version, payload, requestId).

parse_envelope() sprawdza kopertę; każda niezgodność to InvalidEvent, czyli odrzucenie bez ponowień.
eventId i payload.orderId to UUID (zapisywane małymi literami). requestId spoza wzorca X-Request-Id nie odrzuca
zdarzenia: w logach dostaje nowy UUID (docs/events.md, reguły koperty).
handle_event() zakłada poprawną kopertę; wyjątek z niego oznacza błąd chwilowy (ponowienie).
W logach nie ma danych z payload.
"""
import json
import logging

from app import db as database
from app import service
from app.ids import request_id_or_new, valid_uuid

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

    event_id = valid_uuid(envelope.get("eventId"))
    if event_id is None:
        raise InvalidEvent("eventId musi być UUID")
    envelope["eventId"] = event_id
    event_type = envelope.get("type")
    if not _is_text(event_type):
        raise InvalidEvent("type musi być niepustym tekstem")
    version = envelope.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version not in SUPPORTED_VERSIONS:
        raise InvalidEvent("nieznana wersja zdarzenia")
    # chroni przed podsunięciem zdarzenia innego typu pod cudzym kluczem routingu
    if event_type != routing_key:
        raise InvalidEvent("type różny od klucza routingu")
    envelope["requestId"] = request_id_or_new(envelope.get("requestId"))

    payload = envelope.get("payload")
    if not isinstance(payload, dict):
        raise InvalidEvent("payload musi być obiektem")
    if event_type in (ORDER_CANCELLED, SHIPMENT_STATUS_CHANGED):
        order_id = valid_uuid(payload.get("orderId"))
        if order_id is None:
            raise InvalidEvent("payload.orderId musi być UUID")
        payload["orderId"] = order_id
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
        if released is None:  # duplikat: service.release zalogował już pominięcie
            return
        logger.info("Zdarzenie %s (%s): zwolniono %s pozycji rezerwacji", event_id, event_type, released)
    elif event_type == SHIPMENT_STATUS_CHANGED:
        if payload["newStatus"] != "SHIPPED":
            logger.info("Zdarzenie %s (%s): status inny niż SHIPPED, bez zmian", event_id, event_type)
            return
        with database.session_scope() as db:
            issued = service.issue(db, payload["orderId"], event_id)
        if issued is None:  # duplikat: service.issue zalogował już pominięcie
            return
        if issued == 0:
            # paczka wysłana, a nie ma aktywnej rezerwacji (np. zwolniona po anulowaniu): stan magazynu bez zmian
            logger.warning(
                "Wysyłka bez aktywnej rezerwacji, towar nie został wydany",
                extra={"fields": {"orderId": payload["orderId"], "eventId": event_id}},
            )
            return
        logger.info("Zdarzenie %s (%s): wydano towar dla %s pozycji rezerwacji", event_id, event_type, issued)
    else:
        logger.info("Zdarzenie %s: pomijam nieobsługiwany typ %s", event_id, event_type)
