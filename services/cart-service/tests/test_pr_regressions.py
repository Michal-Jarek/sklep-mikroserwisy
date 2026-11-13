import asyncio
from time import monotonic
from uuid import uuid4
import httpx
import pytest
from app.discovery import Discovery
from app.circuit_breaker import CircuitBreaker, ContractError

@pytest.mark.parametrize('status', [400, 401, 403, 409, 422])
async def test_client_errors_are_not_retried_or_opened(context, status):
    app, client, upstream, _ = context
    upstream.product_status = status
    for _ in range(12):
        assert (await client.post('/cart/items', json={'productId': str(uuid4()), 'quantity': 1})).status_code == 503
    assert len([r for r in upstream.calls if r.url.path.startswith('/products/')]) == 12
    assert app.state.catalog.breakers['product-service'].opened_at is None

@pytest.mark.parametrize('status', [408, 429, 500])
async def test_non_retriable_failures_still_open_breaker(context, status):
    app, client, upstream, _ = context
    upstream.product_status = status
    for _ in range(10):
        assert (await client.post('/cart/items', json={'productId': str(uuid4()), 'quantity': 1})).status_code == 503
    assert len([r for r in upstream.calls if r.url.path.startswith('/products/')]) == 10
    assert app.state.catalog.breakers['product-service'].opened_at is not None

async def test_invalid_contract_is_not_retried(context):
    app, client, upstream, _ = context
    upstream.price = 19.99
    for _ in range(12):
        assert (await client.post('/cart/items', json={'productId': str(uuid4()), 'quantity': 1})).status_code == 503
    assert len([r for r in upstream.calls if r.url.path.startswith('/products/')]) == 12
    assert app.state.catalog.breakers['product-service'].opened_at is None

async def test_missing_inventory_means_no_stock(context):
    _, client, upstream, _ = context
    upstream.inventory_status = 404
    assert (await client.post('/cart/items', json={'productId': str(uuid4()), 'quantity': 1})).status_code == 409

async def test_missing_patch_is_404_before_dependencies(context):
    _, client, upstream, _ = context
    upstream.product_status = 503
    assert (await client.patch(f'/cart/items/{uuid4()}', json={'quantity': 1})).status_code == 404
    assert not any(r.url.path.startswith(('/products/', '/inventory/')) for r in upstream.calls)

async def test_dependencies_start_in_parallel(context, monkeypatch):
    app, client, _, _ = context
    started = set()
    both = asyncio.Event()
    product = app.state.catalog.product
    inventory = app.state.catalog.available
    async def wrapped(name, operation, *args):
        started.add(name)
        if len(started) == 2: both.set()
        await asyncio.wait_for(both.wait(), 1)
        return await operation(*args)
    monkeypatch.setattr(app.state.catalog, 'product', lambda *args: wrapped('product', product, *args))
    monkeypatch.setattr(app.state.catalog, 'available', lambda *args: wrapped('inventory', inventory, *args))
    assert (await client.post('/cart/items', json={'productId': str(uuid4()), 'quantity': 1})).status_code == 200

async def test_corrupt_other_entry_prevents_partial_write(context):
    app, client, _, user = context
    store = app.state.store
    product = str(uuid4())
    await store.redis.hset(store.key(user), str(uuid4()), 'corrupt json')
    before = await store.redis.hgetall(store.key(user))
    assert (await client.post('/cart/items', json={'productId': product, 'quantity': 1})).status_code == 503
    assert await store.redis.hgetall(store.key(user)) == before

async def test_twenty_concurrent_additions_are_preserved(context):
    _, client, upstream, _ = context
    upstream.stock = 100
    product = str(uuid4())
    results = await asyncio.gather(*(client.post('/cart/items', json={'productId': product, 'quantity': 1}) for _ in range(20)))
    assert all(r.status_code == 200 for r in results)
    assert (await client.get('/cart')).json()['items'][0]['quantity'] == 20

async def test_head_slash_and_internal_identity(context):
    _, client, _, user = context
    assert (await client.head('/cart')).status_code == 200
    assert (await client.get('/cart/')).status_code == 404
    async with httpx.AsyncClient(transport=client._transport, base_url='http://cart.test') as anon:
        assert (await anon.delete(f'/cart/{user}')).status_code == 403
        assert (await anon.get('/cart', headers=[('X-User-Roles','CUSTOMER'), ('X-User-Roles','SERVICE')])).status_code == 400

async def test_discovery_reuses_stale_and_does_not_serialize_destinations():
    offline = False
    started = set()
    gate = asyncio.Event()
    async def respond(request):
        if offline: raise httpx.ConnectError('offline')
        name = request.url.path.rsplit('/', 1)[-1]
        started.add(name)
        if len(started) == 2: gate.set()
        await asyncio.wait_for(gate.wait(), 1)
        return httpx.Response(200, json=[{'Service': {'Address': name, 'Port':8083}}])
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        discovery = Discovery(client, 'http://consul', True, 'cart', 'id', 'pod', 8085)
        urls = await asyncio.gather(discovery.resolve('product'), discovery.resolve('inventory'))
        offline = True
        discovery.cache['product'].expires_at = 0
        assert await discovery.resolve('product') == urls[0]

async def test_consul_down_at_start_is_tolerated():
    def respond(request): raise httpx.ConnectError('offline')
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        discovery = Discovery(client, 'http://consul', True, 'cart', 'id', 'pod', 8085)
        await discovery.try_register()
        await discovery.close()

async def test_cancelled_peer_does_not_count_as_upstream_failure():
    breaker = CircuitBreaker()
    started = asyncio.Event()
    async def pending():
        started.set()
        await asyncio.Event().wait()
    task = asyncio.create_task(breaker.call(pending))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
    assert not breaker.history
    breaker.opened_at = -100
    started.clear()
    task = asyncio.create_task(breaker.call(pending))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError): await task
    assert not breaker.probe
