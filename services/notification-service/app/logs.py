"""JSON logs on stdout, one line per entry, with requestId and userId (D16).

Never log passwords, tokens, cookies or personal data. Same format as docs/patterns.md, section 2.
"""

import json
import logging
import sys
import traceback
from contextvars import ContextVar
from datetime import UTC, datetime

from .config import SERVICE_NAME

# Set by the middleware for each request: every log line written while handling it has them.
request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
user_id_var: ContextVar[str | None] = ContextVar("user_id", default=None)

logger = logging.getLogger(SERVICE_NAME)
# logLevel applies to these loggers only. Libraries (httpx, sqlalchemy) log only warnings and errors:
# database drivers write whole commands, which may contain data.
SERVICE_LOGGERS = (SERVICE_NAME, "uvicorn")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        line = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "service": SERVICE_NAME,
            "requestId": request_id_var.get(),
            "userId": user_id_var.get(),
            "msg": record.getMessage(),
        }
        line |= getattr(record, "fields", {})
        if record.exc_info:
            # Type and frames only: messages of database errors can contain values.
            _, exc, exc_traceback = record.exc_info
            line["reason"] = type(exc).__name__
            line["stack"] = [f"{f.filename}:{f.lineno} {f.name}" for f in traceback.extract_tb(exc_traceback)]
        return json.dumps(line, default=str, ensure_ascii=False)


def setup_logging(level: str = "info") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(logging.WARNING)
    logging.captureWarnings(True)
    set_level(level)


def set_level(level: str) -> None:
    for name in SERVICE_LOGGERS:
        logging.getLogger(name).setLevel(level.upper())


def reason(exc: BaseException) -> dict:
    """Log fields for an error of Consul or of another service: class and message, no stack trace.
    Not for database errors: their message can contain data."""
    return {"fields": {"reason": f"{type(exc).__name__}: {exc}"}}
