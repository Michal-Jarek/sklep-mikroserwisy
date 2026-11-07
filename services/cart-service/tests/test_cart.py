import asyncio
from uuid import uuid4
from unittest.mock import AsyncMock
import httpx
import pytest
from redis.exceptions import ConnectionError
from app.schemas import cents, money
from app.store import TTL_SECONDS


def test_integer_money():
    assert cents("19.99") == 1999
    assert money(1999 * 3) == "59.97"
    assert money(10 + 20) == "0.30"


async def test_empty_cart(context):
    _, client, _, user = context
    response = await client.get("/cart")
    assert response.status_code == 200
    assert response.json() == {"userId": str(user), "currency": "PLN", "items": [], "total": "0.00"}


async def test_add_and_propagate_headers(context):
    _, client, upstream, user = context
    product = str(uuid4())
    response = await client.post("/cart/items", json={"productId": product, "quantity": 2})
    assert response.status_code == 200, response.text
    assert response.json()["total"] == "39.98"
    assert response.json()["inventoryChecked"] is True
    assert response.json()["items"][0] == {"productId": product, "name": "Książka", "unitPrice": "19.99", "quantity": 2, "subtotal": "39.98"}
    forwarded = [r for r in upstream.calls if r.url.path.startswith("/products/")][0]
    assert forwarded.headers["X-User-Id"] == str(user)
    assert forwarded.headers["X-Request-Id"] == "cart-test"
    assert set(forwarded.headers["X-User-Roles"].split(",")) == {"CUSTOMER", "SERVICE"}
    assert response.headers["X-Request-Id"] == "cart-test"


async def test_post_adds_patch_replaces_and_refreshes_price(context):
    _, client, upstream, _ = context
    product = str(uuid4())
    for _ in range(2):
        response = await client.post("/cart/items", json={"productId": product, "quantity": 2})
        assert response.status_code == 200
    assert response.json()["items"][0]["quantity"] == 4
    upstream.price = "20.00"
    response = await client.patch(f"/cart/items/{product}", json={"quantity": 1})
    assert response.json()["total"] == "20.00"


async def test_other_user_has_separate_cart(context):
    _, client, _, _ = context
    await client.post("/cart/items", json={"productId": str(uuid4()), "quantity": 1})
    response = await client.get("/cart", headers={"X-User-Id": str(uuid4())})
    assert response.json()["items"] == []


@pytest.mark.parametrize("quantity", [0, -1, 1000, 1.5, True, "2"])
async def test_invalid_quantities(context, quantity):
    _, client, _, _ = context
    response = await client.post("/cart/items", json={"productId": str(uuid4()), "quantity": quantity})
    assert response.status_code == 400


async def test_cannot_supply_price_or_owner(context):
    _, client, _, _ = context
    for extra in ({"unitPrice": "0.01"}, {"userId": str(uuid4())}):
        assert (await client.post("/cart/items", json={"productId": str(uuid4()), "quantity": 1, **extra})).status_code == 400


async def test_insufficient_stock_rejects_total_quantity(context):
    _, client, upstream, _ = context
    product = str(uuid4())
    await client.post("/cart/items", json={"productId": product, "quantity": 2})
    upstream.stock = 2
    assert (await client.post("/cart/items", json={"productId": product, "quantity": 1})).status_code == 409
    assert (await client.get("/cart")).json()["items"][0]["quantity"] == 2


async def test_inventory_failure_is_allowed(context):
    _, client, upstream, _ = context
    upstream.inventory_status = 503
    response = await client.post("/cart/items", json={"productId": str(uuid4()), "quantity": 1})
    assert response.status_code == 200
    assert response.json()["inventoryChecked"] is False
    assert len([r for r in upstream.calls if r.url.path.startswith("/inventory/")]) == 3


@pytest.mark.parametrize("status,expected", [(404, 404), (503, 503)])
async def test_product_failure_does_not_write(context, status, expected):
    _, client, upstream, _ = context
    upstream.product_status = status
    response = await client.post("/cart/items", json={"productId": str(uuid4()), "quantity": 1})
    assert response.status_code == expected
    assert (await client.get("/cart")).json()["items"] == []
    calls = [r for r in upstream.calls if r.url.path.startswith("/products/")]
    assert len(calls) == (1 if status == 404 else 3)


