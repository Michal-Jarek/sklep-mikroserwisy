"""Logi JSON na stdout (D16): time, level, service, requestId, userId, msg.

Poziom logLevel dotyczy tylko loggerów usługi ("app"). Biblioteki (uvicorn, httpx, sqlalchemy, aio_pika, aiormq)
zapisują tylko ostrzeżenia i błędy przez ten sam formater, bo na niższych poziomach logują całe polecenia i dane osobowe.
Przy wyjątku w logu jest jego typ i miejsca w kodzie (plik:linia funkcja), bez treści wyjątku. Jeden wpis to zawsze
jedna linia JSON (ślad wyjątku wklejony przez bibliotekę w treść komunikatu też jest zamieniany na sam typ wyjątku).
"""
import json
import logging
import re
import sys
import traceback
from contextvars import ContextVar
from datetime import datetime, timezone

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
user_id_var: ContextVar[str | None] = ContextVar("user_id", default=None)

SERVICE_LOGGERS = ("app",)
LOG_LEVELS = ("debug", "info", "warning", "error")

TRACEBACK_HEADER = "Traceback (most recent call last):"
# ostatnia linia śladu: "pakiet.KlasaWyjątku: treść" albo sama klasa
_EXCEPTION_LINE = re.compile(r"^([A-Za-z_][\w.]*)(?::|$)")


def _without_traceback(msg: str) -> tuple[str, str | None]:
    """Starlette przekazuje uvicornowi błąd startu jako tekst śladu (z treścią wyjątku, np. adresem bazy z hasłem)."""
    if TRACEBACK_HEADER not in msg:
        return msg, None
    before = msg.split(TRACEBACK_HEADER, 1)[0].strip()
    last = msg.rstrip().splitlines()[-1].strip()
    match = _EXCEPTION_LINE.match(last)
    reason = match.group(1).rsplit(".", 1)[-1] if match else "Exception"
    return before or "Wyjątek (szczegóły pominięte)", reason


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
        }
        msg, reason = _without_traceback(record.getMessage())
        line["msg"] = msg
        if reason:
            line["reason"] = reason
        line |= getattr(record, "fields", {})
        if record.exc_info and record.exc_info[1] is not None:  # aio-pika loguje też exc_info=(None, None, None)
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
    # linie uvicorna też w formacie JSON (przez logger główny), tylko ostrzeżenia i błędy
    for name in ("uvicorn", "uvicorn.error"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers = []
        uvicorn_logger.propagate = True
        uvicorn_logger.setLevel(logging.WARNING)
    # jedna linia na żądanie pisze middleware usługi; dziennik dostępu uvicorna zostaje wyłączony (--no-access-log)
    access = logging.getLogger("uvicorn.access")
    access.handlers = []
    access.propagate = False
    set_service_log_level(level)
