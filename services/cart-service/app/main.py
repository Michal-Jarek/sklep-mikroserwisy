"""Zależności są tworzone przy starcie i zamykane przy wyłączeniu aplikacji."""
import logging
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
                await discovery.register()
                yield
            finally:
                await discovery.deregister()
                await redis.aclose()

    app = FastAPI(title="Cart Service", version="1.0.0", lifespan=lifespan)
    configure_http(app, "cart-service", settings.instance_id)
    app.include_router(router)

    @app.exception_handler(RedisError)
    async def redis_error(request: Request, exc: RedisError):
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

    return app

logging.basicConfig(level=logging.INFO, format="%(message)s")
app = create_app()
