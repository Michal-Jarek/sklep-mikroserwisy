"""Builds the application: settings, logs, database, cache, Consul and the endpoints.

Migrations are a separate command (alembic upgrade head), not part of the start (D6).
"""

import asyncio
from contextlib import asynccontextmanager, suppress

import httpx
from fastapi import FastAPI, Request
from sqlalchemy.exc import InterfaceError, OperationalError
from sqlalchemy.orm import sessionmaker
from starlette.concurrency import run_in_threadpool

from .cache import TtlCache
from .catalog import Catalog
from .clients import INVENTORY, REVIEW, Enrichment
from .config import SERVICE_NAME, Settings
from .consul import Discovery, Registration, load_kv
from .db import database_ok, make_engine
from .logs import logger, set_level, setup_logging
from .routes import router
from .web import error_response, install


def create_app(settings: Settings | None = None, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    """transport: only for tests (calls to Review and Inventory without a network)."""
    settings = settings or Settings.from_env()
    setup_logging(settings.log_level)
    engine = make_engine(settings)

    async def is_ready() -> bool:
        try:
            return await asyncio.wait_for(run_in_threadpool(database_ok, engine), 2)
        except TimeoutError:
            return False

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # trust_env=False: calls inside the shop never go through an internet proxy of the laptop.
        consul_url = f"http://{settings.consul_host}:{settings.consul_port}"
        async with (
            httpx.AsyncClient(base_url=consul_url, timeout=2.0, trust_env=False) as consul,
            httpx.AsyncClient(timeout=2.0, trust_env=False, transport=transport) as http,
        ):
            if settings.consul_enabled:
                settings.apply_kv(await load_kv(consul))
            else:
                settings.apply_kv({})
            set_level(settings.log_level)
            app.state.catalog.cache.ttl = settings.cache_ttl_seconds
            fixed = {REVIEW: settings.review_service_url, INVENTORY: settings.inventory_service_url}
            discovery = Discovery(consul if settings.consul_enabled else None, fixed)
            app.state.enrichment = Enrichment(http, discovery)

            registration = None
            if settings.consul_enabled:
                # In the background: the service answers requests also while Consul is down (D13).
                registration = Registration(consul, settings, is_ready)
                app.state.registration_task = asyncio.create_task(registration.keep_registered())
            logger.info("Service started", extra={"fields": {
                "instanceId": settings.instance_id,
                "port": settings.port,
                "cacheTtlSeconds": settings.cache_ttl_seconds,
            }})
            yield
            # Shutdown (SIGTERM, Ctrl+C): uvicorn has stopped accepting requests and finished the current ones.
            if registration is not None:
                app.state.registration_task.cancel()
                with suppress(asyncio.CancelledError):
                    await app.state.registration_task
                await registration.deregister()
        engine.dispose()

    # redirect_slashes=False: /products/ is 404, not a redirect (D12).
    app = FastAPI(title=SERVICE_NAME, version="1.0.0", lifespan=lifespan, redirect_slashes=False)
    app.state.settings = settings
    app.state.engine = engine
    app.state.catalog = Catalog(sessionmaker(engine, expire_on_commit=False), TtlCache(settings.cache_ttl_seconds))
    install(app, settings.instance_id)
    app.include_router(router)

    @app.exception_handler(OperationalError)
    @app.exception_handler(InterfaceError)
    async def database_unavailable(request: Request, exc: Exception):
        # No connection to the own database: 503, not 500 (D7). The message of the driver is not
        # logged (it can contain values), only its type.
        logger.warning("Database not available", extra={"fields": {"reason": type(exc).__name__}})
        return error_response(503, "Database not available")

    @app.get("/health/live", tags=["health"])
    async def health_live() -> dict:
        """The process works; no dependencies are checked (D15)."""
        return {"status": "UP"}

    @app.get("/health/ready", tags=["health"])
    async def health_ready():
        """Ready when the own database answers; not other services (D15)."""
        if not await is_ready():
            return error_response(503, "Database not available")
        return {"status": "UP"}

    return app
