import asyncio
import json
import logging
from uuid import uuid4
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import Settings
from app.events import InvalidEvent, handle, parse_envelope
from app.logging_config import JsonFormatter
from app.main import create_app
from app.models import Outbox, Processed, Shipment

SERVICE = {"X-User-Id": str(uuid4()), "X-User-Roles": "CUSTOMER,SERVICE"}


@pytest.fixture
def shop(tmp_path):
    settings = Settings(db_url=f"sqlite:///{tmp_path}/shipping.db", consul_enabled=False, broker_enabled=False)
    with TestClient(create_app(settings)) as client:
        yield client


@pytest.fixture
def logs():
    """JSON lines written by the service loggers during the test."""
    lines = []

    class Collect(logging.Handler):
        def emit(self, record):
            lines.append(json.loads(self.format(record)))

    handler = Collect()
    handler.setFormatter(JsonFormatter("shipping-service"))
    logger = logging.getLogger("shipping")
    logger.addHandler(handler)
    yield lines
    logger.removeHandler(handler)


@pytest.fixture
def created():
    return {"type": "order.created", "version": 1, "eventId": str(uuid4()), "requestId": "checkout",
            "occurredAt": "2026-11-10T09:00:00.000Z", "payload": {
                "orderId": str(uuid4()), "userId": str(uuid4()), "shippingCost": "14.99",
                "shippingMethod": "COURIER", "currency": "PLN", "shippingAddress": {
                    "firstName": "Jan", "lastName": "Kot", "city": "Łódź", "street": "Polna 1",
                    "postalCode": "90-001", "countryCode": "PL"}}}


def deliver(shop, event):
    handle(shop.app.state.session_factory, parse_envelope(json.dumps(event).encode(), event["type"]))


def headers(event, role="CUSTOMER"):
    return {"X-User-Id": event["payload"]["userId"], "X-User-Roles": role}


def cancellation(created):
    payload = created["payload"]
    return dict(created, eventId=str(uuid4()), type="order.cancelled",
                payload={"orderId": payload["orderId"], "userId": payload["userId"], "items": []})


def messages(shop):
    with shop.app.state.session_factory() as db:
        return [row.envelope for row in db.scalars(select(Outbox).order_by(Outbox.seq))]


def admin_patch(shop, created, shipment_id, status):
    return shop.patch(f"/shipments/{shipment_id}/status", headers=headers(created, "ADMIN"), json={"status": status})


def shipment_of(shop, created):
    row, = shop.get("/shipments", headers=headers(created), params={"orderId": created["payload"]["orderId"]}).json()["items"]
    return row


def message(event, routing_key=None):
    msg = AsyncMock()
    msg.body = json.dumps(event).encode() if isinstance(event, dict) else event
    msg.routing_key = routing_key or event["type"]
    return msg


def test_methods_and_probes(shop):
    assert shop.get("/shipping/methods").json()[0]["price"] == "14.99"
    head = shop.head("/shipping/methods/PICKUP")
    assert head.status_code == 200 and head.content == b""
    assert shop.head("/shipping/methods").status_code == 200
    assert shop.get("/shipping/methods/NOPE").json()["error"] == "NOT_FOUND"
    assert shop.get("/health/live").status_code == 200
    assert shop.get("/health/ready").status_code == 200
    assert shop.get("/shipments").status_code == 401


def test_other_customers_order_and_service_role_on_patch(shop, created):
    # CR-8 (security N3): another customer's orderId gives an empty page; CUSTOMER,SERVICE may not change a status.
    deliver(shop, created)
    row = shipment_of(shop, created)
    other = {"X-User-Id": str(uuid4()), "X-User-Roles": "CUSTOMER"}
    page = shop.get("/shipments", headers=other, params={"orderId": created["payload"]["orderId"]}).json()
    assert (page["items"], page["total"]) == ([], 0)
    for roles in ("CUSTOMER,SERVICE", "SERVICE"):
        response = shop.patch(f"/shipments/{row['id']}/status", json={"status": "SHIPPED"},
                              headers={"X-User-Id": created["payload"]["userId"], "X-User-Roles": roles})
        assert response.status_code == 403 and response.json()["error"] == "FORBIDDEN"
    assert shipment_of(shop, created)["status"] == "PREPARING" and len(messages(shop)) == 1


