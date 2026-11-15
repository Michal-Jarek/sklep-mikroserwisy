import asyncio
import logging
from contextlib import asynccontextmanager, suppress

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Request
from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker

from .config import SERVICE_NAME, Settings
from .consul_registration import ConsulRegistrar
from .consumer import run_consumer
from .database import make_engine
from .http_support import configure_http, error_response
from .logging_config import configure_logging, set_service_log_level
from .models import Base, Shipment
from .relay import run_relay
from .routes import router

log = logging.getLogger("shipping.main")
READY_TIMEOUT = 1.5  # CR-42: /health/ready answers within the 2 s of the Consul and Kubernetes checks


def database_ping(engine) -> None:
    """The database check of /health/ready (blocking; raises SQLAlchemyError when the database is unavailable)."""
    with engine.connect() as connection:
        connection.execute(select(Shipment.order_id).limit(0))


async def kv_log_level(settings: Settings) -> str | None:
    try:
        async with httpx.AsyncClient(timeout=2, trust_env=False) as client:
            resp = await client.get(f"{settings.consul_url.rstrip('/')}/v1/kv/config/{SERVICE_NAME}/data?raw")
            resp.raise_for_status()
            return (yaml.safe_load(resp.text) or {}).get("logLevel")
    except (httpx.HTTPError, yaml.YAMLError, AttributeError) as exc:
        log.warning("logLevel from Consul KV unavailable, using info", extra={"fields": {"reason": type(exc).__name__}})
        return None


def create_app(settings=None):
    settings = settings or Settings()
    configure_logging(SERVICE_NAME, settings.log_level)
    engine = make_engine(settings)
    factory = sessionmaker(engine, expire_on_commit=False)

    @asynccontextmanager
    async def lifespan(app):
        with engine.begin() as connection:
            if engine.dialect.name == "postgresql":
                connection.execute(text("SELECT pg_advisory_xact_lock(8089)"))
            Base.metadata.create_all(connection)
            if engine.dialect.name == "postgresql":
                # CR-2: tables created by the version from PR #17. create_all does not alter existing tables;
                # both statements are idempotent and keep the data.
                connection.execute(text("ALTER TABLE shipping_outbox ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP"))
                connection.execute(text("ALTER TABLE shipments ALTER COLUMN user_id DROP NOT NULL"))
        # LOG_LEVEL takes precedence over logLevel from Consul KV.
        if settings.log_level is None and settings.consul_enabled:
            set_service_log_level(await kv_log_level(settings))
        app.state.courier_cost = settings.courier_cost
        tasks = []
        if settings.consul_enabled:
            tasks.append(asyncio.create_task(ConsulRegistrar(settings, is_ready=ready_now).run()))
        app.state.consumer = None
        if settings.broker_enabled:
            app.state.consumer = asyncio.create_task(run_consumer(settings, factory))
            app.state.consumer.add_done_callback(consumer_stopped)
            tasks += [app.state.consumer, asyncio.create_task(run_relay(settings, factory))]
        log.info("Service started", extra={"fields": {"instanceId": settings.effective_instance_id}})
        try:
            yield
        finally:
            for task in tasks:
                task.cancel()
            for task in tasks:
                with suppress(asyncio.CancelledError):
                    await task
            engine.dispose()

    def ready_now() -> bool:
        """The checks of /health/ready as a value (initial state of the Consul check)."""
        if app.state.consumer is not None and app.state.consumer.done():
            return False
        try:
            database_ping(engine)
            return True
        except SQLAlchemyError:
            return False

    def consumer_stopped(task: asyncio.Task) -> None:
        # The consumer retries every error by itself; it ends only on a programming error (then /health/ready = 503).
        if not task.cancelled() and task.exception() is not None:
            log.error("Event consumer stopped", exc_info=task.exception())

    app = FastAPI(title="Shipping Service", version="1.0", lifespan=lifespan, redirect_slashes=False)
    app.state.session_factory = factory
    configure_http(app, settings.effective_instance_id)
    app.include_router(router)

    @app.exception_handler(SQLAlchemyError)
    async def database_error(request: Request, exc):
        log.warning("Database unavailable", extra={"fields": {"reason": type(exc).__name__}})
        return error_response(request, 503, "Baza przesyłek niedostępna")

    @app.get("/health/live")
    async def live():
        return {"status": "UP"}

    @app.get("/health/ready")
    async def ready():
        if app.state.consumer is not None and app.state.consumer.done():
            raise HTTPException(503, "Zatrzymany odbiorca zdarzeń")
        # In a thread with a limit: a hanging database (e.g. paused server) gives 503 instead of no answer.
        try:
            await asyncio.wait_for(asyncio.to_thread(database_ping, engine), READY_TIMEOUT)
        except TimeoutError:
            log.warning("Database did not answer the readiness check in time")
            raise HTTPException(503, "Baza przesyłek niedostępna") from None
        return {"status": "UP"}

    return app


try:
    app = create_app()
except RuntimeError as exc:  # e.g. invalid DB_URL: one JSON line, no traceback quoting the address
    log.error("Startup failed", extra={"fields": {"reason": str(exc)}})
    raise SystemExit(1) from None
