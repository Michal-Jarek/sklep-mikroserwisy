import asyncio
import json
from uuid import uuid4
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import Settings
from app.events import handle, receive
from app.main import create_app
from app.models import Outbox, Processed


@pytest.fixture
def shop(tmp_path):
    settings = Settings(db_url=f"sqlite:///{tmp_path}/shipping.db", consul_enabled=False, broker_enabled=False)
    with TestClient(create_app(settings)) as client:
        yield client


@pytest.fixture
def created():
    return {"type": "order.created", "version": 1, "eventId": str(uuid4()), "requestId": "checkout",
            "occurredAt": "2026-11-10T09:00:00.000Z", "payload": {
                "orderId": str(uuid4()), "userId": str(uuid4()), "shippingCost": "14.99",
                "shippingMethod": "COURIER", "currency": "PLN", "shippingAddress": {
                    "firstName": "Jan", "lastName": "Kot", "city": "Łódź", "street": "Polna 1",
                    "postalCode": "90-001", "countryCode": "PL"}}}


def deliver(shop, event):
    handle(shop.app.state.session_factory, json.dumps(event), event["type"])


def headers(event, role="CUSTOMER"):
    return {"X-User-Id": event["payload"]["userId"], "X-User-Roles": role}


def cancellation(created):
    payload = created["payload"]
    return dict(created, eventId=str(uuid4()), type="order.cancelled",
                payload={"orderId": payload["orderId"], "userId": payload["userId"], "items": []})


def messages(shop):
    with shop.app.state.session_factory() as db:
        return [row.envelope for row in db.scalars(select(Outbox).order_by(Outbox.seq))]


def test_methods_and_probes(shop):
    assert shop.get("/shipping/methods").json()[0]["price"] == "14.99"
    assert shop.head("/shipping/methods").status_code == 200
    assert shop.get("/health/ready").status_code == 200
    assert shop.get("/shipments").status_code == 401


def test_delivery(shop, created):
    deliver(shop, created)
    deliver(shop, created)
    deliver(shop, dict(created, eventId=str(uuid4())))
    user = headers(created)
    row, = shop.get("/shipments", headers=user, params={"orderId": created["payload"]["orderId"]}).json()["items"]
    path = "/shipments/" + row["id"]
    other = {**user, "X-User-Id": str(uuid4())}
    assert shop.get(path, headers=other).status_code == 404
    assert shop.get("/shipments", headers=other).json()["items"] == []
    assert shop.patch(path + "/status", headers=user, json={"status": "SHIPPED"}).status_code == 403
    admin = headers(created, "ADMIN")
    def update(status):
        return shop.patch(path + "/status", headers=admin, json={"status": status})
    assert update("DELIVERED").status_code == 409
    for step in ("SHIPPED", "IN_TRANSIT", "DELIVERED"):
        assert update(step).json()["status"] == step
        assert update(step).json()["error"] == "INVALID_STATUS_TRANSITION"
    deliver(shop, cancellation(created))
    assert shop.get(path, headers=user).json()["status"] == "DELIVERED"
    events = messages(shop)
    assert [e["payload"]["oldStatus"] for e in events] == [None, "PREPARING", "SHIPPED", "IN_TRANSIT"]
    assert [e["payload"]["newStatus"] for e in events] == ["PREPARING", "SHIPPED", "IN_TRANSIT", "DELIVERED"]
    assert row["trackingNumber"] is None
    assert all(e["payload"]["trackingNumber"] for e in events[1:])
    assert len(shop.get(path, headers=user).json()["history"]) == 4


def test_early_cancellation(shop, created):
    deliver(shop, cancellation(created))
    deliver(shop, created)
    assert shop.get("/shipments", headers=headers(created)).json()["items"] == []
    assert messages(shop) == []


def test_cancel_preparing(shop, created):
    deliver(shop, created)
    deliver(shop, cancellation(created))
    deliver(shop, cancellation(created))
    row, = shop.get("/shipments", headers=headers(created)).json()["items"]
    assert row["status"] == "CANCELLED"
    assert len(messages(shop)) == 2
    assert shop.patch(f"/shipments/{row['id']}/status", headers=headers(created, "ADMIN"),
                      json={"status": "SHIPPED"}).status_code == 409


def test_invalid_message_rejected(shop, created):
    msg = AsyncMock()
    msg.body = json.dumps(created).encode()
    msg.routing_key = "order.cancelled"
    asyncio.run(receive(msg, shop.app.state.session_factory))
    msg.nack.assert_awaited_once_with(requeue=False)
    msg.ack.assert_not_awaited()
    assert not messages(shop)


def test_failure_rolls_back_deduplication(shop, created):
    deliver(shop, created)
    bad = cancellation(created)
    bad["payload"]["userId"] = str(uuid4())
    with pytest.raises(ValueError):
        deliver(shop, bad)
    with shop.app.state.session_factory() as db:
        assert db.get(Processed, bad["eventId"]) is None
    bad["payload"]["userId"] = created["payload"]["userId"]
    deliver(shop, bad)
    assert messages(shop)[-1]["payload"]["newStatus"] == "CANCELLED"
