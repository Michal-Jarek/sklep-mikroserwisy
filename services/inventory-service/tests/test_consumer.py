import asyncio
import json

import aio_pika
import pytest

from app import consumer
from app.config import Settings

ENVELOPE = {"eventId": "e0000000-0000-4000-8000-000000000001", "type": "order.cancelled"}
VALID_BODY = json.dumps({
    "eventId": "e0000000-0000-4000-8000-000000000001",
    "type": "order.cancelled",
    "occurredAt": "2026-11-14T10:00:00Z",
    "version": 1,
    "requestId": "req-1",
    "payload": {"orderId": "a1b2c3d4-0000-4000-8000-000000000001"},
}).encode()


def run(handler, delays=(5, 30)):
    sleeps = []

    async def fake_sleep(seconds):
        sleeps.append(seconds)

    asyncio.run(consumer.process_with_retries(handler, ENVELOPE, delays=delays, sleep=fake_sleep))
    return sleeps


def test_success_needs_one_attempt():
    calls = []
    assert run(lambda e: calls.append(e)) == []
    assert len(calls) == 1


def test_transient_errors_are_retried_after_5s_then_30s_plus_up_to_50_percent():
    calls = []

    def flaky(envelope):
        calls.append(1)
        if len(calls) < 3:
            raise RuntimeError("baza chwilowo niedostępna")

    first, second = run(flaky)
    assert 5 <= first <= 7.5 and 30 <= second <= 45
    assert len(calls) == 3


def test_third_failure_is_raised_so_message_can_be_nacked_without_requeue():
    calls = []

    def always_fails(envelope):
        calls.append(1)
        raise RuntimeError("błąd")

    with pytest.raises(RuntimeError):
        run(always_fails)
    assert len(calls) == consumer.MAX_ATTEMPTS == 3


# --- _on_message: każda wiadomość kończy się ack albo nack(requeue=False) -----------

class FakeMessage:
    def __init__(self, body: bytes, routing_key="order.cancelled"):
        self.body = body
        self.routing_key = routing_key
        self.acked = False
        self.nacked = []

    async def ack(self):
        self.acked = True

    async def nack(self, requeue=True):
        self.nacked.append(requeue)


def deliver(message, handler, monkeypatch):
    async def no_sleep(seconds):
        pass

    original = consumer.process_with_retries
    monkeypatch.setattr(consumer, "process_with_retries", lambda h, e: original(h, e, sleep=no_sleep))
    asyncio.run(consumer._on_message(message, handler))


def test_processed_message_is_acked(monkeypatch):
    seen = []
    message = FakeMessage(VALID_BODY)
    deliver(message, seen.append, monkeypatch)
    assert message.acked and message.nacked == []
    assert seen[0]["requestId"] == "req-1"


@pytest.mark.parametrize("body", [b"nie json", b'{"a":' * 100_000 + b"1" + b"}" * 100_000, b"[1]"])
def test_bad_envelope_is_nacked_without_requeue_and_handler_is_not_called(body, monkeypatch):
    seen = []
    message = FakeMessage(body)
    deliver(message, seen.append, monkeypatch)
    assert message.nacked == [False] and not message.acked
    assert seen == []


def test_forged_type_is_nacked(monkeypatch):
    message = FakeMessage(VALID_BODY, routing_key="shipment.status_changed")
    deliver(message, lambda e: None, monkeypatch)
    assert message.nacked == [False]


def test_message_is_nacked_without_requeue_after_three_failures(monkeypatch):
    calls = []

    def always_fails(envelope):
        calls.append(1)
        raise RuntimeError("baza niedostępna")

    message = FakeMessage(VALID_BODY)
    deliver(message, always_fails, monkeypatch)
    assert len(calls) == 3
    assert message.nacked == [False] and not message.acked


def test_rejected_envelope_log_has_readable_ids():
    body = json.dumps({"eventId": "E0000000-0000-4000-8000-000000000009", "requestId": "req-9", "type": 5}).encode()
    assert consumer._readable_ids(body) == {"eventId": "e0000000-0000-4000-8000-000000000009", "requestId": "req-9"}
    assert consumer._readable_ids(json.dumps({"eventId": "x" * 100, "requestId": "a b"}).encode()) == {}
    assert consumer._readable_ids(b"nie json") == {}


# --- sprawdzanie kolejki i ponowne połączenie ----------------------------------------

class FakeChannel:
    def __init__(self, queue_results):
        self.queue_results = list(queue_results)  # kolejne wyniki get_queue: obiekt kolejki albo wyjątek
        self.get_queue_calls = 0

    async def set_qos(self, prefetch_count):
        self.prefetch = prefetch_count

    async def get_queue(self, name, ensure=True):
        assert name == "inventory.q" and ensure is True  # tylko pasywnie
        self.get_queue_calls += 1
        result = self.queue_results.pop(0) if self.queue_results else FakeQueue()
        if isinstance(result, Exception):
            raise result
        return result


class FakeQueue:
    async def consume(self, callback):
        self.callback = callback


def not_found():
    return aio_pika.exceptions.ChannelNotFoundEntity("NOT_FOUND - no queue 'inventory.q'")


def test_watch_queue_raises_when_queue_is_gone_and_skips_connection_errors(monkeypatch):
    monkeypatch.setattr(consumer, "QUEUE_CHECK_INTERVAL", 0)
    channel = FakeChannel([FakeQueue(), ConnectionError("broker restart"), RuntimeError("channel closed"), not_found()])
    with pytest.raises(aio_pika.exceptions.ChannelNotFoundEntity):
        asyncio.run(consumer.watch_queue(channel))
    assert channel.get_queue_calls == 4


class FakeConnection:
    def __init__(self, channel):
        self._channel = channel

    async def channel(self):
        return self._channel

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def test_missing_queue_leads_to_reconnect_until_queue_is_back(monkeypatch):
    """Kolejka znika w trakcie pracy, a potem przy pierwszym ponownym połączeniu jeszcze jej nie ma."""
    monkeypatch.setattr(consumer, "QUEUE_CHECK_INTERVAL", 0)
    monkeypatch.setattr(consumer, "RECONNECT_DELAY", 0)
    channels = [
        FakeChannel([FakeQueue(), not_found()]),  # odbiór działa, potem sprawdzenie: brak kolejki
        FakeChannel([not_found()]),  # ponowne połączenie: kolejki dalej brak
        FakeChannel([FakeQueue()]),  # kolejka wróciła: odbiór rusza
    ]
    connects = []

    async def fake_connect_robust(**kwargs):
        connects.append(kwargs)
        if len(connects) > len(channels):
            raise asyncio.CancelledError  # koniec testu
        return FakeConnection(channels[len(connects) - 1])

    monkeypatch.setattr(consumer.aio_pika, "connect_robust", fake_connect_robust)
    settings = Settings(rabbitmq_host="rabbitmq", rabbitmq_user="inventory-service", instance_id="inventory-service-pod-1")

    async def scenario():
        task = asyncio.create_task(consumer.run_consumer(settings, lambda e: None))
        while channels[2].get_queue_calls < 2:  # trzecie połączenie konsumuje i sprawdza kolejkę
            await asyncio.sleep(0)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())
    assert len(connects) == 3
    assert connects[0]["client_properties"] == {"name": "inventory-service-pod-1"}
    assert all(c.get_queue_calls >= 1 for c in channels)
