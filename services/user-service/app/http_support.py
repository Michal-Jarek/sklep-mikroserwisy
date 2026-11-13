"""Wspólne błędy i logowanie bez tokenów, treści żądań i danych profilu."""
import json
import logging
import re
import sys
import traceback
from datetime import datetime, timezone
from http import HTTPStatus
from uuid import uuid4
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.openapi.utils import get_openapi
from starlette.exceptions import HTTPException

logger = logging.getLogger("shop.http")


class JsonFormatter(logging.Formatter):
    def __init__(self, service):
        super().__init__()
        self.service = service

    def format(self, record):
        line = {"time": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
                "level": record.levelname.lower(), "service": self.service,
                "requestId": None, "userId": None}
        try:
            fields = json.loads(record.getMessage())
        except (ValueError, TypeError):
            fields = {"message": record.getMessage()}
        line.update(fields if isinstance(fields, dict) else {"message": str(fields)})
        return json.dumps(line, ensure_ascii=False)


def error_response(request: Request, status: int, message: str) -> JSONResponse:
    error = {400: "VALIDATION_ERROR", 500: "INTERNAL_ERROR", 413: "PAYLOAD_TOO_LARGE"}.get(status, HTTPStatus(status).name if status in HTTPStatus._value2member_map_ else "INTERNAL_ERROR")
    if status >= 500 and not hasattr(request.state, "error_type"):
        request.state.error_type = "DependencyUnavailable" if status == 503 else "InternalError"
    return JSONResponse(status_code=status, content={
        "status": status, "error": error, "message": message,
        "requestId": getattr(request.state, "request_id", str(uuid4())),
    })


def configure_http(app: FastAPI, service_name: str, instance_id: str, log_level: str = "info") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service_name))
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(logging.WARNING)
    for name in ("shop.http", "shop.discovery", "shop.catalog", "uvicorn.error"):
        logging.getLogger(name).setLevel(log_level.upper())
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logging.getLogger(name).handlers = []
        logging.getLogger(name).propagate = True
    @app.middleware("http")
    async def context(request: Request, call_next):
        supplied = request.headers.get("X-Request-Id", "")
        request.state.request_id = supplied if re.fullmatch(r"[a-zA-Z0-9._-]{1,100}", supplied) else str(uuid4())
        try:
            response = await call_next(request)
        except Exception as exc:
            request.state.error_type = type(exc).__name__
            request.state.error_frames = [f"{frame.filename}:{frame.lineno} {frame.name}" for frame in traceback.extract_tb(exc.__traceback__)]
            # Odpowiedź nie ujawnia SQL, adresów połączeń ani stosu wywołań.
            response = error_response(request, 500, "Błąd wewnętrzny usługi")
        response.headers["X-Request-Id"] = request.state.request_id
        response.headers["X-Instance-Id"] = instance_id
        level = "error" if response.status_code >= 500 else "warning" if response.status_code >= 400 else "info"
        logger.log(getattr(logging, level.upper()), json.dumps({
            "time": datetime.now(timezone.utc).isoformat(), "level": level,
            "service": service_name, "requestId": request.state.request_id,
            "userId": getattr(request.state, "user_id", None),
            "path": request.url.path, "frames": getattr(request.state, "error_frames", None), "errorType": getattr(request.state, "error_type", None),
            "method": request.method, "status": response.status_code, "message": "HTTP request",
        }, ensure_ascii=False))
        return response

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        request.state.error_type = type(exc).__name__
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
                if path.startswith("/users"):
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
