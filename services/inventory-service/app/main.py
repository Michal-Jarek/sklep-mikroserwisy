import asyncio
import logging
import re
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
from app.remote_config import load_log_level
from app.ids import valid_uuid
from app.logging_config import configure_logging, request_id_var, set_service_log_level, user_id_var

settings = get_settings()
REQUEST_ID_PATTERN = re.compile(r"[A-Za-z0-9._-]{1,64}")  # ta sama reguła co w Gateway
configure_logging(settings.service_name, settings.log_level)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_engine(settings.database_url)
    await asyncio.to_thread(database.create_schema)

    # poziom logowania z Consul KV; zmienna środowiskowa LOG_LEVEL ma pierwszeństwo
    if settings.consul_enabled and "log_level" not in settings.model_fields_set:
        level = await load_log_level(settings)
        if level:
            logger.info("Poziom logowania z Consul KV: %s", set_service_log_level(level))

    tasks: list[asyncio.Task] = []
    if settings.consul_enabled:
        tasks.append(asyncio.create_task(ConsulRegistrar(settings).run()))
    if settings.rabbitmq_host:
        consumer_task = asyncio.create_task(run_consumer(settings, handle_event))
        app.state.consumer_task = consumer_task
        tasks.append(consumer_task)
    else:
        logger.warning("RABBITMQ_HOST pusty - konsument zdarzeń wyłączony")

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
    redirect_slashes=False,  # /inventory/x/ to 404, nie przekierowanie
)
register_error_handlers(app)


@app.middleware("http")
async def request_context(request: Request, call_next):
    received = request.headers.get("x-request-id", "")
    request_id = received if REQUEST_ID_PATTERN.fullmatch(received) else str(uuid.uuid4())
    request.state.request_id = request_id
    rid_token = request_id_var.set(request_id)
    # do logów trafia tylko poprawny UUID: żądanie z pominięciem Gateway może wysłać dowolny tekst
    uid_token = user_id_var.set(valid_uuid(request.headers.get("x-user-id")))
    start = time.perf_counter()
    try:
        response = await call_next(request)
        response.headers["X-Request-Id"] = request_id
        response.headers["X-Instance-Id"] = settings.effective_instance_id
        if not request.url.path.startswith("/health"):
            logger.info(
                "Request completed",
                extra={"fields": {
                    "method": request.method,
                    "path": request.url.path,
                    "status": response.status_code,
                    "durationMs": round((time.perf_counter() - start) * 1000),
                }},
            )
        return response
    finally:
        request_id_var.reset(rid_token)
        user_id_var.reset(uid_token)


app.include_router(health)
app.include_router(router)
