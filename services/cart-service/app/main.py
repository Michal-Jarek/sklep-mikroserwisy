"""Zależności są tworzone przy starcie i zamykane przy wyłączeniu aplikacji."""
import asyncio
import logging
from contextlib import suppress
from contextlib import asynccontextmanager
import httpx
from fastapi import FastAPI, HTTPException, Request
from redis.asyncio import Redis
from redis.exceptions import RedisError
from .catalog import CatalogClient
from .config import Settings
from .discovery import Discovery
from .http_support import configure_http, error_response
from .routes import router
from .service import CartService
from .store import CartStore


def create_app(settings: Settings | None = None, *, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        redis = Redis.from_url(settings.redis_url, decode_responses=True,
            socket_connect_timeout=2, socket_timeout=2)
        async with httpx.AsyncClient(timeout=2, trust_env=False, transport=transport) as client:
            discovery = Discovery(client, settings.consul_url, settings.consul_enabled,
                "cart-service", settings.instance_id, settings.service_address, settings.port)
            app.state.store = CartStore(redis)
            app.state.catalog = CatalogClient(client, discovery, settings)
            app.state.cart_service = CartService(app.state.store, app.state.catalog)
            try:
                await discovery.load_settings(settings)
                async def register_after_http():
                    # Lifespan starts before uvicorn listens. Check our own liveness
                    # in the background, then register, even if the database is down.
                    while True:
                        try:
                            response = await client.get(f"http://127.0.0.1:{settings.port}/health/live")
                            if response.status_code == 200:
                                break
                        except httpx.HTTPError:
                            pass
                        await asyncio.sleep(0.1)
                    await discovery.try_register()
                    await discovery.maintain_registration()
                registration = asyncio.create_task(register_after_http())
                try:
                    yield
                finally:
                    registration.cancel()
                    with suppress(asyncio.CancelledError):
                        await registration
            finally:
                await discovery.close()
                await redis.aclose()

    app = FastAPI(title="Cart Service", version="1.0.0", lifespan=lifespan, redirect_slashes=False)
    configure_http(app, "cart-service", settings.instance_id, settings.log_level)
    app.include_router(router)

    @app.exception_handler(RedisError)
    async def redis_error(request: Request, exc: RedisError):
        request.state.error_type = type(exc).__name__
        return error_response(request, 503, "Magazyn koszyka jest niedostępny")

    @app.get("/health/live", tags=["health"])
    async def live():
        return {"status": "UP"}

    @app.get("/health/ready", tags=["health"])
    async def ready(request: Request):
        try:
            await request.app.state.store.ready()
        except RedisError:
            raise HTTPException(503, "Redis jest niedostępny") from None
        return {"status": "UP"}

    for route in list(app.routes):
        if getattr(route, "methods", None) and "GET" in route.methods and "HEAD" not in route.methods:
            app.add_api_route(route.path, route.endpoint, methods=["HEAD"],
                              response_model=route.response_model, include_in_schema=False)
    return app

class LazyApplication:
    """Retain app.main:app compatibility without allocating resources on import."""
    def __init__(self):
        self.app = None

    async def __call__(self, scope, receive, send):
        if self.app is None:
            logging.basicConfig(level=logging.WARNING, format="%(message)s")
            self.app = create_app()
        await self.app(scope, receive, send)

app = LazyApplication()
