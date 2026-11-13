"""Cases from the review of PR #12 (docs/events.md, "Jak odbierać")."""

import asyncio
import logging
import uuid
from time import monotonic

import aio_pika
import httpx
from fastapi.testclient import TestClient

from app import consumer as consumer_module
from app.config import Settings
from app.consul import Discovery
from app.logs import logger
from app.main import create_app

from .conftest import FakeMailer, FakeMessage, FakeStore, order_cancelled, order_created, registered, shipment
from .test_consumer import deliver


class Records(logging.Handler):
    def __init__(self):
        super().__init__()
        self.messages = []

    def emit(self, record):
        self.messages.append((record.levelname, record.getMessage(), getattr(record, "fields", {})))


def capture_logs():
    records = Records()
    logger.addHandler(records)
    return records


# ----- 3: the consumer must not stop without a trace -----

class FakeChannel:
    def __init__(self, queue_checks_before_delete):
        self.left = queue_checks_before_delete

    async def set_qos(self, prefetch_count):
        pass

    async def get_queue(self, name, ensure=True):
        if self.left == 0:
            raise aio_pika.exceptions.ChannelNotFoundEntity("NOT_FOUND - no queue 'notification.q'")
        self.left -= 1
        channel = self

        class Queue:
            async def consume(self, callback):
                channel.consuming = True

        return Queue()


class FakeConnection:
    def __init__(self, channel):
        self._channel = channel

    async def channel(self):
        return self._channel

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def test_deleted_queue_ends_the_consumer_with_a_log_and_503(monkeypatch):
    channel = FakeChannel(queue_checks_before_delete=3)  # open, 2 checks pass, the 3rd finds no queue

    async def connect_robust(**kwargs):
        return FakeConnection(channel)

    monkeypatch.setattr(consumer_module.aio_pika, "connect_robust", connect_robust)
    monkeypatch.setattr(consumer_module.Consumer, "queue_check_seconds", 0.01)
    records = capture_logs()
    try:
        settings = Settings(consul_enabled=False, rabbitmq_host="rabbitmq", instance_id="n-test")
        with TestClient(create_app(settings, store=FakeStore(), mailer=FakeMailer())) as client:
            deadline = monotonic() + 3
            while client.get("/health/ready").status_code == 200 and monotonic() < deadline:
                asyncio.run(asyncio.sleep(0.02))
            assert client.get("/health/ready").status_code == 503
    finally:
        logger.removeHandler(records)
    stopped = [r for r in records.messages if r[1].startswith("Event consumer stopped")]
    assert stopped and stopped[0][0] == "ERROR"
    assert stopped[0][2]["reason"] == "ChannelNotFoundEntity"


def test_broker_outage_during_queue_check_does_not_end_the_consumer(monkeypatch):
    class Flaky(FakeChannel):
        checks = 0

        async def get_queue(self, name, ensure=True):
            Flaky.checks += 1
            if Flaky.checks > 1:
                raise aio_pika.exceptions.AMQPConnectionError("broker restarting")
            return await super().get_queue(name, ensure)

    async def connect_robust(**kwargs):
        return FakeConnection(Flaky(queue_checks_before_delete=10))

    monkeypatch.setattr(consumer_module.aio_pika, "connect_robust", connect_robust)

    async def scenario():
        c = consumer_module.Consumer(Settings(rabbitmq_host="rabbitmq"), FakeStore(), FakeMailer(), None)
        c.queue_check_seconds = 0.01
        task = asyncio.create_task(c.run())
        await asyncio.sleep(0.2)
        alive = not task.done()
        task.cancel()
        return alive

    assert asyncio.run(scenario())
    assert Flaky.checks > 3


# ----- 4: eventId and requestId of the envelope -----

def test_event_id_must_be_a_uuid(consumer, mailer):
    for bad in ("1", "not-a-uuid", "{a0000000-0000-4000-8000-000000000001}"):
        assert deliver(consumer, FakeMessage(registered() | {"eventId": bad})).result == "nack", bad
    assert mailer.sent == []


