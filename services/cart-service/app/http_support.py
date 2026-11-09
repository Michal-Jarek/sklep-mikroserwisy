"""Wspólne błędy i logowanie bez tokenów, treści żądań i danych profilu."""
import json
import logging
import re
from datetime import datetime, timezone
from http import HTTPStatus
from uuid import uuid4
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.openapi.utils import get_openapi
from starlette.exceptions import HTTPException

logger = logging.getLogger("shop.http")


def error_response(request: Request, status: int, message: str) -> JSONResponse:
    error = HTTPStatus(status).name if status in HTTPStatus._value2member_map_ else "INTERNAL_SERVER_ERROR"
    return JSONResponse(status_code=status, content={
        "status": status, "error": error, "message": message,
        "requestId": getattr(request.state, "request_id", str(uuid4())),
    })


def configure_http(app: FastAPI, service_name: str, instance_id: str) -> None:
    @app.middleware("http")
    async def context(request: Request, call_next):
        supplied = request.headers.get("X-Request-Id", "")
        request.state.request_id = supplied if re.fullmatch(r"[a-zA-Z0-9._-]{1,100}", supplied) else str(uuid4())
        try:
            response = await call_next(request)
        except Exception:
            # Odpowiedź nie ujawnia SQL, adresów połączeń ani stosu wywołań.
            response = error_response(request, 500, "Błąd wewnętrzny usługi")
        response.headers["X-Request-Id"] = request.state.request_id
        response.headers["X-Instance-Id"] = instance_id
        logger.info(json.dumps({
            "time": datetime.now(timezone.utc).isoformat(), "level": "info",
            "service": service_name, "requestId": request.state.request_id,
            "method": request.method, "status": response.status_code, "message": "HTTP request",
        }, ensure_ascii=False))
        return response

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
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
                if path.startswith(("/users", "/cart")):
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
