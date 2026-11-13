"""Builds the application: settings, logs, MongoDB, Consul, the consumer task and the endpoints.

The only API is GET /notifications/me (history of the logged-in customer) and /health/*.
"""

import asyncio
from contextlib import asynccontextmanager, suppress
from typing import Annotated

import httpx
from fastapi import Depends, FastAPI, Query, Request

from .config import SERVICE_NAME, Settings
from .consul import Discovery, Registration, load_kv
from .consumer import Consumer
from .logs import logger, set_level, setup_logging
from .mailer import SmtpMailer
from .store import MongoStore, Store
from .users import USER_SERVICE, UserClient
from .web import Identity, error_response, install, logged_in


def iso_utc(value) -> str:
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def create_app(settings: Settings | None = None, store: Store | None = None, mailer=None,
               transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    """store, mailer, transport: only for tests (no MongoDB, SMTP or network)."""
    settings = settings or Settings.from_env()
    setup_logging(settings.log_level)
    store = store or MongoStore(settings)

    async def is_ready(app: FastAPI) -> bool:
        """Own database answers, and the consumer task has not ended (D15, docs/events.md).
        A broker outage does not count: the consumer reconnects by itself."""
        task = getattr(app.state, "consumer_task", None)
        if task is not None and task.done():
            return False
        return await store.ping()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        consul_url = f"http://{settings.consul_host}:{settings.consul_port}"
        async with (
            httpx.AsyncClient(base_url=consul_url, timeout=2.0, trust_env=False) as consul,
            httpx.AsyncClient(timeout=2.0, trust_env=False, transport=transport) as http,
        ):
            settings.apply_kv(await load_kv(consul) if settings.consul_enabled else {})
            set_level(settings.log_level)
            discovery = Discovery(consul if settings.consul_enabled else None,
                                  {USER_SERVICE: settings.user_service_url})
            consumer = Consumer(settings, store, mailer or SmtpMailer(settings), UserClient(http, discovery))
            app.state.consumer = consumer

            app.state.consumer_task = None
            if settings.consumer_enabled:
                app.state.consumer_task = asyncio.create_task(consumer.run())
            else:
                # Allowed only in tests and local work (docs/events.md, "Konta, uprawnienia i zmienne").
                logger.warning("RABBITMQ_HOST is not set, the event consumer is off")

            registration = registration_task = None
            if settings.consul_enabled:
                registration = Registration(consul, settings, lambda: is_ready(app))
                registration_task = asyncio.create_task(registration.keep_registered())
            logger.info("Service started", extra={"fields": {
                "instanceId": settings.instance_id,
                "port": settings.port,
                "consumer": settings.consumer_enabled,
            }})
            yield
            # Shutdown: stop consuming first (unacked messages go back to the broker), then deregister.
            for task in (app.state.consumer_task, registration_task):
                if task is not None:
                    task.cancel()
                    with suppress(asyncio.CancelledError, Exception):
                        await task
            if registration is not None:
                await registration.deregister()
        store.close()

    # redirect_slashes=False: a trailing / is 404, not a redirect (D12).
    app = FastAPI(title=SERVICE_NAME, version="1.0.0", lifespan=lifespan, redirect_slashes=False)
    app.state.settings = settings
    app.state.store = store
    install(app, settings.instance_id)

    @app.get("/health/live", tags=["health"])
    async def health_live() -> dict:
        return {"status": "UP"}

    @app.get("/health/ready", tags=["health"])
    async def health_ready(request: Request):
        if not await is_ready(request.app):
            return error_response(503, "Database or event consumer not available")
        return {"status": "UP"}

    # HEAD like GET (D12).
    @app.head("/notifications/me", include_in_schema=False)
    @app.get("/notifications/me", tags=["notifications"])
    async def my_notifications(
        who: Annotated[Identity, Depends(logged_in)],
        page: Annotated[int, Query(ge=1)] = 1,
        size: Annotated[int, Query(ge=1, le=100)] = 20,
    ) -> dict:
        """E-mails sent to the logged-in customer, newest first. Only own entries (D11)."""
        try:
            rows, total = await store.list_for_user(str(who.user_id), page, size)
        except Exception as exc:
            logger.warning("Database not available", extra={"fields": {"reason": type(exc).__name__}})
            return error_response(503, "Database not available")
        items = [{"id": row["_id"], "type": row["type"], "subject": row["subject"], "sentAt": iso_utc(row["sentAt"])}
                 for row in rows]
        return {"items": items, "page": page, "size": size, "total": total}

    return app
