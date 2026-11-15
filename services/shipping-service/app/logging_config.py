"""JSON logs on stdout (D16): one line per entry with time, level, service, requestId, userId, msg.

logLevel applies only to the service loggers ("shipping"). Libraries (aio_pika, aiormq, httpx, sqlalchemy,
uvicorn.error) write only warnings and errors through the same formatter. An exception is logged only as its
class ("reason"): messages of drivers and validators may contain addresses from events or connection strings.
uvicorn.access is off: the HTTP middleware writes one line per request with requestId.
Never log passwords, the delivery address or e-mail addresses.
"""
import json
import logging
import re
import sys
from contextvars import ContextVar
from datetime import datetime, timezone

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
user_id_var: ContextVar[str | None] = ContextVar("user_id", default=None)

SERVICE_LOGGER = "shipping"
LIBRARY_LOGGERS = ("aio_pika", "aiormq", "httpx", "httpcore", "sqlalchemy", "uvicorn", "uvicorn.error")
LOG_LEVELS = ("debug", "info", "warning", "error")
# "package.SomeError: message" at the start of a traceback line (SQLAlchemy adds a "(Background ...)" line after it).
EXCEPTION_LINE = re.compile(r"^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt))(?::|$)", re.MULTILINE)


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
        if record.exc_info and record.exc_info[1] is not None:
            line["reason"] = type(record.exc_info[1]).__name__
        elif line["msg"].startswith("Traceback (most recent call last)"):
            # uvicorn logs a failed startup as the formatted traceback text: keep only the exception class.
            classes = EXCEPTION_LINE.findall(line["msg"])
            line["msg"] = "Unhandled exception"
            line["reason"] = classes[-1].rsplit(".", 1)[-1] if classes else "Exception"
        return json.dumps(line, ensure_ascii=False, default=str)


def set_service_log_level(level: str | None) -> str:
    """Sets the level of the service loggers; an unknown value gives info. Returns the level used."""
    level = str(level).lower()
    if level not in LOG_LEVELS:
        level = "info"
    logging.getLogger(SERVICE_LOGGER).setLevel(level.upper())
    return level


def configure_logging(service: str, level: str | None = "info") -> None:
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
    access.disabled = True
    set_service_log_level(level)
