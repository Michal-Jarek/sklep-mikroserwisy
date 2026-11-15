"""W2: many purchases at once do not freeze the service (database work runs in threads)."""
import asyncio
import time
from uuid import uuid4

import httpx

from app.main import create_app
from tests.conftest import BODY, Dependencies, settings


def test_parallel_purchases_keep_health_live_fast(tmp_path):
    deps = Dependencies(str(uuid4()), str(uuid4()))
    deps.rules["inventory:POST"] = {"delay": 0.5}
    app = create_app(settings(tmp_path))
    latencies: list[float] = []

    async def scenario():
        async with app.router.lifespan_context(app):
            app.state.peers.client = httpx.AsyncClient(transport=httpx.MockTransport(deps))
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://order") as http:
                done = asyncio.Event()

                async def probe():
                    while not done.is_set():
                        started = time.monotonic()
                        assert (await http.get("/health/live")).status_code == 200
                        latencies.append(time.monotonic() - started)
                        await asyncio.sleep(0.05)

                async def buy():
                    user = str(uuid4())
                    return await http.post("/orders", json=BODY, headers={
                        "X-User-Id": user, "X-User-Roles": "CUSTOMER", "Idempotency-Key": str(uuid4())})

                prober = asyncio.create_task(probe())
                started = time.monotonic()
                responses = await asyncio.gather(*(buy() for _ in range(30)))
                elapsed = time.monotonic() - started
                done.set()
                await prober
                return responses, elapsed

    responses, elapsed = asyncio.run(scenario())
    assert [r.status_code for r in responses] == [201] * 30
    assert {r.json()["status"] for r in responses} == {"PAID"}
    assert elapsed < 5, elapsed  # 30 purchases with a 0.5 s reservation each, in parallel
    assert len(latencies) >= 5 and max(latencies) < 0.5, max(latencies)
