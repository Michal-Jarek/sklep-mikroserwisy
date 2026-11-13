"""Discovery (D13): a hanging Consul must not queue the requests (review of PR #11)."""

import asyncio
from time import monotonic

import httpx

from app.consul import Discovery

HEALTHY = [{"Node": {"Address": "10.0.0.1"}, "Service": {"Address": "10.0.0.5", "Port": 8085}},
           {"Node": {"Address": "10.0.0.2"}, "Service": {"Address": "", "Port": 8085}}]


class FakeConsul:
    def __init__(self, delay=0.0, fail=False):
        self.delay, self.fail, self.calls = delay, fail, 0

    async def __call__(self, request):
        self.calls += 1
        await asyncio.sleep(self.delay)
        if self.fail:
            raise httpx.ReadTimeout("no answer", request=request)
        return httpx.Response(200, json=HEALTHY)


def discovery(consul):
    return Discovery(httpx.AsyncClient(base_url="http://consul", transport=httpx.MockTransport(consul)))


def test_hanging_consul_parallel_requests_share_one_query():
    consul = FakeConsul(delay=0.3, fail=True)

    async def scenario():
        found = discovery(consul)
        start = monotonic()
        results = await asyncio.gather(*(found.pick("review-service") for _ in range(5)))
        took = monotonic() - start
        # The failure is remembered: the next request does not ask Consul again.
        assert await found.pick("review-service") is None
        return results, took

    results, took = asyncio.run(scenario())
    assert results == [None] * 5
    assert took < 0.6  # one timeout for all, not 5 one after another (1.5 s)
    assert consul.calls == 1


def test_round_robin_and_cache():
    consul = FakeConsul()

    async def scenario():
        found = discovery(consul)
        return [await found.pick("review-service") for _ in range(3)]

    assert asyncio.run(scenario()) == ["http://10.0.0.5:8085", "http://10.0.0.2:8085", "http://10.0.0.5:8085"]
    assert consul.calls == 1


def test_consul_down_keeps_last_known_list():
    consul = FakeConsul()

    async def scenario():
        found = discovery(consul)
        first = await found.pick("review-service")
        found.cache["review-service"].expires_at = 0  # the list has expired
        consul.fail = True
        second = await found.pick("review-service")
        third = await found.pick("review-service")
        return first, second, third

    first, second, third = asyncio.run(scenario())
    assert first == "http://10.0.0.5:8085" and second == "http://10.0.0.2:8085" and third == first
    assert consul.calls == 2  # the failed refresh is remembered for 10 s
