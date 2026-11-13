import asyncio
import httpx
import pytest
from app.config import Settings
from app.discovery import Discovery

@pytest.mark.parametrize('explicit,expected', [(None,'warning'), ('debug','debug')])
async def test_kv_priority(explicit, expected):
    settings = Settings(**({'log_level': explicit} if explicit else {}))
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200,text='logLevel: warning\nDB_PASSWORD: ignored'))) as client:
        discovery = Discovery(client,'http://consul',True,'cart-service','id','pod',8085)
        await discovery.load_settings(settings)
    assert settings.log_level == expected
    assert not hasattr(settings, 'db_password')

async def test_missing_registration_is_restored(monkeypatch):
    calls = []
    def respond(request):
        calls.append(request)
        return httpx.Response(404 if request.method == 'GET' else 200)
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        discovery = Discovery(client,'http://consul',True,'cart-service','id','pod',8085)
        sleeps = 0
        async def tick(_):
            nonlocal sleeps
            sleeps += 1
            if sleeps == 2: raise asyncio.CancelledError()
        monkeypatch.setattr(asyncio, 'sleep', tick)
        with pytest.raises(asyncio.CancelledError): await discovery.maintain_registration()
    assert [r.method for r in calls] == ['GET','PUT']
    assert calls[1].url.path.endswith('/service/register')

async def test_dead_instance_is_skipped_until_refresh():
    def respond(request):
        return httpx.Response(200, json=[{'Service': {'Address':host, 'Port':8083}} for host in ['a','b']])
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        discovery = Discovery(client,'http://consul',True,'cart-service','id','pod',8085)
        assert await discovery.resolve('product') == 'http://a:8083'
        discovery.reject('product','http://a:8083')
        for _ in range(3): assert await discovery.resolve('product') == 'http://b:8083'
        discovery.cache['product'].expires_at = 0
        assert await discovery.resolve('product') == 'http://a:8083'

def test_instance_id_is_stable_per_hostname():
    from socket import gethostname
    assert Settings().instance_id == Settings().instance_id == 'cart-service-'+gethostname()

async def test_registration_waits_for_http_without_blocking_start():
    from app.main import create_app
    ready = False
    registered = asyncio.Event()
    def respond(request):
        if request.url.path == '/health/live': return httpx.Response(200 if ready else 503)
        if request.url.path.endswith('/service/register'):
            assert ready
            registered.set()
            return httpx.Response(200)
        return httpx.Response(404)
    app = create_app(Settings(consul_enabled=True, service_address='pod'), transport=httpx.MockTransport(respond))
    async with app.router.lifespan_context(app):
        await asyncio.sleep(.01)
        assert not registered.is_set()
        ready = True
        await asyncio.wait_for(registered.wait(), 1)

async def test_transport_failure_retries_another_instance():
    from uuid import uuid4
    from app.catalog import CatalogClient
    from app.security import Caller
    calls = []
    def respond(request):
        if request.url.path.startswith('/v1/health/'):
            return httpx.Response(200,json=[{'Service':{'Address':host,'Port':8083}} for host in ['a','b']])
        calls.append(request.url.host)
        if request.url.host == 'a': raise httpx.ConnectError('offline')
        return httpx.Response(200,json={'name':'Book','price':'10.00','currency':'PLN'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        discovery = Discovery(client,'http://consul',True,'cart-service','id','pod',8085)
        catalog = CatalogClient(client, discovery, Settings())
        result = await catalog.product(uuid4(), Caller(uuid4(), frozenset({'CUSTOMER'}), 'audit'))
        assert result.price == '10.00'
        assert calls == ['a','b']