def test_delivery(shop, created):
    deliver(shop, created)
    deliver(shop, created)
    deliver(shop, dict(created, eventId=str(uuid4())))
    user = headers(created)
    row = shipment_of(shop, created)
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
    events = messages(shop)
    assert [e["payload"]["oldStatus"] for e in events] == [None, "PREPARING", "SHIPPED", "IN_TRANSIT"]
    assert [e["payload"]["newStatus"] for e in events] == ["PREPARING", "SHIPPED", "IN_TRANSIT", "DELIVERED"]
    assert row["trackingNumber"] is None
    assert all(e["payload"]["trackingNumber"] for e in events[1:])
    assert len(shop.get(path, headers=user).json()["history"]) == 4


def test_late_cancellation_event_is_logged(shop, created, logs):
    deliver(shop, created)
    row = shipment_of(shop, created)
    admin_patch(shop, created, row["id"], "SHIPPED")
    late = cancellation(created)
    deliver(shop, late)
    assert shop.get("/shipments/" + row["id"], headers=headers(created)).json()["status"] == "SHIPPED"
    error, = [line for line in logs if line["level"] == "error"]
    assert error["eventId"] == late["eventId"] and error["status"] == "SHIPPED"


def test_early_cancellation(shop, created):
    # Z10: order.cancelled before order.created -> the shipment is created as CANCELLED with one event.
    deliver(shop, cancellation(created))
    assert messages(shop) == []
    deliver(shop, created)
    row = shipment_of(shop, created)
    assert (row["status"], row["method"], row["trackingNumber"]) == ("CANCELLED", "COURIER", None)
    assert [h["status"] for h in row["history"]] == ["CANCELLED"]
    event, = messages(shop)
    assert event["requestId"] == created["requestId"]
    assert event["payload"] == {"shipmentId": row["id"], "orderId": created["payload"]["orderId"],
                                "userId": created["payload"]["userId"], "oldStatus": None,
                                "newStatus": "CANCELLED", "trackingNumber": None}
    deliver(shop, cancellation(created))  # nothing more for a repeated cancellation
    deliver(shop, dict(created, eventId=str(uuid4())))  # nor for another order.created
    assert len(messages(shop)) == 1 and shipment_of(shop, created)["id"] == row["id"]
    with shop.app.state.session_factory() as db:
        assert db.get(Shipment, created["payload"]["orderId"]).destination is None  # no address kept


def test_cancel_preparing(shop, created):
    deliver(shop, created)
    deliver(shop, cancellation(created))
    deliver(shop, cancellation(created))
    row = shipment_of(shop, created)
    assert row["status"] == "CANCELLED"
    assert len(messages(shop)) == 2
    assert admin_patch(shop, created, row["id"], "SHIPPED").status_code == 409


def test_failure_rolls_back_deduplication(shop, created):
    deliver(shop, created)
    bad = cancellation(created)
    bad["payload"]["userId"] = str(uuid4())
    with pytest.raises(InvalidEvent):
        deliver(shop, bad)
    with shop.app.state.session_factory() as db:
        assert db.get(Processed, bad["eventId"]) is None
    bad["payload"]["userId"] = created["payload"]["userId"]
    deliver(shop, bad)
    assert messages(shop)[-1]["payload"]["newStatus"] == "CANCELLED"


# POST /shipments/cancel (internal, SERVICE only)

def cancel(shop, order_id, hdrs=SERVICE):
    return shop.post("/shipments/cancel", headers=hdrs, json={"orderId": order_id})


def test_cancel_requires_service_role(shop, created):
    order_id = created["payload"]["orderId"]
    for roles in ("CUSTOMER", "ADMIN", "CUSTOMER,ADMIN"):
        response = cancel(shop, order_id, {"X-User-Id": str(uuid4()), "X-User-Roles": roles})
        assert response.status_code == 403 and response.json()["error"] == "FORBIDDEN"
    assert cancel(shop, order_id, {}).status_code == 403
    assert cancel(shop, order_id, {"X-User-Roles": "SERVICE"}).status_code == 200
    assert cancel(shop, order_id, {"X-User-Id": str(uuid4()), "X-User-Roles": "ADMIN,SERVICE"}).status_code == 200


def test_cancel_validation(shop):
    for body in ({"orderId": "not-a-uuid"}, {"orderId": str(uuid4()), "reason": "x"}, {}, {"orderId": 12}):
        response = shop.post("/shipments/cancel", headers=SERVICE, json=body)
        assert response.status_code == 400 and response.json()["error"] == "VALIDATION_ERROR"
        assert set(response.json()) == {"status", "error", "message", "requestId"}


