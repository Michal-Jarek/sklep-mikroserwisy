"""Consumer of order.q and outbox relay (W3, W4, S8): separate tasks and connections, retries, DLQ, lease."""
import asyncio
import json
from functools import partial
from types import SimpleNamespace
from uuid import uuid4

import aio_pika
import pytest
from sqlalchemy.exc import OperationalError

from app import consumer, relay, store
from app.events import InvalidEvent, handle, parse_envelope
from tests.conftest import outbox
from tests.test_orders import create, shipment_event


class FakeMessage:
    def __init__(self, body: bytes, routing_key: str = "shipment.status_changed", message_id=None):
        self.body, self.routing_key, self.message_id = body, routing_key, message_id
        self.result = None

    async def ack(self):
        self.result = "ack"

    async def nack(self, requeue=True):
        self.result = ("nack", requeue)


def run(coro):
    return asyncio.run(coro)


def no_sleep(monkeypatch):
    monkeypatch.setattr(consumer, "RETRY_DELAYS", (0.001, 0.002))


@pytest.mark.parametrize("body,key", [
    (b"not json", "shipment.status_changed"),
    (json.dumps({"eventId": "x", "type": "shipment.status_changed", "version": 1, "occurredAt": "t",
                 "requestId": "r", "payload": {}}).encode(), "shipment.status_changed"),
    (shipment_event(str(uuid4()), str(uuid4()), "SHIPPED"), "order.cancelled"),  # body type != routing key
    (shipment_event(str(uuid4()), str(uuid4()), "LOST"), "shipment.status_changed"),
])
def test_invalid_envelope_goes_to_dlq_at_once(caplog, body, key):
    calls = []
    message = FakeMessage(body, key)
    run(consumer.on_message(message, calls.append))
    assert message.result == ("nack", False) and not calls
    [line] = [r for r in caplog.records if r.levelname == "ERROR"]
    assert line.fields["type"] == key


def test_request_id_rule():
    raw = json.loads(shipment_event(str(uuid4()), str(uuid4()), "SHIPPED"))
    raw["requestId"] = "bad id with spaces"
    event = parse_envelope(json.dumps(raw).encode(), "shipment.status_changed")
    assert event.request_id != raw["requestId"] and len(event.request_id) == 36
    raw["eventId"] = "not-a-uuid"
    with pytest.raises(InvalidEvent):
        parse_envelope(json.dumps(raw).encode(), "shipment.status_changed")


def test_temporary_error_three_attempts_then_dlq(monkeypatch, caplog):
    no_sleep(monkeypatch)
    attempts = []

    def failing(event):
        attempts.append(event.event_id)
        raise OperationalError("SELECT", {}, Exception("db down"))

    raw = shipment_event(str(uuid4()), str(uuid4()), "SHIPPED")
    message = FakeMessage(raw)
    run(consumer.on_message(message, failing))
    assert message.result == ("nack", False) and len(attempts) == 3
    errors = [r for r in caplog.records if r.levelname == "ERROR"]
    assert len(errors) == 1 and errors[0].fields["eventId"] == json.loads(raw)["eventId"]
    assert errors[0].fields["reason"] == "OperationalError"
    assert len([r for r in caplog.records if r.levelname == "WARNING"]) == 2


def test_recovers_within_retries(monkeypatch):
    delays = []

    def short_delay(base):
        delays.append(base)
        return 0.001

    monkeypatch.setattr(consumer, "retry_delay", short_delay)
    outcomes = [OperationalError("SELECT", {}, Exception()), None]

    def flaky(event):
        if outcomes.pop(0):
            raise OperationalError("SELECT", {}, Exception())
        return "processed"

    message = FakeMessage(shipment_event(str(uuid4()), str(uuid4()), "SHIPPED"))
    run(consumer.on_message(message, flaky))
    assert message.result == "ack" and delays == [5]  # first retry after 5 s (+ jitter)


def test_retry_delays_have_jitter():
    assert consumer.retry_delay(5, lambda: 0) == 5 and consumer.retry_delay(5, lambda: 1) == 7.5
    assert consumer.retry_delay(30, lambda: 1) == 45


def test_consumer_effect_through_message(client, headers, body):
    order = create(client, headers, body)
    message = FakeMessage(shipment_event(order["id"], headers["X-User-Id"], "DELIVERED"))
    run(consumer.on_message(message, partial(handle, client.app.state.session_factory)))
    assert message.result == "ack"
    assert client.get(f"/orders/{order['id']}", headers=headers).json()["status"] == "DELIVERED"



