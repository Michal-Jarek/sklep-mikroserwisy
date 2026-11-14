"""Logi JSON na stdout (D16): time, level, service, requestId, userId, msg.

Poziom logLevel dotyczy tylko loggerów usługi ("app") i uvicorna. Biblioteki (httpx, sqlalchemy, pymongo, aio_pika)
zapisują tylko ostrzeżenia i błędy, bo na niższych poziomach logują całe polecenia i dane osobowe.
Przy wyjątku w logu jest jego typ i miejsca w kodzie (plik:linia funkcja), bez treści wyjątku.
"""
import json
import logging
import sys
import traceback
from contextvars import ContextVar
from datetime import datetime, timezone

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
user_id_var: ContextVar[str | None] = ContextVar("user_id", default=None)

SERVICE_LOGGERS = ("app", "uvicorn")
LOG_LEVELS = ("debug", "info", "warning", "error")


class JsonFormatter(logging.Formatter):
    def __init__(self, service: str):
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        line = {
            "time": datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "service": self.service,
            "requestId": request_id_var.get(),
            "userId": user_id_var.get(),
            "msg": record.getMessage(),
        }
        line |= getattr(record, "fields", {})
        if record.exc_info:
            _, exc, tb = record.exc_info
            line["reason"] = type(exc).__name__
            line["stack"] = [f"{f.filename}:{f.lineno} {f.name}" for f in traceback.extract_tb(tb)]
        return json.dumps(line, ensure_ascii=False, default=str)


def set_service_log_level(level: str) -> str:
    """Ustawia poziom loggerów usługi; nieznana wartość daje info. Zwraca użyty poziom."""
    level = str(level).lower()
    if level not in LOG_LEVELS:
        logging.getLogger(__name__).warning("Nieznany poziom logowania, używam info")
        level = "info"
    for name in SERVICE_LOGGERS:
        logging.getLogger(name).setLevel(level.upper())
    return level


def configure_logging(service: str, level: str = "info") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service))
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.WARNING)  # biblioteki: tylko ostrzeżenia i błędy
    logging.captureWarnings(True)
    # linie uvicorna też w formacie JSON (przez logger główny)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers = []
        uvicorn_logger.propagate = True
    set_service_log_level(level)
