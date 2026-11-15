"""Common errors and one JSON log line per request, without tokens, request bodies or personal data."""
import logging
import re
import time
from http import HTTPStatus
from uuid import UUID, uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError
from starlette.exceptions import HTTPException

from .logging_config import request_id_var, user_id_var

log = logging.getLogger("app.http")
REQUEST_ID = re.compile(r"[A-Za-z0-9._-]{1,64}")


def valid_request_id(value: object) -> str:
    """X-Request-Id / envelope requestId by the same rule as the Gateway; anything else gets a new UUID."""
    return value if isinstance(value, str) and REQUEST_ID.fullmatch(value) else str(uuid4())


def error_response(request: Request, status: int, message: str, domain_code: str | None = None) -> JSONResponse:
    error = HTTPStatus(status).name if status in HTTPStatus._value2member_map_ else "INTERNAL_SERVER_ERROR"
    code = domain_code or ("VALIDATION_ERROR" if status == 400 else "INTERNAL_ERROR" if status == 500 else error)
    return JSONResponse(status_code=status, content={
        "status": status, "error": code, "message": message,
        "requestId": getattr(request.state, "request_id", None) or str(uuid4()),
    })


def configure_http(app: FastAPI, instance_id: str) -> None:
    @app.middleware("http")
    async def context(request: Request, call_next):
        started = time.monotonic()
        request.state.request_id = valid_request_id(request.headers.get("X-Request-Id"))
        try:
            user_id = str(UUID(request.headers.get("X-User-Id", "")))
        except ValueError:
            user_id = None
        request_token = request_id_var.set(request.state.request_id)
        user_token = user_id_var.set(user_id)
        try:
            try:
                response = await call_next(request)
            except Exception as exc:
                # The response reveals no SQL, connection address or stack; the log has the class only.
                log.error("Unhandled error", extra={"fields": {"reason": type(exc).__name__}})
                response = error_response(request, 500, "Błąd wewnętrzny usługi")
            response.headers["X-Request-Id"] = request.state.request_id
            response.headers["X-Instance-Id"] = instance_id
            log.info("HTTP request", extra={"fields": {
                "method": request.method, "path": request.url.path, "status": response.status_code,
                "durationMs": round((time.monotonic() - started) * 1000)}})
            return response
        finally:
            request_id_var.reset(request_token)
            user_id_var.reset(user_token)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        if isinstance(exc.detail, dict):
            return error_response(request, exc.status_code, exc.detail["message"], exc.detail["error"])
        return error_response(request, exc.status_code, str(exc.detail))

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        # FastAPI uses 422 by default; the shop contract uses 400.
        return error_response(request, 400, "Niepoprawne dane żądania")

    @app.exception_handler(SQLAlchemyError)
    async def database_error(request: Request, exc: SQLAlchemyError):
        log.warning("Database error", extra={"fields": {"reason": type(exc).__name__}})
        return error_response(request, 503, "Baza zamówień niedostępna")

    def documented_openapi():
        if app.openapi_schema is not None:
            return app.openapi_schema
        schema = get_openapi(title=app.title, version=app.version, routes=app.routes)
        error_schema = {"type": "object", "required": ["status", "error", "message", "requestId"],
            "properties": {"status": {"type": "integer"}, "error": {"type": "string"},
                "message": {"type": "string"}, "requestId": {"type": "string"}}}
        schema.setdefault("components", {}).setdefault("schemas", {})["ErrorBody"] = error_schema
        for path, methods in schema["paths"].items():
            for operation in methods.values():
                if not isinstance(operation, dict):
                    continue
                responses = operation.setdefault("responses", {})
                responses.pop("422", None)
                if path.startswith("/orders"):
                    params = operation.setdefault("parameters", [])
                    for name, required in (("X-User-Id", False), ("X-User-Roles", True), ("X-Request-Id", False)):
                        params.append({"in": "header", "name": name, "required": required,
                            "schema": {"type": "string"}, "description": "Header set by the trusted Gateway"})
                    for status in (400, 401, 403, 404, 409, 503):
                        responses[str(status)] = {"description": HTTPStatus(status).phrase,
                            "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ErrorBody"}}}}
        app.openapi_schema = schema
        return schema

    app.openapi = documented_openapi
