import asyncio

import pytest

from app import consumer

ENVELOPE = {"eventId": "evt-1", "type": "order.cancelled"}


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


def test_transient_errors_are_retried_with_5s_then_30s_delay():
    calls = []

    def flaky(envelope):
        calls.append(1)
        if len(calls) < 3:
            raise RuntimeError("baza chwilowo niedostępna")

    assert run(flaky) == [5, 30]
    assert len(calls) == 3


def test_third_failure_is_raised_so_message_can_be_nacked_without_requeue():
    calls = []

    def always_fails(envelope):
        calls.append(1)
        raise RuntimeError("błąd")

    with pytest.raises(RuntimeError):
        run(always_fails)
    assert len(calls) == consumer.MAX_ATTEMPTS == 3