def test_cancel_without_shipment_blocks_late_creation(shop, created):
    order_id = created["payload"]["orderId"]
    response = cancel(shop, order_id.upper(), {"X-User-Id": str(uuid4()), "X-User-Roles": "ADMIN,SERVICE"})
    assert response.status_code == 200
    assert response.json() == {"orderId": order_id, "shipmentId": None, "status": "CANCELLED"}
    assert cancel(shop, order_id).json()["shipmentId"] is None
    assert messages(shop) == []
    deliver(shop, created)  # placeholder has no user (the caller was an admin): no inconsistency
    deliver(shop, cancellation(created))
    # Z10: the late order.created creates the shipment as CANCELLED with exactly one event null -> CANCELLED.
    row, = shop.get("/shipments", headers=headers(created, "ADMIN")).json()["items"]
    assert (row["status"], row["userId"]) == ("CANCELLED", created["payload"]["userId"])
    event, = messages(shop)
    assert (event["payload"]["oldStatus"], event["payload"]["newStatus"]) == (None, "CANCELLED")
    assert cancel(shop, order_id).json() == {"orderId": order_id, "shipmentId": row["id"], "status": "CANCELLED"}
    assert len(messages(shop)) == 1


def test_cancel_preparing_and_repeat(shop, created):
    deliver(shop, created)
    row = shipment_of(shop, created)
    response = cancel(shop, created["payload"]["orderId"], {**SERVICE, "X-Request-Id": "cancel-1"})
    assert response.json() == {"orderId": created["payload"]["orderId"], "shipmentId": row["id"], "status": "CANCELLED"}
    event = messages(shop)[-1]
    assert (event["payload"]["oldStatus"], event["payload"]["newStatus"], event["requestId"]) == ("PREPARING", "CANCELLED", "cancel-1")
    assert cancel(shop, created["payload"]["orderId"]).status_code == 200
    assert len(messages(shop)) == 2  # PREPARING + CANCELLED, nothing for the repeat
    assert len(shop.get("/shipments/" + row["id"], headers=headers(created)).json()["history"]) == 2
    assert admin_patch(shop, created, row["id"], "SHIPPED").status_code == 409


@pytest.mark.parametrize("steps", [["SHIPPED"], ["SHIPPED", "IN_TRANSIT"], ["SHIPPED", "IN_TRANSIT", "DELIVERED"]])
def test_cancel_dispatched_is_conflict(shop, created, steps):
    deliver(shop, created)
    row = shipment_of(shop, created)
    for step in steps:
        admin_patch(shop, created, row["id"], step)
    before = len(messages(shop))
    response = cancel(shop, created["payload"]["orderId"])
    assert response.status_code == 409 and response.json()["error"] == "INVALID_STATUS_TRANSITION"
    assert shipment_of(shop, created)["status"] == steps[-1]
    assert len(messages(shop)) == before


# Consumer (app/consumer.py)

def run(coro):
    return asyncio.run(coro)


def test_consumer_acks_and_normalizes_request_id(shop, created):
    from app.consumer import on_message
    created["requestId"] = "bad request id with spaces"
    created["eventId"] = created["eventId"].upper()
    msg = message(created)
    run(on_message(msg, shop.app.state.session_factory))
    msg.ack.assert_awaited_once()
    event = messages(shop)[0]
    assert len(event["requestId"]) == 36 and event["requestId"] != created["requestId"]
    with shop.app.state.session_factory() as db:
        assert db.get(Processed, created["eventId"].lower()) is not None


@pytest.mark.parametrize("change", [
    {"eventId": "not-a-uuid"}, {"eventId": None}, {"version": 2}, {"type": "order.cancelled"},
    {"payload": "x"}, {"occurredAt": 5}])
def test_consumer_rejects_bad_envelope_at_once(shop, created, logs, change):
    from app.consumer import on_message
    msg = message(created | change, "order.created")
    run(on_message(msg, shop.app.state.session_factory))
    msg.nack.assert_awaited_once_with(requeue=False)
    msg.ack.assert_not_awaited()
    error, = [line for line in logs if line["level"] == "error"]
    assert "eventId" in error and error["type"] == "order.created"
    assert not messages(shop)


def test_consumer_rejects_not_json(shop, logs):
    from app.consumer import on_message
    msg = message(b"\xff{", "order.created")
    run(on_message(msg, shop.app.state.session_factory))
    msg.nack.assert_awaited_once_with(requeue=False)
    assert [line["level"] for line in logs] == ["error"]


