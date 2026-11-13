"""Circuit breaker (D2) and the TTL cache, with a fake clock (no waiting)."""

import asyncio

import pytest

from app.breaker import CircuitBreaker, CircuitOpen
from app.cache import MISSING, TtlCache


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


async def ok():
    return "ok"


async def fail():
    raise RuntimeError("down")


async def run(breaker, operation):
    try:
        return await breaker.call(operation)
    except RuntimeError:
        return "failed"


def test_breaker_opens_after_10_calls_with_half_failures():
    async def scenario():
        clock = Clock()
        breaker = CircuitBreaker(clock=clock)
        for _ in range(5):
            await run(breaker, ok)
        for _ in range(4):
            await run(breaker, fail)
        assert breaker.state == "CLOSED"  # 9 calls: not enough for a decision
        await run(breaker, fail)  # 10 calls, 5 failures = 50 %
        assert breaker.state == "OPEN"
        with pytest.raises(CircuitOpen):
            await breaker.call(ok)
        clock.now += 30
        assert breaker.state == "HALF_OPEN"
        assert await breaker.call(ok) == "ok"  # the trial call closes the breaker
        assert breaker.state == "CLOSED"

    asyncio.run(scenario())


def test_breaker_failed_trial_opens_again():
    async def scenario():
        clock = Clock()
        breaker = CircuitBreaker(clock=clock)
        for _ in range(10):
            await run(breaker, fail)
        clock.now += 30
        await run(breaker, fail)
        assert breaker.state == "OPEN"
        clock.now += 29
        with pytest.raises(CircuitOpen):
            await breaker.call(ok)

    asyncio.run(scenario())


def test_breaker_only_one_trial_call():
    async def scenario():
        clock = Clock()
        breaker = CircuitBreaker(clock=clock)
        for _ in range(10):
            await run(breaker, fail)
        clock.now += 30
        started = asyncio.Event()
        release = asyncio.Event()

        async def slow():
            started.set()
            await release.wait()
            return "ok"

        trial = asyncio.create_task(breaker.call(slow))
        await started.wait()
        with pytest.raises(CircuitOpen):
            await breaker.call(ok)  # second call during the trial gets the fallback
        release.set()
        assert await trial == "ok"

    asyncio.run(scenario())


def test_cache_ttl_and_clear():
    clock = Clock()
    cache = TtlCache(60, clock=clock)
    loads = []
    assert cache.get_or_load("k", lambda: loads.append(1) or "v") == "v"
    assert cache.get_or_load("k", lambda: loads.append(1) or "v2") == "v"
    assert len(loads) == 1
    clock.now += 60
    assert cache.get("k") is MISSING
    cache.put("k", "v3")
    cache.clear()
    assert cache.get("k") is MISSING


def test_cache_keeps_at_most_max_entries():
    cache = TtlCache(60, max_entries=2)
    cache.put("a", 1)
    cache.put("b", 2)
    cache.put("c", 3)
    assert cache.get("a") is MISSING and cache.get("c") == 3