def test_strange_request_id_is_replaced(consumer, mailer, user):
    for strange in ("zamówienie-ą", "a b", "x" * 65, ""):
        message = deliver(consumer, FakeMessage(order_created() | {"requestId": strange}))
        assert message.result == "ack", strange
        uuid.UUID(user.requests[-1].headers["X-Request-Id"])  # a new, valid id went to User
    assert len(mailer.sent) == 4


def test_strange_request_ids_do_not_open_the_breaker_for_others(consumer, mailer):
    for _ in range(10):
        deliver(consumer, FakeMessage(order_created() | {"requestId": "żółw"}))
    assert deliver(consumer, FakeMessage(order_created())).result == "ack"
    assert len(mailer.sent) == 11


# ----- 5: permanent refusal without retries, retries with a random spread -----

def test_permanent_refusal_of_user_goes_to_dlq_at_once(consumer, mailer, user):
    for status in (400, 401, 403, 422):
        user.requests.clear()
        user.answer = lambda request, status=status: httpx.Response(status, json={"status": status})
        assert deliver(consumer, FakeMessage(order_created())).result == "nack", status
        assert len(user.requests) == 1, status  # no retries
    assert mailer.sent == []


def test_answer_outside_the_contract_goes_to_dlq_at_once(consumer, user):
    user.answer = lambda request: httpx.Response(200, json={"id": "x"})
    assert deliver(consumer, FakeMessage(order_created())).result == "nack"
    assert len(user.requests) == 1


def test_permanent_refusals_do_not_open_the_breaker(consumer, mailer, user):
    user.answer = lambda request: httpx.Response(403, json={"status": 403})
    for _ in range(10):
        deliver(consumer, FakeMessage(order_created()))
    user.answer = FakeUserOk()
    assert deliver(consumer, FakeMessage(order_created())).result == "ack"


class FakeUserOk:
    def __call__(self, request):
        return httpx.Response(200, json={"id": "x", "firstName": "Anna", "email": "anna.nowak@example.com"})


def test_temporary_errors_still_retried_3_times(consumer, user):
    for status in (408, 429):
        user.requests.clear()
        user.answer = lambda request, status=status: httpx.Response(status)
        assert deliver(consumer, FakeMessage(order_created())).result == "nack"
        assert len(user.requests) == 3, status  # 3 consumer attempts, 408/429 not retried inside D2


def test_retry_delays_get_a_random_spread(consumer, mailer, monkeypatch):
    spreads = []

    def uniform(low, high):
        spreads.append((low, high))
        return 1.0

    monkeypatch.setattr(consumer_module.random, "uniform", uniform)
    mailer.failures = 2
    assert deliver(consumer, FakeMessage(registered())).result == "ack"
    assert spreads == [(1, 1.5), (1, 1.5)]


# ----- 6: only the fields the e-mails use are required -----

def test_events_without_fields_the_emails_do_not_use(consumer, mailer):
    created = order_created()
    for line in created["payload"]["items"]:
        del line["productId"]
    cancelled = order_cancelled()
    cancelled["payload"]["items"] = [{"quantity": 2, "productId": 12345}]  # another format: ignored
    shipped = shipment("SHIPPED")
    del shipped["payload"]["shipmentId"]
    for event in (created, cancelled, shipped):
        assert deliver(consumer, FakeMessage(event)).result == "ack", event["type"]
    assert len(mailer.sent) == 3


# ----- 2 (same Discovery as Product): a hanging Consul must not queue the requests -----

def test_hanging_consul_parallel_lookups_share_one_query():
    calls = []

    async def consul(request):
        calls.append(request)
        await asyncio.sleep(0.3)
        raise httpx.ReadTimeout("no answer", request=request)

    async def scenario():
        found = Discovery(httpx.AsyncClient(base_url="http://consul", transport=httpx.MockTransport(consul)))
        start = monotonic()
        results = await asyncio.gather(*(found.pick("user-service") for _ in range(5)))
        took = monotonic() - start
        assert await found.pick("user-service") is None  # the failure is remembered
        return results, took

    results, took = asyncio.run(scenario())
    assert results == [None] * 5 and took < 0.6 and len(calls) == 1
