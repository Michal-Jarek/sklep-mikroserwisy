import asyncio
import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request

from app import db as database
from app.api import health, router
from app.config import get_settings
from app.consul_registration import ConsulRegistrar
from app.consumer import run_consumer
from app.errors import register_error_handlers
from app.events import handle_event
from app.logging_config import configure_logging, request_id_var, user_id_var

settings = get_settings()
configure_logging(settings.service_name, settings.log_level)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_engine(settings.database_url)
    await asyncio.to_thread(database.create_schema)

    tasks: list[asyncio.Task] = []
    if settings.consul_enabled:
        tasks.append(asyncio.create_task(ConsulRegistrar(settings).run()))
    if settings.rabbitmq_url:
        tasks.append(asyncio.create_task(run_consumer(settings, handle_event)))
    else:
        logger.warning("RABBITMQ_URL pusty - konsument zdarzeń wyłączony")

    logger.info("Usługa %s wystartowała (instancja %s)", settings.service_name, settings.effective_instance_id)
    yield

    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    database.dispose()


app = FastAPI(
    title="Inventory Service",
    version="1.0.0",
    description="Stany magazynowe i rezerwacje towaru dla zamówień.",
    lifespan=lifespan,
)
register_error_handlers(app)


@app.middleware("http")
async def request_context(request: Request, call_next):
    request_id = (request.headers.get("x-request-id") or str(uuid.uuid4()))[:64]
    request.state.request_id = request_id
    rid_token = request_id_var.set(request_id)
    uid_token = user_id_var.set(request.headers.get("x-user-id"))
    start = time.perf_counter()
    try:
        response = await call_next(request)
        response.headers["X-Request-Id"] = request_id
        response.headers["X-Instance-Id"] = settings.effective_instance_id
        if not request.url.path.startswith("/health"):
            logger.info(
                "%s %s -> %s (%.1f ms)",
                request.method,
                request.url.path,
                response.status_code,
                (time.perf_counter() - start) * 1000,
            )
        return response
    finally:
        request_id_var.reset(rid_token)
        user_id_var.reset(uid_token)


app.include_router(health)
app.include_router(router)
