import json
import logging

import pytest
from sqlalchemy.orm import Session

from app import db
from app.events import InvalidEvent, handle_event, parse_envelope
from app.models import ProcessedEvent
from tests.conftest import ADMIN, O1, O2, P1, SERVICE

E1 = "e0000000-0000-4000-8000-000000000001"
E2 = "e0000000-0000-4000-8000-000000000002"
E3 = "e0000000-0000-4000-8000-000000000003"
E4 = "e0000000-0000-4000-8000-000000000004"
ES1 = "e0000000-0000-4000-8000-0000000000a1"


def cancelled(event_id=E1, order_id=O1):
    return {
        "eventId": event_id,
        "type": "order.cancelled",
        "occurredAt": "2026-11-07T10:00:00Z",
        "version": 1,
        "requestId": "req-1",
        "payload": {"orderId": order_id},
    }


def shipped(event_id=ES1, order_id=O1, status="SHIPPED"):
    return {
        "eventId": event_id,
        "type": "shipment.status_changed",
        "occurredAt": "2026-11-07T11:00:00Z",
        "version": 1,
        "payload": {"orderId": order_id, "newStatus": status},
    }


def parse(envelope, routing_key=None):
    return parse_envelope(json.dumps(envelope).encode(), routing_key or envelope.get("type"))


def stock(client):
    return client.get(f"/inventory/{P1}").json()


@pytest.fixture
def reserved(client):
    client.put(f"/inventory/{P1}", json={"quantity": 10}, headers=ADMIN)
    resp = client.post(
        "/inventory/reservations",
        json={"orderId": O1, "items": [{"productId": P1, "quantity": 4}]},
        headers=SERVICE,
    )
    assert resp.status_code == 201


# --- sprawdzanie koperty ---------------------------------------------------

def test_valid_envelopes_are_accepted():
    assert parse(cancelled())["eventId"] == E1
    assert parse(shipped())["payload"]["newStatus"] == "SHIPPED"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda e: e.pop("eventId"),
        lambda e: e.update(eventId=123),
        lambda e: e.update(eventId=""),
        lambda e: e.update(eventId="evt-1"),  # eventId musi być UUID
        lambda e: e.update(eventId="E" * 100),
        lambda e: e.pop("type"),
        lambda e: e.update(version=2),
        lambda e: e.update(version="1"),
        lambda e: e.update(version=True),
        lambda e: e.pop("payload"),
        lambda e: e.update(payload="tekst"),
        lambda e: e["payload"].update(orderId=123),
        lambda e: e["payload"].update(orderId=""),
        lambda e: e["payload"].pop("orderId"),
        lambda e: e["payload"].update(orderId="o1"),  # orderId musi być UUID
        lambda e: e["payload"].update(orderId="   "),
    ],
)
def test_malformed_envelope_is_invalid(mutate):
    envelope = cancelled()
    mutate(envelope)
    with pytest.raises(InvalidEvent):
        parse(envelope, "order.cancelled")


def test_ids_are_normalized_to_lowercase():
    envelope = parse(cancelled(E1.upper(), O1.upper()))
    assert envelope["eventId"] == E1
    assert envelope["payload"]["orderId"] == O1


@pytest.mark.parametrize("request_id", [5, None, "", "zly id ze spacja", "R" * 65, 'a\n{"level": "error"}'])
def test_invalid_request_id_is_replaced_not_rejected(request_id):
    envelope = cancelled()
    envelope["requestId"] = request_id
    parsed = parse(envelope)
    assert parsed["requestId"] != request_id
    assert len(parsed["requestId"]) == 36  # nowy UUID


def test_valid_request_id_is_kept():
    assert parse(cancelled())["requestId"] == "req-1"


def test_shipment_without_new_status_is_invalid():
    envelope = shipped()
    del envelope["payload"]["newStatus"]
    with pytest.raises(InvalidEvent):
        parse(envelope)


@pytest.mark.parametrize("body", [b"nie json", b"[1, 2]", b"\xff\xfe", b'"tekst"'])
def test_non_object_or_broken_json_is_invalid(body):
    with pytest.raises(InvalidEvent):
        parse_envelope(body, "order.cancelled")


def test_type_must_match_routing_key():
    with pytest.raises(InvalidEvent):
        parse_envelope(json.dumps(cancelled()).encode(), "shipment.status_changed")
    with pytest.raises(InvalidEvent):
        parse_envelope(json.dumps(cancelled()).encode(), None)


# --- order.cancelled -------------------------------------------------------

