import asyncio
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request

from app import db as database
from app.api import health, router
from app.config import get_settings
from app.consul_registration import ConsulRegistrar
from app.errors import register_error_handlers
from app.ids import request_id_or_new, valid_uuid
from app.logging_config import configure_logging, request_id_var, set_service_log_level, user_id_var
from app.remote_config import load_log_level

settings = get_settings()
configure_logging(settings.service_name, settings.log_level)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_client(settings.mongodb_url, settings.mongodb_database)
    try:
        await asyncio.to_thread(database.ensure_indexes, database.get_reviews())
    except Exception as exc:
        # bez MongoDB proces kończy się błędem, a compose/Kubernetes uruchamiają go ponownie
        logger.error("Nie udało się założyć indeksów, sprawdź połączenie z MongoDB", extra={"fields": {"reason": type(exc).__name__}})
        raise

    # poziom logowania z Consul KV; zmienna środowiskowa LOG_LEVEL ma pierwszeństwo
    if settings.consul_enabled and "log_level" not in settings.model_fields_set:
        level = await load_log_level(settings)
        if level:
            logger.info("Poziom logowania z Consul KV: %s", set_service_log_level(level))

    tasks: list[asyncio.Task] = []
    if settings.consul_enabled:
        tasks.append(asyncio.create_task(ConsulRegistrar(settings).run()))

    logger.info("Usługa %s wystartowała (instancja %s)", settings.service_name, settings.effective_instance_id)
    yield

    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    database.close()


app = FastAPI(
    title="Review Service",
    version="1.0.0",
    description="Oceny (1-5) i opinie o produktach, średnia ocena produktu.",
    lifespan=lifespan,
)
register_error_handlers(app)


@app.middleware("http")
async def request_context(request: Request, call_next):
    request_id = request_id_or_new(request.headers.get("x-request-id"))
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
