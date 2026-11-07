import asyncio
import httpx
import pytest
from app.circuit_breaker import CircuitBreaker, CircuitOpen, ResourceMissing
from app.discovery import Discovery


async def test_breaker_last_ten_and_recovery():
    now = [0.0]
    breaker = CircuitBreaker(clock=lambda: now[0])
    async def ok(): return "ok"
    async def fail(): raise OSError("offline")
    for _ in range(5):
        assert await breaker.call(ok) == "ok"
    for _ in range(5):
        with pytest.raises(OSError): await breaker.call(fail)
    with pytest.raises(CircuitOpen): await breaker.call(ok)
    now[0] = 31
    assert await breaker.call(ok) == "ok"
    assert breaker.opened_at is None
    assert not breaker.history


async def test_breaker_only_one_half_open_probe():
    now = [0.0]
    breaker = CircuitBreaker(clock=lambda: now[0])
    async def fail(): raise OSError()
    for _ in range(10):
        with pytest.raises((OSError, CircuitOpen)): await breaker.call(fail)
    now[0] = 31
    started, release = asyncio.Event(), asyncio.Event()
    async def slow():
        started.set()
        await release.wait()
        return "ok"
    probe = asyncio.create_task(breaker.call(slow))
    await started.wait()
    with pytest.raises(CircuitOpen): await breaker.call(slow)
    release.set()
    assert await probe == "ok"


async def test_404_does_not_open_breaker():
    breaker = CircuitBreaker()
    async def missing(): raise ResourceMissing()
    for _ in range(12):
        with pytest.raises(ResourceMissing): await breaker.call(missing)
    assert breaker.opened_at is None


async def test_discovery_registration_cache_round_robin_and_deregister():
    requests = []
    def respond(request):
        requests.append(request)
        if request.url.path.startswith("/v1/health/"):
            return httpx.Response(200, json=[
                {"Service": {"Address": "node-a", "Port": 8083}},
                {"Service": {"Address": "node-b", "Port": 8083}},
            ])
        return httpx.Response(200)
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        discovery = Discovery(client, "http://consul", True, "cart-service", "instance", "pod", 8085)
        await discovery.register()
        assert await discovery.resolve("product-service") == "http://node-a:8083"
        assert await discovery.resolve("product-service") == "http://node-b:8083"
        assert await discovery.resolve("product-service") == "http://node-a:8083"
        discovery.cache["product-service"].expires_at = 0
        assert await discovery.resolve("product-service") == "http://node-a:8083"
        await discovery.deregister()
    assert requests[0].method == "PUT"
    assert b'/health/ready' in requests[0].content
    assert len([r for r in requests if "/health/service/" in r.url.path]) == 2
    assert requests[-1].url.path.endswith("deregister/instance")