def envelope(order_id: str, user_id: str, status: str, request_id: str | None) -> bytes:
    raw = json.loads(shipment_event(order_id, user_id, status))
    raw["requestId"] = request_id
    return json.dumps(raw).encode()


def test_consumer_logs_one_info_line_per_event(client, headers, body, json_logs):
    order = create(client, headers, body)
    raw = envelope(order["id"], headers["X-User-Id"], "SHIPPED", "e8t2-p5-event")
    for _ in range(2):  # the same message delivered twice
        message = FakeMessage(raw)
        run(consumer.on_message(message, partial(handle, client.app.state.session_factory)))
        assert message.result == "ack"
    lines = [line for line in json_logs if line["level"] == "info"]
    assert [line["msg"] for line in lines] == [
        "Event processed", "Event already processed (duplicate eventId), acknowledged"]
    for line in lines:
        assert line["eventId"] == json.loads(raw)["eventId"] and line["type"] == "shipment.status_changed"
        assert line["orderId"] == order["id"] and line["userId"] == headers["X-User-Id"]
        assert line["requestId"] == "e8t2-p5-event"
    assert client.get(f"/orders/{order['id']}", headers=headers).json()["status"] == "SHIPPED"


def test_consumer_logs_type_not_handled(json_logs):
    raw = json.dumps({"eventId": str(uuid4()), "type": "order.created", "version": 1, "occurredAt": "t",
                      "requestId": "e8t2-p5-other", "payload": {}}).encode()
    message = FakeMessage(raw, "order.created")
    run(consumer.on_message(message, partial(handle, None)))
    assert message.result == "ack"
    [line] = json_logs
    assert line["level"] == "info" and line["msg"] == "Event type not handled, acknowledged"
    assert line["type"] == "order.created" and line["requestId"] == "e8t2-p5-other" and line["orderId"] is None


@pytest.mark.parametrize("raw,logged", [
    (envelope(str(uuid4()), str(uuid4()), "SHIPPED", "e8t2-p5-bad"), "e8t2-p5-bad"),
    (envelope(str(uuid4()), str(uuid4()), "SHIPPED", "bad id with spaces"), None),
    (envelope(str(uuid4()), str(uuid4()), "SHIPPED", None), None),
    (b"not json", None),
])
def test_rejected_envelope_logs_its_valid_request_id(json_logs, raw, logged):
    message = FakeMessage(raw, "order.cancelled")  # type differs from the routing key
    run(consumer.on_message(message, partial(handle, None)))
    assert message.result == ("nack", False)
    [line] = json_logs
    assert line["level"] == "error" and line["msg"] == "Event rejected to order.dlq: invalid envelope"
    assert line["requestId"] == logged and line["type"] == "order.cancelled"

class FakeExchange:
    def __init__(self, behaviour=None):
        self.published, self.behaviour = [], behaviour or {}

    async def publish(self, message, routing_key, mandatory, timeout):
        error = self.behaviour.get(routing_key)
        if error == "hang":
            await asyncio.sleep(60)
        if error:
            raise error
        assert mandatory and message.delivery_mode == aio_pika.DeliveryMode.PERSISTENT
        self.published.append((routing_key, json.loads(message.body)))


def test_relay_publishes_and_deletes(client, headers, body):
    order = create(client, headers, body)
    client.post(f"/orders/{order['id']}/cancel", headers=headers)
    exchange = FakeExchange()
    assert run(relay.relay_batch(client.app.state.session_factory, exchange)) == 2
    assert [key for key, _ in exchange.published] == ["order.created", "order.cancelled"]
    created = exchange.published[0][1]
    assert created["payload"]["orderId"] == order["id"] and "4111" not in json.dumps(created)
    assert outbox(client) == []


def returned_error():
    from pamqp.commands import Basic
    return aio_pika.exceptions.PublishError(SimpleNamespace(delivery=Basic.Return()), None)


def test_relay_keeps_a_returned_message_and_sends_the_rest(client, headers, body, caplog):
    order = create(client, headers, body)
    client.post(f"/orders/{order['id']}/cancel", headers=headers)
    exchange = FakeExchange({"order.created": returned_error()})
    assert run(relay.relay_batch(client.app.state.session_factory, exchange)) == 1
    assert [key for key, _ in exchange.published] == ["order.cancelled"]
    assert [e["type"] for e in outbox(client)] == ["order.created"]
    [error] = [r for r in caplog.records if r.levelname == "ERROR"]
    assert error.fields["type"] == "order.created"
    # Leased: not taken again before the lease ends.
    assert run(relay.relay_batch(client.app.state.session_factory, FakeExchange())) == 0