def test_consumer_rejects_bad_payload_without_retry(shop, created, logs):
    from app.consumer import on_message
    created["payload"]["shippingCost"] = "14.9"
    sleep = AsyncMock()
    msg = message(created)
    run(on_message(msg, shop.app.state.session_factory, sleep=sleep))
    msg.nack.assert_awaited_once_with(requeue=False)
    sleep.assert_not_awaited()
    error, = logs
    assert (error["level"], error["eventId"], error["requestId"]) == ("error", created["eventId"], "checkout")
    assert "Łódź" not in json.dumps(logs)


def test_consumer_retries_then_dlq(shop, created, logs, monkeypatch):
    import app.consumer as consumer
    calls = []

    def failing(factory, event):
        calls.append(event["eventId"])
        raise ConnectionError("database down at postgres:5432")

    monkeypatch.setattr(consumer, "handle", failing)
    sleep = AsyncMock()
    msg = message(created)
    run(consumer.on_message(msg, shop.app.state.session_factory, sleep=sleep))
    assert len(calls) == 3
    (first,), (second,) = [c.args for c in sleep.await_args_list]
    assert 5 <= first <= 7.5 and 30 <= second <= 45
    msg.nack.assert_awaited_once_with(requeue=False)
    msg.ack.assert_not_awaited()
    assert [line["level"] for line in logs] == ["warning", "warning", "error"]
    assert logs[-1]["eventId"] == created["eventId"] and logs[-1]["reason"] == "ConnectionError"
    assert "postgres" not in json.dumps(logs)


def test_consumer_recovers_after_transient_error(shop, created, monkeypatch):
    import app.consumer as consumer
    attempts = []

    def flaky(factory, event):
        attempts.append(1)
        if len(attempts) == 1:
            raise ConnectionError()
        return handle(factory, event)

    monkeypatch.setattr(consumer, "handle", flaky)
    msg = message(created)
    run(consumer.on_message(msg, shop.app.state.session_factory, sleep=AsyncMock()))
    msg.ack.assert_awaited_once()
    msg.nack.assert_not_awaited()
    assert messages(shop)[0]["payload"]["newStatus"] == "PREPARING"


def test_consumer_logs_one_info_line_per_handled_event(shop, created, logs):
    from app.consumer import on_message
    from app.logging_config import set_service_log_level
    set_service_log_level("info")  # logLevel from deploy/consul/config/shipping-service.yaml
    created["requestId"] = "purchase-42"
    for _ in range(2):  # the second delivery is a duplicate of the same eventId
        msg = message(created)
        run(on_message(msg, shop.app.state.session_factory))
        msg.ack.assert_awaited_once()
    first, second = [line for line in logs if line["level"] == "info"]
    expected = {"eventId": created["eventId"], "type": "order.created", "requestId": "purchase-42",
                "orderId": created["payload"]["orderId"]}
    assert first["msg"] == "Event processed" and expected.items() <= first.items()
    assert "duplicate" in second["msg"] and expected.items() <= second.items()
    assert "Łódź" not in json.dumps(logs)


@pytest.mark.parametrize("user_id, expected", [
    ("valid", "valid"), ("not-a-uuid", None), (None, None), (12, None), ("", None)])
def test_consumer_log_has_user_id_from_payload(shop, created, logs, user_id, expected):
    from app.consumer import on_message
    from app.logging_config import user_id_var
    if user_id == "valid":
        user_id = expected = created["payload"]["userId"]
    else:
        created["payload"]["userId"] = user_id
    run(on_message(message(created), shop.app.state.session_factory))
    line = logs[-1]  # "Event processed" or, for an invalid userId, the rejection of the payload
    assert line["userId"] == expected and line["eventId"] == created["eventId"]
    assert user_id_var.get() is None  # the context does not leak into the next message


def test_consumer_logs_cancellation(shop, created, logs):
    from app.consumer import on_message
    deliver(shop, created)
    event = cancellation(created)
    run(on_message(message(event), shop.app.state.session_factory))
    line, = [line for line in logs if line["level"] == "info"]
    assert (line["msg"], line["type"], line["eventId"], line["orderId"]) == (
        "Event processed", "order.cancelled", event["eventId"], created["payload"]["orderId"])


# Outbox relay (app/relay.py)

class Exchange:
    def __init__(self, error=None):
        self.published, self.error = [], error

    async def publish(self, msg, routing_key, mandatory, timeout):
        assert mandatory and timeout == 2
        if self.error:
            raise self.error
        self.published.append((routing_key, msg))