def test_order_cancelled_releases_reservation(client, reserved):
    handle_event(parse(cancelled()))
    s = stock(client)
    assert (s["quantity"], s["reserved"], s["available"]) == (10, 0, 10)


def test_same_event_twice_is_processed_once(client, reserved):
    handle_event(parse(cancelled()))
    handle_event(parse(cancelled()))
    with db.session_scope() as session:
        assert session.query(ProcessedEvent).count() == 1
    assert stock(client)["reserved"] == 0


def test_cancelled_event_for_unknown_order_is_harmless(client, reserved):
    handle_event(parse(cancelled(E2, O2)))
    assert stock(client)["reserved"] == 4


# --- shipment.status_changed -----------------------------------------------

def test_shipped_issues_goods(client, reserved):
    handle_event(parse(shipped()))
    s = stock(client)
    assert (s["quantity"], s["reserved"], s["available"]) == (6, 0, 6)


def test_shipped_event_twice_issues_goods_once(client, reserved):
    handle_event(parse(shipped()))
    handle_event(parse(shipped()))
    assert stock(client)["quantity"] == 6


def test_other_shipment_statuses_change_nothing(client, reserved):
    handle_event(parse(shipped(E1, status="PREPARING")))
    handle_event(parse(shipped(E2, status="DELIVERED")))
    s = stock(client)
    assert (s["quantity"], s["reserved"]) == (10, 4)


def test_cancel_after_shipping_does_not_release_issued_goods(client, reserved):
    handle_event(parse(shipped()))
    handle_event(parse(cancelled(E3)))
    s = stock(client)
    assert (s["quantity"], s["reserved"], s["available"]) == (6, 0, 6)


def test_shipped_for_order_without_reservation_is_harmless(client, reserved):
    handle_event(parse(shipped(E4, O2)))
    assert stock(client)["quantity"] == 10


# --- duplikat: w logu tylko jedna linia o pominięciu ---------------------------

@pytest.mark.parametrize("event", [cancelled(), shipped()], ids=["order.cancelled", "shipment.status_changed"])
def test_duplicate_event_logs_exactly_one_line(client, reserved, caplog, event):
    handle_event(parse(event))
    caplog.clear()
    with caplog.at_level(logging.INFO, logger="app"):
        handle_event(parse(event))
    assert [r.getMessage() for r in caplog.records] == [f"Zdarzenie {event['eventId']} było już przetworzone, pomijam"]


def test_duplicate_processed_in_parallel_logs_exactly_one_line(client, reserved, caplog, monkeypatch):
    """Druga instancja nie widzi jeszcze zapisu eventId i dostaje konflikt dopiero przy commit."""
    handle_event(parse(shipped()))
    monkeypatch.setattr(Session, "get", lambda self, *args, **kwargs: None)
    caplog.clear()
    with caplog.at_level(logging.INFO, logger="app"):
        handle_event(parse(shipped()))
    assert [r.getMessage() for r in caplog.records] == [f"Zdarzenie {ES1} było już przetworzone, pomijam"]
    monkeypatch.undo()
    assert stock(client)["quantity"] == 6


# --- CR-12: wysyłka bez aktywnej rezerwacji -> warning z orderId i eventId -------------

def _warnings(caplog):
    return [r for r in caplog.records if r.levelno == logging.WARNING]


def test_shipped_without_reservation_logs_warning(client, reserved, caplog):
    with caplog.at_level(logging.INFO, logger="app"):
        handle_event(parse(shipped(E4, O2)))
    [warning] = _warnings(caplog)
    assert warning.getMessage() == "Wysyłka bez aktywnej rezerwacji, towar nie został wydany"
    assert warning.fields == {"orderId": O2, "eventId": E4}
    assert len(caplog.records) == 1


def test_shipped_after_cancel_logs_warning(client, reserved, caplog):
    handle_event(parse(cancelled()))
    with caplog.at_level(logging.INFO, logger="app"):
        handle_event(parse(shipped()))
    [warning] = _warnings(caplog)
    assert warning.fields == {"orderId": O1, "eventId": ES1}


def test_shipped_with_reservation_logs_info_only(client, reserved, caplog):
    with caplog.at_level(logging.INFO, logger="app"):
        handle_event(parse(shipped()))
    assert _warnings(caplog) == []
    assert [r.getMessage() for r in caplog.records] == [f"Zdarzenie {ES1} (shipment.status_changed): wydano towar dla 1 pozycji rezerwacji"]
