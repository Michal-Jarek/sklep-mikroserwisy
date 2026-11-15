"""JSON logs on stdout (D16): one line per entry with time, level, service, requestId, userId, msg.

The log level (LOG_LEVEL, otherwise logLevel from Consul KV) applies only to the service loggers ("app").
Libraries (aio_pika, aiormq, httpx, sqlalchemy, uvicorn.error) write only warnings and errors through the same
formatter: on lower levels they log whole commands and personal data. An exception is logged only as its class
(field "reason"): aio-pika logs its own tracebacks while it reconnects, and exception texts may contain addresses.
uvicorn.access does not propagate: the HTTP middleware writes one JSON line per request instead.
A failed application startup reaches uvicorn as the text of a traceback (Starlette): the formatter keeps only the
exception class from it.
"""
import json
import logging
import re
import sys
from contextvars import ContextVar
from datetime import datetime, timezone

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
user_id_var: ContextVar[str | None] = ContextVar("user_id", default=None)

SERVICE_LOGGERS = ("app",)
LIBRARY_LOGGERS = ("aio_pika", "aiormq", "httpx", "httpcore", "sqlalchemy", "uvicorn", "uvicorn.error")
LOG_LEVELS = ("debug", "info", "warning", "error")
TRACEBACK = "Traceback (most recent call last):"
EXCEPTION_LINE = re.compile(r"([A-Za-z_][\w.]*)(?::|$)")  # last line of a traceback: "module.Class: text"


def without_traceback(msg: str) -> tuple[str, str | None]:
    """Message without traceback text and the class of its last exception (None when there is no traceback)."""
    if TRACEBACK not in msg:
        return msg, None
    match = EXCEPTION_LINE.match(msg.rstrip().splitlines()[-1].strip())
    reason = match.group(1).rsplit(".", 1)[-1] if match else "Exception"
    return msg.split(TRACEBACK, 1)[0].strip() or "Unhandled exception", reason


class JsonFormatter(logging.Formatter):
    def __init__(self, service: str):
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        msg, reason = without_traceback(record.getMessage())
        line = {
            "time": datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "service": self.service,
            "requestId": request_id_var.get(),
            "userId": user_id_var.get(),
            "msg": msg,
        }
        if reason:
            line["reason"] = reason
        line |= getattr(record, "fields", {})
        if record.exc_info and record.exc_info[1] is not None:
            line["reason"] = type(record.exc_info[1]).__name__
        return json.dumps(line, ensure_ascii=False, default=str)


def set_service_log_level(level: str | None) -> str:
    """Sets the level of the service loggers; an unknown value gives info. Returns the level used."""
    level = str(level or "info").lower()
    if level not in LOG_LEVELS:
        logging.getLogger("app.logging").warning("Unknown log level, using info")
        level = "info"
    for name in SERVICE_LOGGERS:
        logging.getLogger(name).setLevel(level.upper())
    return level


def configure_logging(service: str, level: str | None = None) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service))
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.WARNING)
    logging.captureWarnings(True)
    for name in LIBRARY_LOGGERS:
        library = logging.getLogger(name)
        library.handlers = []
        library.propagate = True
        library.setLevel(logging.WARNING)
    access = logging.getLogger("uvicorn.access")
    access.handlers = []
    access.propagate = False
    set_service_log_level(level)