@pytest.mark.parametrize("price", ["-1.00", "NaN", "1.123", 19.99])
async def test_invalid_upstream_price_is_503(context, price):
    _, client, upstream, _ = context
    upstream.price = price
    assert (await client.post("/cart/items", json={"productId": str(uuid4()), "quantity": 1})).status_code == 503
    assert (await client.get("/cart")).json()["items"] == []


async def test_ttl_only_refreshes_on_changes(context):
    app, client, _, user = context
    product = str(uuid4())
    await client.post("/cart/items", json={"productId": product, "quantity": 1})
    store = app.state.store
    assert await store.redis.ttl(store.key(user)) > TTL_SECONDS - 20
    await store.redis.expire(store.key(user), 100)
    await client.get("/cart")
    assert 0 < await store.redis.ttl(store.key(user)) <= 100
    await client.patch(f"/cart/items/{product}", json={"quantity": 2})
    assert await store.redis.ttl(store.key(user)) > TTL_SECONDS - 20


async def test_parallel_posts_do_not_lose_updates(context):
    _, client, _, _ = context
    product = str(uuid4())
    responses = await asyncio.gather(*(client.post("/cart/items", json={"productId": product, "quantity": 1}) for _ in range(5)))
    assert all(r.status_code == 200 for r in responses), [r.text for r in responses]
    assert (await client.get("/cart")).json()["items"][0]["quantity"] == 5


async def test_clear_requires_service(context):
    _, client, _, user = context
    await client.post("/cart/items", json={"productId": str(uuid4()), "quantity": 1})
    assert (await client.delete(f"/cart/{user}")).status_code == 403
    assert (await client.delete(f"/cart/{user}", headers={"X-User-Roles": "SERVICE"})).status_code == 204
    assert (await client.get("/cart")).json()["items"] == []


async def test_remove_and_missing_patch(context):
    _, client, _, _ = context
    product = str(uuid4())
    assert (await client.patch(f"/cart/items/{product}", json={"quantity": 1})).status_code == 404
    await client.post("/cart/items", json={"productId": product, "quantity": 1})
    assert (await client.delete(f"/cart/items/{product}")).status_code == 204
    assert (await client.get("/cart")).json()["total"] == "0.00"
    assert (await client.delete(f"/cart/items/{product}")).status_code == 204


async def test_auth_errors_and_uniform_error(context):
    app, _, _, _ = context
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://cart.test") as anonymous:
        response = await anonymous.get("/cart")
        assert response.status_code == 401
        assert response.json()["error"] == "UNAUTHORIZED"
        assert response.json()["requestId"] == response.headers["X-Request-Id"]
        assert (await anonymous.get("/cart", headers={"X-User-Roles": "CUSTOMER", "X-User-Id": "invalid"})).status_code == 401


async def test_redis_outage_does_not_fake_success(context, monkeypatch):
    app, client, _, _ = context
    with monkeypatch.context() as patch:
        patch.setattr(app.state.store.redis, "execute_command", AsyncMock(side_effect=ConnectionError("test")))
        assert (await client.get("/cart")).status_code == 503
        assert (await client.get("/health/ready")).status_code == 503
        assert (await client.get("/health/live")).status_code == 200


async def test_health_and_openapi(context):
    _, client, _, _ = context
    for path in ("/health/live", "/health/ready", "/docs", "/openapi.json"):
        assert (await client.get(path)).status_code == 200
    assert "/cart/items" in (await client.get("/openapi.json")).json()["paths"]


async def test_product_breaker_stops_network_calls(context):
    _, client, upstream, _ = context
    upstream.product_status = 503
    for _ in range(10):
        assert (await client.post("/cart/items", json={"productId": str(uuid4()), "quantity": 1})).status_code == 503
    calls = len(upstream.calls)
    assert (await client.post("/cart/items", json={"productId": str(uuid4()), "quantity": 1})).status_code == 503
    assert len(upstream.calls) == calls