def outbox_rows(shop):
    with shop.app.state.session_factory() as db:
        return db.scalars(select(Outbox).order_by(Outbox.seq)).all()


def test_relay_publishes_and_deletes(shop, created):
    from app.relay import relay_batch
    deliver(shop, created)
    exchange = Exchange()
    assert run(relay_batch(exchange, shop.app.state.session_factory)) == 1
    (key, msg), = exchange.published
    body = json.loads(msg.body)
    assert key == "shipment.status_changed" and msg.message_id == body["eventId"]
    assert msg.correlation_id == "checkout" and msg.app_id == "shipping-service"
    assert outbox_rows(shop) == []
    assert run(relay_batch(exchange, shop.app.state.session_factory)) == 0


def test_relay_keeps_unroutable_event(shop, created, logs):
    import aio_pika
    from app.relay import relay_batch, lease_rows
    deliver(shop, created)
    error = aio_pika.exceptions.DeliveryError(None, None)
    run(relay_batch(Exchange(error), shop.app.state.session_factory))
    row, = outbox_rows(shop)
    assert row.locked_until is not None  # leased: retried after the lease expires
    assert lease_rows(shop.app.state.session_factory) == []
    error_line, = logs
    assert error_line["level"] == "error" and error_line["eventId"] == row.envelope["eventId"]


def test_relay_broker_error_releases_rows(shop, created):
    from app.relay import relay_batch
    deliver(shop, created)
    deliver(shop, dict(created, eventId=str(uuid4()), payload=dict(created["payload"], orderId=str(uuid4()))))
    with pytest.raises(asyncio.TimeoutError):
        run(relay_batch(Exchange(asyncio.TimeoutError()), shop.app.state.session_factory))
    rows = outbox_rows(shop)
    assert len(rows) == 2 and all(row.locked_until is None for row in rows)


def test_relay_lease_expires(shop, created):
    from datetime import timedelta
    from app.relay import LEASE, _now, lease_rows
    deliver(shop, created)
    factory = shop.app.state.session_factory
    assert len(lease_rows(factory)) == 1
    assert lease_rows(factory) == []
    assert len(lease_rows(factory, now=_now() + LEASE + timedelta(seconds=1))) == 1


def test_relay_survives_database_error(monkeypatch, logs):
    import app.relay as relay
    from sqlalchemy.exc import OperationalError
    calls = []

    async def failing_batch(exchange, factory):
        calls.append(1)
        if len(calls) > 2:
            raise asyncio.CancelledError
        raise OperationalError("select", {}, Exception("host postgres"))

    async def opened(settings):
        return AsyncMock(), object()

    pauses = AsyncMock()
    monkeypatch.setattr(relay, "relay_batch", failing_batch)
    monkeypatch.setattr(relay, "_open_exchange", opened)
    monkeypatch.setattr(relay.asyncio, "sleep", pauses)
    with pytest.raises(asyncio.CancelledError):
        run(relay.run_relay(Settings(), None))
    assert len(calls) == 3
    assert all(2 <= call.args[0] <= 5 for call in pauses.await_args_list) and pauses.await_count == 2
    assert [(line["level"], line["reason"]) for line in logs] == [("warning", "OperationalError")] * 2


# Logs, configuration, Consul

def test_json_log_line_has_only_exception_class(logs):
    log = logging.getLogger("shipping.test")
    try:
        raise RuntimeError("password=secret")
    except RuntimeError:
        log.exception("failed", extra={"fields": {"eventId": "e1"}})
    line, = logs
    assert set(line) >= {"time", "level", "service", "requestId", "userId", "msg", "eventId", "reason"}
    assert line["reason"] == "RuntimeError" and "secret" not in json.dumps(line)


def test_request_log_has_request_id(shop, logs):
    shop.get("/shipping/methods", headers={"X-Request-Id": "req-42", "X-User-Id": "not-a-uuid"})
    line, = [entry for entry in logs if entry["msg"] == "HTTP request"]
    assert (line["requestId"], line["userId"], line["status"]) == ("req-42", None, 200)
    shop.get("/shipping/methods", headers={"X-Request-Id": "x" * 65})
    assert len([entry for entry in logs if entry["msg"] == "HTTP request"][-1]["requestId"]) == 36


