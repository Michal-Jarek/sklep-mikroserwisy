import asyncio
import logging
from contextlib import asynccontextmanager, suppress

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from .config import SERVICE_NAME, ConfigError, Settings
from .consumer import run_consumer
from .database import make_engine, make_factory, wait_for_schema
from .discovery import Discovery
from .http_support import configure_http
from .logging_config import configure_logging, set_service_log_level
from .models import Order
from .orders import router
from .peers import Peers
from .relay import run_relay

log = logging.getLogger("app.main")
READY_TIMEOUT = 2.0


async def kv_log_level(client: httpx.AsyncClient, consul_url: str) -> str | None:
    """logLevel from Consul KV config/order-service/data; None when Consul or the key is unavailable."""
    try:
        # "raw=true" (not "raw="): consul-guard in k8s accepts only none, "raw" and "raw=true".
        response = await client.get(f"{consul_url.rstrip('/')}/v1/kv/config/{SERVICE_NAME}/data",
                                    params={"raw": "true"})
        response.raise_for_status()
        return (yaml.safe_load(response.text) or {}).get("logLevel")
    except (httpx.HTTPError, yaml.YAMLError, AttributeError) as exc:
        log.warning("Configuration from Consul KV unavailable, using defaults",
                    extra={"fields": {"reason": type(exc).__name__}})
        return None


def database_ping(engine) -> None:
    with engine.connect() as connection:
        connection.execute(select(Order.id).limit(0))


async def database_ready(engine) -> bool:
    """The database check of /health/ready; CR-35: also the status of a registration in Consul."""
    try:
        await asyncio.wait_for(asyncio.to_thread(database_ping, engine), READY_TIMEOUT)
    except (TimeoutError, SQLAlchemyError):
        return False
    return True


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    configure_logging(SERVICE_NAME, settings.log_level)
    engine = make_engine(settings)
    factory = make_factory(engine)
    instance_id = settings.effective_instance_id

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await wait_for_schema(engine)
        async with httpx.AsyncClient(timeout=2, trust_env=False) as client:
            discovery = Discovery(client, settings.consul_url, SERVICE_NAME, instance_id,
                                  settings.service_address, settings.port, ready=lambda: database_ready(engine))
            if settings.log_level is None and settings.consul_enabled:
                set_service_log_level(await kv_log_level(client, settings.consul_url))
            app.state.peers = Peers(client, discovery, settings)
            tasks = []
            if settings.consul_enabled:
                tasks.append(asyncio.create_task(discovery.run_registration()))
            # Background tasks end only on a programming error; /health/ready then answers 503.
            app.state.workers = []
            if settings.broker_enabled:
                app.state.workers = [asyncio.create_task(run_consumer(settings, factory, instance_id)),
                                     asyncio.create_task(run_relay(settings, factory, instance_id))]
                tasks.extend(app.state.workers)
            try:
                yield
            finally:
                for task in tasks:
                    task.cancel()
                for task in tasks:
                    with suppress(asyncio.CancelledError):
                        await task
                engine.dispose()

    app = FastAPI(title="Order Service", version="1.0", lifespan=lifespan, redirect_slashes=False)
    app.state.session_factory = factory
    app.state.workers = []
    configure_http(app, instance_id)
    app.include_router(router)

    @app.get("/health/live")
    @app.head("/health/live", include_in_schema=False)
    async def live():
        return {"status": "UP"}

    @app.get("/health/ready")
    @app.head("/health/ready", include_in_schema=False)
    async def ready(request: Request):
        if any(task.done() for task in request.app.state.workers):
            raise HTTPException(503, "Zatrzymany odbiorca zdarzeń albo przekaźnik outboxu")
        try:
            await asyncio.wait_for(asyncio.to_thread(database_ping, engine), READY_TIMEOUT)
        except TimeoutError:
            raise HTTPException(503, "Baza zamówień nie odpowiada") from None
        return {"status": "UP"}

    return app


try:
    app = create_app()
except Exception as exc:  # noqa: BLE001
    # One JSON line instead of the traceback uvicorn would print: it is not JSON (D16) and texts of library
    # exceptions may quote DB_URL with the password. ConfigError texts never contain the value.
    configure_logging(SERVICE_NAME)
    log.error(f"Startup failed: {exc}" if isinstance(exc, ConfigError) else "Startup failed",
              extra={"fields": {"reason": type(exc).__name__}})
    raise SystemExit(1) from None