def test_relay_broker_error_frees_the_batch(client, headers, body, monkeypatch):
    monkeypatch.setattr(relay, "PUBLISH_TIMEOUT", 0.05)
    create(client, headers, body)
    with pytest.raises(TimeoutError):
        run(relay.relay_batch(client.app.state.session_factory, FakeExchange({"order.created": "hang"})))
    assert run(relay.relay_batch(client.app.state.session_factory, FakeExchange())) == 1


class FakeQueue:
    def __init__(self):
        self.callback = None

    async def consume(self, callback):
        self.callback = callback


class FakeChannel:
    def __init__(self, connection):
        self.connection, self.is_closed = connection, False

    async def set_qos(self, prefetch_count):
        self.connection.prefetch = prefetch_count

    async def get_queue(self, name, ensure):
        assert ensure  # passive
        self.connection.queue_checks += 1
        if self.connection.queue_missing and self.connection.queue_checks > 1:
            raise aio_pika.exceptions.ChannelNotFoundEntity()
        return self.connection.queue

    async def get_exchange(self, name, ensure):
        assert name == "shop.events" and ensure is False
        return FakeExchange()


class FakeConnection:
    def __init__(self, kwargs, queue_missing=False):
        self.kwargs, self.name = kwargs, kwargs["client_properties"]["name"]
        self.queue, self.closed, self.queue_checks, self.queue_missing = FakeQueue(), False, 0, queue_missing

    async def channel(self, **kwargs):
        self.channel_kwargs = kwargs
        return FakeChannel(self)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        self.closed = True


def broker_settings():
    return SimpleNamespace(rabbitmq_host="rabbitmq", rabbitmq_port=5672, rabbitmq_user="order-service",
                           rabbitmq_password="test-only")


def test_relay_database_error_does_not_touch_the_consumer(monkeypatch, caplog):
    connections = []

    async def connect_robust(**kwargs):
        connections.append(FakeConnection(kwargs))
        return connections[-1]

    def database_down(factory):
        raise OperationalError("SELECT", {}, Exception("db down"))

    monkeypatch.setattr(aio_pika, "connect_robust", connect_robust)
    monkeypatch.setattr(store, "lease_outbox", database_down)
    monkeypatch.setattr(relay, "ERROR_PAUSE", (0.01, 0.02))

    async def scenario():
        tasks = [asyncio.create_task(consumer.run_consumer(broker_settings(), None, "order-service-a")),
                 asyncio.create_task(relay.run_relay(broker_settings(), None, "order-service-a"))]
        await asyncio.sleep(0.3)
        assert not any(task.done() for task in tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    run(scenario())
    by_name = {c.name: c for c in connections}
    assert set(by_name) == {"order-service-a", "order-service-a-relay"} and len(connections) == 2
    assert by_name["order-service-a"].queue.callback is not None and by_name["order-service-a"].prefetch == 10
    assert by_name["order-service-a-relay"].channel_kwargs == {"publisher_confirms": True, "on_return_raises": True}
    relay_warnings = [r for r in caplog.records if r.name == "app.relay" and r.levelname == "WARNING"]
    assert len(relay_warnings) > 3 and relay_warnings[0].fields["reason"] == "OperationalError"
    assert not [r for r in caplog.records if r.name == "app.consumer" and r.levelname == "WARNING"]


def test_deleted_queue_reconnects(monkeypatch, caplog):
    connections = []

    async def connect_robust(**kwargs):
        connections.append(FakeConnection(kwargs, queue_missing=not connections))
        return connections[-1]

    monkeypatch.setattr(aio_pika, "connect_robust", connect_robust)
    monkeypatch.setattr(consumer, "QUEUE_CHECK_SECONDS", 0.01)
    monkeypatch.setattr(consumer, "RECONNECT_DELAY", 0.01)

    async def scenario():
        task = asyncio.create_task(consumer.run_consumer(broker_settings(), None, "order-service-a"))
        await asyncio.sleep(0.2)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    run(scenario())
    assert len(connections) == 2 and connections[0].closed and connections[1].queue.callback is not None
    [warning] = [r for r in caplog.records if r.name == "app.consumer" and r.levelname == "WARNING"]
    assert warning.fields["reason"] == "ChannelNotFoundEntity"
