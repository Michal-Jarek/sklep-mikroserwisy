import os
from dataclasses import dataclass, field
from uuid import uuid4
import httpx
import pytest_asyncio
from app.config import Settings
from app.main import create_app

@dataclass
class Upstream:
    product_status: int = 200
    inventory_status: int = 200
    stock: int = 20
    price: object = "19.99"
    calls: list[httpx.Request] = field(default_factory=list)

    def respond(self, request):
        self.calls.append(request)
        path = request.url.path
        if path == "/v1/agent/service/register" or path.startswith("/v1/agent/service/deregister/"):
            return httpx.Response(200, json={})
        if path.startswith("/v1/health/service/"):
            return httpx.Response(200, json=[{"Service": {"Address": "upstream.test", "Port": 8083}, "Node": {"Address": "unused"}}])
        if path.startswith("/products/"):
            return httpx.Response(self.product_status, json={"name": "Książka", "price": self.price})
        if path.startswith("/inventory/"):
            return httpx.Response(self.inventory_status, json={"available": self.stock})
        return httpx.Response(404)

@pytest_asyncio.fixture
async def context():
    redis_url = os.getenv("TEST_REDIS_URL", "redis://127.0.0.1:6379/15")
    if not redis_url.endswith("/15"):
        raise RuntimeError("Testy wymagają oddzielnej bazy Redis nr 15")
    upstream = Upstream()
    settings = Settings(redis_url=redis_url, consul_url="http://consul.test", consul_enabled=True)
    app = create_app(settings, transport=httpx.MockTransport(upstream.respond))
    user_id = uuid4()
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://cart.test",
            headers={"X-User-Id": str(user_id), "X-User-Roles": "CUSTOMER", "X-Request-Id": "cart-test"}) as client:
            try:
                yield app, client, upstream, user_id
            finally:
                # Usuwamy tylko klucz tego testu, nigdy FLUSHDB.
                await app.state.store.clear(user_id)