def test_invalid_db_url_hides_password():
    from app.database import make_engine
    with pytest.raises(RuntimeError) as error:
        make_engine(Settings(db_url="postgresql+psycopg//shipping_service:e8t3-secret@postgres/shipping_db"))
    assert "e8t3-secret" not in str(error.value) and error.value.__cause__ is None
    assert error.value.__suppress_context__


def test_instance_id(monkeypatch):
    import socket
    monkeypatch.setattr(socket, "gethostname", lambda: "box1")
    assert Settings().effective_instance_id == "shipping-service-box1"
    assert Settings(instance_id="shipping-service-7d9f-abc").effective_instance_id == "shipping-service-7d9f-abc"


def test_consul_registration_fields():
    import httpx
    from app.consul_registration import ConsulRegistrar
    sent = []

    def respond(request):
        if request.method == "GET":
            return httpx.Response(404)
        sent.append((request.url.path, json.loads(request.content or b"{}")))
        return httpx.Response(200)

    settings = Settings(consul_url="http://consul:8500", service_address="10.0.0.7", instance_id="ship-1")
    registrar = ConsulRegistrar(settings, transport=httpx.MockTransport(respond), check_interval=10)

    async def scenario():
        task = asyncio.create_task(registrar.run())
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    run(scenario())
    (path, body), (deregister, _) = sent
    assert path == "/v1/agent/service/register" and deregister == "/v1/agent/service/deregister/ship-1"
    assert set(body) == {"ID", "Name", "Address", "Port", "Check"}
    assert set(body["Check"]) == {"HTTP", "Interval", "Timeout", "DeregisterCriticalServiceAfter", "Status"}
    assert body["Check"]["Status"] == "passing" and body["Check"]["HTTP"] == "http://10.0.0.7:8089/health/ready"
    assert (body["ID"], body["Name"], body["Port"]) == ("ship-1", "shipping-service", 8089)


def test_consul_first_registration_replaces_entry_of_killed_process():
    import httpx
    from app.consul_registration import ConsulRegistrar
    calls = []

    def respond(request):
        calls.append((request.method, request.url.path))
        if request.url.path == "/v1/health/service/shipping-service":  # only our own entry (Z7: nothing to remove)
            return httpx.Response(200, json=[consul_item("ship-1", "10.0.0.7", 8089)])
        if request.method == "GET":  # entry left by the previous process (same ID)
            return httpx.Response(200, json={"ID": "ship-1", "Address": "10.0.0.7", "Port": 8089})
        return httpx.Response(200)

    settings = Settings(consul_url="http://consul:8500", service_address="10.0.0.7", instance_id="ship-1")
    registrar = ConsulRegistrar(settings, transport=httpx.MockTransport(respond), check_interval=10)

    async def scenario():
        task = asyncio.create_task(registrar.run())
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    run(scenario())
    assert calls[:4] == [("GET", "/v1/health/service/shipping-service"), ("GET", "/v1/agent/service/ship-1"),
                         ("PUT", "/v1/agent/service/deregister/ship-1"), ("PUT", "/v1/agent/service/register")]


def consul_item(service_id, address, port):
    return {"Node": {"Address": "10.0.0.9"},
            "Service": {"ID": service_id, "Service": "shipping-service", "Address": address, "Port": port}}


def run_registrar(respond, seconds=0.05, **kwargs):
    """Runs the registration of ship-1 (10.0.0.7:8089) for a moment, then stops it like SIGTERM does."""
    import httpx
    from app.consul_registration import ConsulRegistrar
    settings = Settings(consul_url="http://consul:8500", service_address="10.0.0.7", instance_id="ship-1")
    registrar = ConsulRegistrar(settings, transport=httpx.MockTransport(respond), **{"check_interval": 10, **kwargs})

    async def scenario():
        task = asyncio.create_task(registrar.run())
        await asyncio.sleep(seconds)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    run(scenario())


def consul_with(calls, health, errors=None):
    """Consul without an entry for ship-1; GET /v1/health/service/shipping-service lists `health`.
    errors: {(method, path): httpx.Response or an httpx exception class}; calls get (method, path, query)."""
    import httpx

    def respond(request):
        key = (request.method, request.url.path)
        calls.append((*key, request.url.query.decode()))
        error = (errors or {}).get(key)
        if isinstance(error, type):
            raise error("mock", request=request)
        if error is not None:
            return error
        if key == ("GET", "/v1/health/service/shipping-service"):
            return httpx.Response(200, json=[consul_item(*entry) for entry in health])
        return httpx.Response(404) if request.method == "GET" else httpx.Response(200)
    return respond


