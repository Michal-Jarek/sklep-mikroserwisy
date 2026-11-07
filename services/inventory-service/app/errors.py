import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

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
    return JSONResponse(
        status_code=status,
        content={
            "status": status,
            "error": error,
            "message": message,
            "requestId": getattr(request.state, "request_id", None),
        },
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

    @app.exception_handler(Exception)
    async def unhandled_error_handler(request: Request, exc: Exception):
        logger.exception("Nieobsłużony błąd")
        return _response(request, 500, "INTERNAL_ERROR", "Wystąpił błąd wewnętrzny")
