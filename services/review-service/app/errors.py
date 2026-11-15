import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pymongo.errors import ConnectionFailure, ExecutionTimeout
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.logging_config import request_id_var

logger = logging.getLogger(__name__)

_CODES = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    503: "SERVICE_UNAVAILABLE",
}


class ApiError(Exception):
    """Błąd biznesowy zwracany w jednolitym formacie zespołu."""

    def __init__(self, status: int, error: str, message: str):
        super().__init__(message)
        self.status = status
        self.error = error
        self.message = message


def _response(request: Request, status: int, error: str, message: str) -> JSONResponse:
    request_id = getattr(request.state, "request_id", None)
    return JSONResponse(
        status_code=status,
        content={"status": status, "error": error, "message": message, "requestId": request_id},
        headers={"X-Request-Id": request_id} if request_id else None,  # także dla błędów 500 spoza middleware
    )


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def api_error_handler(request: Request, exc: ApiError):
        return _response(request, exc.status, exc.error, exc.message)

    @app.exception_handler(StarletteHTTPException)
    async def http_error_handler(request: Request, exc: StarletteHTTPException):
        code = _CODES.get(exc.status_code, "ERROR")
        return _response(request, exc.status_code, code, str(exc.detail))

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError):
        parts = []
        for err in exc.errors():
            loc = ".".join(str(p) for p in err["loc"] if p not in ("body", "query", "path"))
            parts.append(f"{loc}: {err['msg']}" if loc else err["msg"])
        return _response(request, 400, "VALIDATION_ERROR", "; ".join(parts) or "Niepoprawne dane wejściowe")

    async def database_unavailable_handler(request: Request, exc: Exception):
        logger.warning("Baza danych niedostępna", extra={"fields": {"reason": type(exc).__name__}})
        return _response(request, 503, "SERVICE_UNAVAILABLE", "Baza danych niedostępna")

    # ConnectionFailure obejmuje ServerSelectionTimeoutError, AutoReconnect i NetworkTimeout (baza nie odpowiada)
    app.add_exception_handler(ConnectionFailure, database_unavailable_handler)
    app.add_exception_handler(ExecutionTimeout, database_unavailable_handler)

    @app.exception_handler(Exception)
    async def unhandled_error_handler(request: Request, exc: Exception):
        # ten handler działa poza middleware, które ustawia requestId w logach, więc ustawiamy go jeszcze raz
        token = request_id_var.set(getattr(request.state, "request_id", None))
        try:
            logger.exception("Nieobsłużony błąd")
        finally:
            request_id_var.reset(token)
        return _response(request, 500, "INTERNAL_ERROR", "Wystąpił błąd wewnętrzny")