def removed(calls):
    return [path.rsplit("/", 1)[1] for _, path, _ in calls if "/deregister/" in path]


ORPHAN = ("shipping-service-old", "10.0.0.7", 8089)  # killed container whose IP the new one got


def test_consul_first_registration_removes_orphans_with_our_address_and_port(caplog):
    caplog.set_level(logging.INFO, logger="shipping.consul")
    calls = []
    run_registrar(consul_with(calls, [ORPHAN, ("shipping-service-other-ip", "10.0.0.8", 8089),
                                      ("shipping-service-other-port", "10.0.0.7", 9089),
                                      ("shipping-service-old-2", "10.0.0.7", 8089)]))
    assert ("GET", "/v1/health/service/shipping-service", "") in calls  # no query: allowed by consul-guard
    assert removed(calls) == ["shipping-service-old", "shipping-service-old-2", "ship-1"]  # last one: shutdown
    assert calls.index(("PUT", "/v1/agent/service/register", "")) > calls.index(
        ("PUT", "/v1/agent/service/deregister/shipping-service-old-2", ""))
    assert [r.fields for r in caplog.records if r.getMessage() == "Removed an orphaned entry from Consul"] == [
        {"removedId": "shipping-service-old"}, {"removedId": "shipping-service-old-2"}]


@pytest.mark.parametrize("key,error", [
    (("GET", "/v1/health/service/shipping-service"), 500),
    (("GET", "/v1/health/service/shipping-service"), "not json"),
    (("GET", "/v1/health/service/shipping-service"), {"unexpected": "shape"}),
    (("PUT", "/v1/agent/service/deregister/shipping-service-old"), 403),  # e.g. consul-guard refuses
])
def test_consul_cleanup_error_does_not_block_registration(caplog, key, error):
    import httpx
    caplog.set_level(logging.INFO, logger="shipping.consul")
    response = (httpx.Response(error) if isinstance(error, int) else httpx.Response(200, text=error)
                if isinstance(error, str) else httpx.Response(200, json=error))
    calls = []
    run_registrar(consul_with(calls, [ORPHAN], {key: response}))
    assert ("PUT", "/v1/agent/service/register", "") in calls
    assert [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING] == [
        "Could not remove orphaned entries from Consul, registering anyway"]


def test_consul_refused_orphan_does_not_stop_the_cleanup(caplog):
    # CR-34: two orphans, the first deregistration refused (403, e.g. reaped meanwhile) -> the second is removed.
    import httpx
    caplog.set_level(logging.INFO, logger="shipping.consul")
    calls = []
    run_registrar(consul_with(calls, [ORPHAN, ("shipping-service-old-2", "10.0.0.7", 8089)],
                              {("PUT", "/v1/agent/service/deregister/shipping-service-old"): httpx.Response(403)}))
    assert removed(calls) == ["shipping-service-old", "shipping-service-old-2", "ship-1"]
    assert [r.fields for r in caplog.records if r.getMessage() == "Removed an orphaned entry from Consul"] == [
        {"removedId": "shipping-service-old-2"}]
    warning, = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert warning.fields == {"reason": "HTTPStatusError", "failed": 1}
    assert ("PUT", "/v1/agent/service/register", "") in calls


def registered_status(calls_bodies):
    return [body["Check"]["Status"] for path, body in calls_bodies if path == "/v1/agent/service/register"]


@pytest.mark.parametrize("ready,expected", [(lambda: True, "passing"), (lambda: False, "critical"),
                                            (lambda: 1 / 0, "critical")])
def test_consul_status_follows_current_readiness(ready, expected):
    # CR-35: "Status" from the same check as /health/ready, also for a registration after the entry disappeared.
    import httpx
    sent, present = [], [False]

    def respond(request):
        if request.url.path == "/v1/health/service/shipping-service":
            return httpx.Response(200, json=[])
        if request.method == "GET":
            return httpx.Response(200, json={"ID": "ship-1", "Address": "10.0.0.7", "Port": 8089}) \
                if present[0] else httpx.Response(404)
        if request.url.path == "/v1/agent/service/register":
            sent.append((request.url.path, json.loads(request.content)))
            present[0] = len(sent) > 1  # Consul "removes" the first entry, keeps the second
        return httpx.Response(200)

    run_registrar(respond, seconds=0.1, check_interval=0.01, is_ready=ready)
    assert registered_status(sent) == [expected, expected]  # first registration and the re-registration


