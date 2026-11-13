import json
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import Settings
from app.events import handle
from app.main import create_app
from app.models import Outbox


@pytest.fixture
def shop(tmp_path):
    customer, product = str(uuid4()), str(uuid4())
    headers = {"X-User-Id": customer, "X-User-Roles": "CUSTOMER", "Idempotency-Key": str(uuid4())}
    body = {"shippingAddress": dict(firstName="Jan", lastName="Kot", street="Polna 1",
            postalCode="00-001", city="Warszawa", countryCode="PL"),
            "shippingMethod":"COURIER", "payment":{"cardNumber":"4111111111111111"}}
    calls = []
    def respond(request):
        calls.append(request)
        assert set(request.headers["X-User-Roles"].split(",")) == {"CUSTOMER", "SERVICE"}
        if request.url.path == "/cart":
            return httpx.Response(200, json={"userId": customer, "items": [{"productId": product, "quantity": 2}]})
        if request.url.path == "/products/" + product:
            return httpx.Response(200, json={"id": product, "name": "Kubek", "price": "19.99", "currency": "PLN"})
        if request.url.path == "/shipping/methods/COURIER":
            return httpx.Response(200, json={"price":"14.99","currency":"PLN"})
        if request.method == "DELETE" and request.url.path.startswith("/inventory/reservations/"):
            return httpx.Response(204)
        if request.url.path == "/inventory/reservations":
            assert json.loads(request.content)["items"] == [{"productId": product, "quantity": 2}]
            return httpx.Response(201)
        assert request.method == "DELETE" and request.url.path == "/cart/" + customer
        return httpx.Response(204)
    app = create_app(Settings(db_url=f"sqlite:///{tmp_path}/test.db", consul_enabled=False,
        broker_enabled=False, cart_service_url="http://cart", inventory_service_url="http://inventory",
        shipping_service_url="http://shipping", product_service_url="http://product"))
    with TestClient(app) as client:
        app.state.peers.client = httpx.AsyncClient(transport=httpx.MockTransport(respond))
        yield client, headers, body, product, calls


def create(shop):
    client, headers, body, _, _ = shop
    response = client.post("/orders", headers=headers, json=body)
    assert response.status_code == 201, response.text
    return response.json()


def events(client):
    with client.app.state.session_factory() as session:
        return [row.envelope for row in session.scalars(select(Outbox).order_by(Outbox.seq))]


def test_checkout_and_payment(shop):
    client, headers, _, product, calls = shop
    order = create(shop)
    assert create(shop) == order and len(calls) == 5
    assert order["total"] == "54.97" and order["itemsTotal"] == "39.98"
    path = "/orders/" + order["id"]
    assert order["status"] == "PAID"
    assert client.get("/orders", headers=headers).json()["items"][0]["itemCount"] == 1
    assert [e["type"] for e in events(client)] == ["order.created"]
    result = client.get("/orders/purchased", headers={"X-User-Roles": "SERVICE"},
                        params={"userId": headers["X-User-Id"], "productId": product})
    assert result.json() == {"purchased": True}
    assert client.get(path, headers={**headers, "X-User-Id": str(uuid4())}).status_code == 404


def test_failed_payment(shop):
    client, headers, body, _, calls = shop
    body["payment"]["cardNumber"] = "4111111111111110"
    response = client.post("/orders", headers={k:v for k,v in headers.items() if k != "Idempotency-Key"}, json=body)
    assert response.status_code == 201
    assert response.json()["status"] == "PAYMENT_FAILED"
    assert calls[-1].method == "DELETE" and calls[-1].url.path.startswith("/inventory/reservations/")
    assert not events(client)
    assert "4111111111111110" not in response.text


def test_cancel_by_admin(shop):
    client, headers, _, _, _ = shop
    path = "/orders/" + create(shop)["id"]
    admin = {**headers, "X-User-Id": str(uuid4()), "X-User-Roles":"ADMIN"}
    assert client.post(path + "/cancel", headers=admin).json()["status"] == "CANCELLED"
    assert client.post(path + "/cancel", headers=admin).json()["error"] == "ORDER_NOT_CANCELLABLE"
    assert [e["type"] for e in events(client)] == ["order.created","order.cancelled"]


def test_shipping_is_monotonic(shop):
    client, headers, _, _, _ = shop
    oid = create(shop)["id"]
    path = "/orders/" + oid
    for status in ["SHIPPED", "IN_TRANSIT", "PREPARING"]:
        event = dict(type="shipment.status_changed", eventId=str(uuid4()), version=1, occurredAt="now",
                     requestId="test", payload=dict(orderId=oid, userId=headers["X-User-Id"], newStatus=status))
        for _ in range(2):
            handle(client.app.state.session_factory, json.dumps(event), event["type"])
    assert client.get(path, headers=headers).json()["status"] == "SHIPPED"
    assert client.post(path + "/cancel", headers=headers).status_code == 409


def test_auth_and_health(shop):
    client, headers, _, _, _ = shop
    assert client.get("/health/ready").status_code == 200
    assert client.get("/orders").status_code == 401
    assert client.get("/orders/purchased", headers=headers).status_code == 403
    assert client.get("/orders/bad", headers=headers).json()["error"] == "VALIDATION_ERROR"
    assert client.head("/orders", headers=headers).content == b""

@pytest.mark.parametrize("first_status", [503, 409])
def test_reservation_failure(shop, first_status):
    client, headers, body, _, calls = shop
    peers = client.app.state.peers
    original = peers.call
    reservation_ids = []

    async def intermittent(name, method, path, caller, **kwargs):
        if name == "inventory":
            reservation_ids.append(kwargs["json"]["orderId"])
            if len(reservation_ids) == 1 or first_status == 409:
                from fastapi import HTTPException
                raise HTTPException(first_status, "inventory")
        return await original(name, method, path, caller, **kwargs)

    peers.call = intermittent
    assert client.post("/orders", headers=headers, json=body).status_code == first_status
    assert not any(req.method == "DELETE" for req in calls)
    retry = client.post("/orders", headers=headers, json=body)
    if first_status == 503:
        assert retry.status_code == 201
        assert reservation_ids == [retry.json()["id"]] * 2
    else:
        assert retry.status_code == 409 and len(reservation_ids) == 2
        assert not events(client)


def test_reused_key_and_invalid_event(shop):
    client, headers, body, _, _ = shop
    create(shop)
    changed = {**body, "shippingAddress": {**body["shippingAddress"], "city": "Łódź"}}
    assert client.post("/orders", headers=headers, json=changed).status_code == 409
    with pytest.raises(ValueError):
        handle(client.app.state.session_factory, b"{}", "shipment.status_changed")
