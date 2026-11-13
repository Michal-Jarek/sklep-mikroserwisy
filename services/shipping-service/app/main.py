import asyncio
import logging
from contextlib import asynccontextmanager, suppress

import httpx
import yaml
from fastapi import FastAPI, HTTPException, Request
from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker

from .config import Settings
from .database import make_engine
from .discovery import Discovery
from .events import broker
from .http_support import configure_http, error_response
from .models import Base, Shipment
from .routes import router



async def register(discovery):
    while True:
        try:
            await discovery.register()
        except httpx.HTTPError:
            logging.warning("Consul niedostępny")
        await asyncio.sleep(30)


def create_app(settings=None):
    settings = settings or Settings()
    engine = make_engine(settings)
    factory = sessionmaker(engine, expire_on_commit=False)

    @asynccontextmanager
    async def lifespan(app):
        with engine.begin() as connection:
            if engine.dialect.name == "postgresql":
                connection.execute(text("SELECT pg_advisory_xact_lock(8089)"))
            Base.metadata.create_all(connection)
        async with httpx.AsyncClient(timeout=2, trust_env=False) as client:
            discovery = Discovery(client, settings.consul_url, settings.consul_enabled,
                "shipping-service", settings.instance_id, settings.service_address, settings.port)
            level = settings.log_level
            if settings.consul_enabled and level is None:
                try:
                    resp = await client.get(settings.consul_url + "/v1/kv/config/shipping-service/data?raw")
                    resp.raise_for_status()
                    level = (yaml.safe_load(resp.text) or {}).get("logLevel")
                except (httpx.HTTPError, yaml.YAMLError, AttributeError):
                    pass
            logging.getLogger().setLevel(getattr(logging, str(level).upper(), logging.INFO))
            app.state.courier_cost = settings.courier_cost
            tasks = []
            if settings.consul_enabled:
                tasks.append(asyncio.create_task(register(discovery)))
            app.state.worker = None
            if settings.broker_enabled:
                app.state.worker = asyncio.create_task(broker(settings, factory))
                tasks.append(app.state.worker)
            try:
                yield
            finally:
                for task in tasks:
                    task.cancel()
                for task in tasks:
                    with suppress(asyncio.CancelledError):
                        await task
                await discovery.deregister()
                engine.dispose()

    app = FastAPI(title="Shipping Service", version="1.0", lifespan=lifespan, redirect_slashes=False)
    app.state.session_factory = factory
    configure_http(app, "shipping-service", settings.instance_id)
    app.include_router(router)

    @app.middleware("http")
    async def head(request, call_next):
        if request.method == "HEAD":
            request.scope["method"] = "GET"
        return await call_next(request)

    @app.exception_handler(SQLAlchemyError)
    async def database_error(request: Request, exc):
        return error_response(request, 503, "Baza przesyłek niedostępna")

    @app.get("/health/live")
    def live():
        return {"status": "UP"}

    @app.get("/health/ready")
    def ready():
        if app.state.worker and app.state.worker.done():
            raise HTTPException(503, "Zatrzymany odbiorca zdarzeń")
        with engine.connect() as connection:
            connection.execute(select(Shipment.id).limit(0))
        return {"status": "UP"}

    return app


app = create_app()