def test_consul_status_from_readiness_in_the_app(tmp_path, monkeypatch):
    # The app passes its /health/ready checks to the registrar: database reachable -> passing.
    import app.main as main
    seen = {}

    class Recorder:
        def __init__(self, settings, is_ready):
            seen["ready"] = is_ready

        async def run(self):
            seen["value"] = await asyncio.to_thread(seen["ready"])

    monkeypatch.setattr(main, "ConsulRegistrar", Recorder)
    settings = Settings(db_url=f"sqlite:///{tmp_path}/s.db", consul_enabled=True, broker_enabled=False, log_level="info")
    with TestClient(main.create_app(settings)):
        for _ in range(100):
            if "value" in seen:
                break
            asyncio.run(asyncio.sleep(0.01))
    assert seen["value"] is True


def test_consul_cleanup_only_at_first_registration():
    calls = []
    run_registrar(consul_with(calls, [ORPHAN]), seconds=0.2, check_interval=0.01)
    assert sum(path == "/v1/health/service/shipping-service" for _, path, _ in calls) == 1
    assert sum(path == "/v1/agent/service/ship-1" for _, path, _ in calls) > 3  # periodic checks went on
    assert removed(calls) == ["shipping-service-old", "ship-1"]  # last one: shutdown


@pytest.mark.parametrize("error", ["ConnectError", "ReadTimeout"])
def test_consul_cleanup_waits_for_first_successful_contact(caplog, error):
    """No connection to Consul ends the attempt like the registration: no cleanup warning per retry."""
    import httpx
    caplog.set_level(logging.INFO, logger="shipping.consul")
    calls, down = [], [3]
    reachable = consul_with(calls, [ORPHAN])

    def respond(request):
        if down[0]:
            down[0] -= 1
            calls.append(("down", request.url.path, ""))
            raise getattr(httpx, error)("consul down", request=request)
        return reachable(request)

    run_registrar(respond, seconds=0.3, retry_initial=0.01, retry_max=0.02)
    assert [c[:2] for c in calls[:5]] == [("down", "/v1/health/service/shipping-service")] * 3 + [
        ("GET", "/v1/health/service/shipping-service"), ("PUT", "/v1/agent/service/deregister/shipping-service-old")]
    assert ("PUT", "/v1/agent/service/register", "") in calls
    assert [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING] == [
        "Consul unavailable, registration will be retried"]


def test_postgres_connection_has_keepalives_and_user_timeout(monkeypatch):
    # CR-13: a PostgreSQL that vanished from the network is detected within seconds, not minutes.
    import app.database as database
    captured = {}
    monkeypatch.setattr(database, "create_engine", lambda url, **kwargs: captured.update(kwargs))
    database.make_engine(Settings(db_url="postgresql+psycopg://shipping_service:x@db:5432/shipping_db"))
    assert captured["connect_args"] == {"connect_timeout": 2, "keepalives": 1, "keepalives_idle": 5,
                                        "keepalives_interval": 2, "keepalives_count": 2, "tcp_user_timeout": 5000}
    assert captured["pool_pre_ping"] is True


def test_ready_answers_503_when_the_database_hangs(shop, monkeypatch):
    # CR-42: the database check of /health/ready runs in a thread with a limit (1.5 s in the service).
    import time
    import app.main as main
    assert main.READY_TIMEOUT == 1.5
    monkeypatch.setattr(main, "READY_TIMEOUT", 0.2)
    monkeypatch.setattr(main, "database_ping", lambda engine: time.sleep(1))
    started = time.monotonic()
    response = shop.get("/health/ready")
    assert response.status_code == 503 and time.monotonic() - started < 0.9
    assert response.json()["status"] == 503 and response.json()["message"] == "Baza przesyłek niedostępna"
    assert shop.get("/health/live").status_code == 200


def test_uvicorn_traceback_text_is_reduced_to_class():
    record = logging.LogRecord("uvicorn.error", logging.ERROR, __file__, 1,
                               "Traceback (most recent call last):\n  File \"x.py\"\npsycopg.OperationalError: "
                               "connection to server at \"postgress\" failed\n"
                               "(Background on this error at: https://sqlalche.me/e/20/e3q8)", None, None)
    line = json.loads(JsonFormatter("shipping-service").format(record))
    assert (line["msg"], line["reason"]) == ("Unhandled exception", "OperationalError")
    assert "postgress" not in json.dumps(line)
