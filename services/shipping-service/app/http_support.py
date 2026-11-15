"""Shared errors and request logging without tokens, request bodies or profile data."""
import logging
import re
from http import HTTPStatus
from uuid import UUID, uuid4
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.openapi.utils import get_openapi
from starlette.exceptions import HTTPException

from .logging_config import request_id_var, user_id_var

logger = logging.getLogger("shipping.http")
REQUEST_ID = re.compile(r"[A-Za-z0-9._-]{1,64}")  # the same rule as in the Gateway


def valid_uuid(value: str | None) -> str | None:
    try:
        return str(UUID(value)) if value else None
    except ValueError:
        return None


def error_response(request: Request, status: int, message: str, domain_code: str | None = None) -> JSONResponse:
    error = HTTPStatus(status).name if status in HTTPStatus._value2member_map_ else "INTERNAL_SERVER_ERROR"
    return JSONResponse(status_code=status, content={
        "status": status, "error": domain_code or ("VALIDATION_ERROR" if status == 400 else "INTERNAL_ERROR" if status == 500 else error), "message": message,
        "requestId": getattr(request.state, "request_id", str(uuid4())),
    })


def configure_http(app: FastAPI, instance_id: str) -> None:
    @app.middleware("http")
    async def context(request: Request, call_next):
        supplied = request.headers.get("X-Request-Id", "")
        request.state.request_id = supplied if REQUEST_ID.fullmatch(supplied) else str(uuid4())
        request_token = request_id_var.set(request.state.request_id)
        # Only a valid UUID reaches the log: a request bypassing the Gateway may send any text.
        user_token = user_id_var.set(valid_uuid(request.headers.get("X-User-Id")))
        try:
            try:
                response = await call_next(request)
            except Exception:
                # Only the exception class in the log; the response reveals no SQL, addresses or stack.
                logger.exception("Unhandled error", extra={"fields": {"method": request.method, "path": request.url.path}})
                response = error_response(request, 500, "Błąd wewnętrzny usługi")
            response.headers["X-Request-Id"] = request.state.request_id
            response.headers["X-Instance-Id"] = instance_id
            if not request.url.path.startswith("/health"):
                logger.info("HTTP request", extra={"fields": {
                    "method": request.method, "path": request.url.path, "status": response.status_code}})
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
        # FastAPI domyślnie używa 422. Zachowujemy wspólny kontrakt sklepu: 400.
        return error_response(request, 400, "Niepoprawne dane żądania")

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
                if path.startswith("/shipments"):
                    params = operation.setdefault("parameters", [])
                    for name, required in (("X-User-Id", False), ("X-User-Roles", True), ("X-Request-Id", False)):
                        params.append({"in": "header", "name": name, "required": required,
                            "schema": {"type": "string"}, "description": "Nagłówek zaufanego Gateway; bezpośrednio tylko do testów lokalnych"})
                    for status in (400, 401, 403, 404, 409, 503):
                        responses[str(status)] = {"description": HTTPStatus(status).phrase,
                            "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ErrorBody"}}}}
        app.openapi_schema = schema
        return schema

    app.openapi = documented_openapi
