import json

import pytest

from app import db
from app.events import InvalidEvent, handle_event, parse_envelope
from app.models import ProcessedEvent
from tests.conftest import ADMIN, P1, SERVICE


def cancelled(event_id="evt-1", order_id="o1"):
    return {
        "eventId": event_id,
        "type": "order.cancelled",
        "occurredAt": "2026-11-07T10:00:00Z",
        "version": 1,
        "requestId": "req-1",
        "payload": {"orderId": order_id},
    }


def shipped(event_id="evt-s1", order_id="o1", status="SHIPPED"):
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
        json={"orderId": "o1", "items": [{"productId": P1, "quantity": 4}]},
        headers=SERVICE,
    )
    assert resp.status_code == 201


# --- sprawdzanie koperty ---------------------------------------------------

def test_valid_envelopes_are_accepted():
    assert parse(cancelled())["eventId"] == "evt-1"
    assert parse(shipped())["payload"]["newStatus"] == "SHIPPED"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda e: e.pop("eventId"),
        lambda e: e.update(eventId=123),
        lambda e: e.update(eventId=""),
        lambda e: e.pop("type"),
        lambda e: e.update(version=2),
        lambda e: e.update(version="1"),
        lambda e: e.update(version=True),
        lambda e: e.pop("payload"),
        lambda e: e.update(payload="tekst"),
        lambda e: e["payload"].update(orderId=123),
        lambda e: e["payload"].update(orderId=""),
        lambda e: e["payload"].pop("orderId"),
        lambda e: e.update(requestId=5),
    ],
)
def test_malformed_envelope_is_invalid(mutate):
    envelope = cancelled()
    mutate(envelope)
    with pytest.raises(InvalidEvent):
        parse(envelope, "order.cancelled")


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
    handle_event(parse(cancelled("evt-2", "no-such-order")))
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
    handle_event(parse(shipped("evt-a", status="PREPARING")))
    handle_event(parse(shipped("evt-b", status="DELIVERED")))
    s = stock(client)
    assert (s["quantity"], s["reserved"]) == (10, 4)


def test_cancel_after_shipping_does_not_release_issued_goods(client, reserved):
    handle_event(parse(shipped()))
    handle_event(parse(cancelled("evt-c")))
    s = stock(client)
    assert (s["quantity"], s["reserved"], s["available"]) == (6, 0, 6)


def test_shipped_for_order_without_reservation_is_harmless(client, reserved):
    handle_event(parse(shipped("evt-d", "no-such-order")))
    assert stock(client)["quantity"] == 10
