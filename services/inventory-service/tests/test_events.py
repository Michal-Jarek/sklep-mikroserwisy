import pytest

from app import db
from app.events import handle_event
from app.models import ProcessedEvent
from tests.conftest import ADMIN, SERVICE


def cancelled(event_id, order_id):
    return {
        "eventId": event_id,
        "type": "order.cancelled",
        "occurredAt": "2026-11-07T10:00:00Z",
        "version": 1,
        "payload": {"orderId": order_id, "items": []},
    }


@pytest.fixture
def reserved(client):
    client.put("/inventory/10", json={"quantity": 10}, headers=ADMIN)
    resp = client.post(
        "/inventory/reservations",
        json={"orderId": "o1", "items": [{"productId": 10, "quantity": 4}]},
        headers=SERVICE,
    )
    assert resp.status_code == 201


def test_order_cancelled_releases_reservation(client, reserved):
    handle_event(cancelled("evt-1", "o1"))
    assert client.get("/inventory/10").json()["available"] == 10


def test_same_event_twice_is_processed_once(client, reserved):
    handle_event(cancelled("evt-1", "o1"))
    # nowa rezerwacja tego samego zamówienia niemozliwa, sprawdzamy licznik zdarzeń
    handle_event(cancelled("evt-1", "o1"))
    with db.session_scope() as session:
        assert session.query(ProcessedEvent).count() == 1
    assert client.get("/inventory/10").json()["reserved"] == 0


def test_cancelled_event_for_unknown_order_is_harmless(client, reserved):
    handle_event(cancelled("evt-2", "no-such-order"))
    assert client.get("/inventory/10").json()["reserved"] == 4


def test_other_event_types_are_ignored(client, reserved):
    handle_event({"eventId": "evt-3", "type": "order.created", "payload": {"orderId": "o1"}})
    assert client.get("/inventory/10").json()["reserved"] == 4


@pytest.mark.parametrize("bad", ["text", {"type": "order.cancelled", "payload": {}}, cancelled("e", "")])
def test_malformed_event_raises_so_it_can_be_retried_or_dead_lettered(client, bad):
    with pytest.raises(ValueError):
        handle_event(bad)
