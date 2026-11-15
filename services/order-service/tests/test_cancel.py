"""S5 variant B: Shipping decides first, then Order cancels; exactly one order.cancelled per order."""
import json
from uuid import uuid4

import httpx
import pytest

from app import store
from app.events import handle, parse_envelope
from tests.conftest import orders_in_db, outbox
from tests.test_orders import create, shipment_event


def cancelled_events(client):
    return [e for e in outbox(client) if e["type"] == "order.cancelled"]


def test_shipping_agrees(client, deps, headers, body):
    order = create(client, headers, body)
    response = client.post(f"/orders/{order['id']}/cancel", headers=headers)
    assert response.status_code == 200 and response.json()["status"] == "CANCELLED"
    [call] = deps.made("shipping", "POST")
    assert call.url.path == "/shipments/cancel" and json.loads(call.content) == {"orderId": order["id"]}
    assert set(call.headers["X-User-Roles"].split(",")) == {"CUSTOMER", "SERVICE"}
    assert call.headers["X-User-Id"] == headers["X-User-Id"]
    [event] = cancelled_events(client)
    assert event["payload"] == {"orderId": order["id"], "userId": headers["X-User-Id"],
                                "items": [{"productId": deps.product, "quantity": 2}]}


@pytest.mark.parametrize("rule,status,error", [
    ({"status": 409, "json": {"error": "INVALID_STATUS_TRANSITION"}}, 409, "ORDER_NOT_CANCELLABLE"),
    ({"status": 503}, 503, "SERVICE_UNAVAILABLE"),
    ({"delay": 3}, 503, "SERVICE_UNAVAILABLE"),
    ({"status": 403}, 503, "SERVICE_UNAVAILABLE"),
    ({"status": 200, "json": {"status": "SHIPPED"}}, 503, "SERVICE_UNAVAILABLE"),
])
def test_shipping_refuses_or_fails(client, deps, headers, body, rule, status, error):
    order = create(client, headers, body)
    deps.rules["shipping:POST"] = rule
    response = client.post(f"/orders/{order['id']}/cancel", headers=headers)
    assert response.status_code == status and response.json()["error"] == error
    assert store.get(client.app.state.session_factory, order["id"]).status == "PAID"
    assert not cancelled_events(client)
    assert len(deps.made("shipping", "POST")) == 1  # POST is not retried after the request was sent


def test_self_repair_during_cancel_gives_one_event(client, deps, headers, body):
    """Shipping cancels and its CANCELLED event reaches Order before Order saves its own cancellation."""
    order = create(client, headers, body)
    factory = client.app.state.session_factory

    async def shipping_then_event(request):
        raw = shipment_event(order["id"], headers["X-User-Id"], "CANCELLED")
        handle(factory, parse_envelope(raw, "shipment.status_changed"))
        return httpx.Response(200, json={"orderId": order["id"], "shipmentId": str(uuid4()), "status": "CANCELLED"})

    client.app.state.peers.client = httpx.AsyncClient(transport=httpx.MockTransport(shipping_then_event))
    response = client.post(f"/orders/{order['id']}/cancel", headers=headers)
    assert response.status_code == 200 and response.json()["status"] == "CANCELLED"
    assert len(cancelled_events(client)) == 1
    # Repeating the cancellation and the event changes nothing.
    assert client.post(f"/orders/{order['id']}/cancel", headers=headers).status_code == 409
    handle(factory, parse_envelope(shipment_event(order["id"], headers["X-User-Id"], "CANCELLED"),
                                   "shipment.status_changed"))
    assert len(cancelled_events(client)) == 1


def test_cancel_new_order_sends_event(client, deps, headers, body):
    """order.cancelled also for NEW (e.g. kept after a failed compensation)."""
    deps.rules["inventory:POST"] = {"status": 503}
    deps.rules["inventory:DELETE"] = {"status": 503}
    assert client.post("/orders", headers=headers, json=body).status_code == 503
    [order] = orders_in_db(client)
    assert order.status == "NEW"
    deps.rules.clear()
    assert client.post(f"/orders/{order.id}/cancel", headers=headers).json()["status"] == "CANCELLED"
    assert [e["type"] for e in outbox(client)] == ["order.cancelled"]


def test_cancel_during_purchase_wins(client, deps, headers, body):
    """The reservation is made, then the customer cancels NEW: the purchase releases the reservation."""
    factory = client.app.state.session_factory
    default = deps.default

    def cancel_first(request):
        response = default(request)
        if request.url.path == "/inventory/reservations":
            order_id = json.loads(request.content)["orderId"]
            store.change_status(factory, order_id, store.OPEN_STATES, "CANCELLED", "order.cancelled", "r")
        return response

    deps.default = cancel_first
    response = client.post("/orders", headers=headers, json=body)
    assert response.status_code == 201 and response.json()["status"] == "CANCELLED"
    assert len(deps.made("inventory", "DELETE")) == 1
    assert [e["type"] for e in outbox(client)] == ["order.cancelled"]
    assert not deps.made("cart", "DELETE")


def test_shipped_for_cancelled_order_is_logged(client, headers, body, caplog):
    order = create(client, headers, body)
    client.post(f"/orders/{order['id']}/cancel", headers=headers)
    handle(client.app.state.session_factory,
           parse_envelope(shipment_event(order["id"], headers["X-User-Id"], "SHIPPED"), "shipment.status_changed"))
    assert store.get(client.app.state.session_factory, order["id"]).status == "CANCELLED"
    assert [r.msg for r in caplog.records if r.levelname == "ERROR"] == [
        "Cancellation inconsistency: shipment dispatched for a cancelled order"]


def test_late_cancelled_event_of_z10_repairs_a_paid_order(client, headers, body):
    """CR-9 / Z10: Shipping answered the cancellation before it knew the order (placeholder), Order did not save its
    CANCELLED; the late order.created then makes Shipping send null→CANCELLED, and Order repairs itself on it."""
    order = create(client, headers, body)
    factory = client.app.state.session_factory
    raw = json.dumps(dict(type="shipment.status_changed", eventId=str(uuid4()), version=1,
                          occurredAt="2026-11-14T23:30:00.000Z", requestId="z10", payload=dict(
                              shipmentId=str(uuid4()), orderId=order["id"], userId=headers["X-User-Id"],
                              oldStatus=None, newStatus="CANCELLED", trackingNumber=None))).encode()
    assert handle(factory, parse_envelope(raw, "shipment.status_changed")) == "processed"
    assert store.get(factory, order["id"]).status == "CANCELLED"
    assert len(cancelled_events(client)) == 1
