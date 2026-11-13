"""HTTP glue: error format (D7), X-Request-Id and X-Instance-Id (D13, D16), one log line per request,
identity from X-User-Id and X-User-Roles (D10, D11). Follows docs/patterns.md, section 2."""

import re
import time
import uuid
from dataclasses import dataclass
from http import HTTPStatus
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .logs import logger, request_id_var, user_id_var

REQUEST_ID_PATTERN = re.compile(r"[A-Za-z0-9._-]{1,64}")  # the same rule as in the Gateway
ERROR_CODES = {
    400: "VALIDATION_ERROR",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    413: "PAYLOAD_TOO_LARGE",
    415: "UNSUPPORTED_MEDIA_TYPE",
    429: "TOO_MANY_REQUESTS",
    500: "INTERNAL_ERROR",
    503: "SERVICE_UNAVAILABLE",
}


def error_response(status: int, message: str, headers: dict[str, str] | None = None) -> JSONResponse:
    """{"status", "error", "message", "requestId"} (D7)."""
    error = ERROR_CODES.get(status) or HTTPStatus(status).phrase.upper().replace(" ", "_").replace("-", "_")
    body = {"status": status, "error": error, "message": message, "requestId": request_id_var.get()}
    return JSONResponse(body, status_code=status, headers=headers)


def valid_uuid(value: str | None) -> str | None:
    try:
        return str(uuid.UUID(value)) if value else None
    except ValueError:
        return None


def install(app: FastAPI, instance_id: str) -> None:
    @app.middleware("http")
    async def request_context(request: Request, call_next):
        received = request.headers.get("x-request-id", "")
        request_id = received if REQUEST_ID_PATTERN.fullmatch(received) else str(uuid.uuid4())
        request_id_var.set(request_id)
        user_id_var.set(valid_uuid(request.headers.get("x-user-id")))
        started = time.monotonic()
        try:
            response = await call_next(request)
        except Exception:
            # Unexpected error: the client gets the team format without details, the log the stack.
            logger.exception("Unhandled error")
            response = error_response(500, "Internal server error")
        response.headers["X-Request-Id"] = request_id
        response.headers["X-Instance-Id"] = instance_id
        if not request.url.path.startswith("/health/"):
            logger.info("Request completed", extra={"fields": {
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "durationMs": round((time.monotonic() - started) * 1000),
            }})
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        # FastAPI answers 422 by default; the team uses 400 VALIDATION_ERROR (D7).
        message = "; ".join(
            f"{'.'.join(map(str, error['loc']))}: {error['msg']}" for error in exc.errors()
        )
        return error_response(400, message[:500])

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        # 404 unknown path, 405 wrong method, and HTTPException raised in endpoints and dependencies.
        return error_response(exc.status_code, str(exc.detail), exc.headers)


@dataclass(frozen=True)
class Identity:
    """Who sends the request: X-User-Id and X-User-Roles, set only by the Gateway (D11)."""

    user_id: uuid.UUID | None  # None: anonymous client or work in the background
    roles: frozenset[str]

    def call_headers(self) -> dict[str, str]:
        """Headers for a call to another service on behalf of this caller (D11)."""
        headers = {
            "X-User-Roles": ",".join(sorted(self.roles | {"SERVICE"})),
            "X-Request-Id": request_id_var.get() or str(uuid.uuid4()),
        }
        if self.user_id:
            headers["X-User-Id"] = str(self.user_id)
        return headers


async def identity(
    x_user_id: Annotated[uuid.UUID | None, Header()] = None,
    x_user_roles: Annotated[str, Header()] = "",
) -> Identity:
    """Public endpoints use this directly: works without the headers. A role is checked as an
    element of the comma-separated list, never as a substring (D11)."""
    roles = frozenset(role.strip() for role in x_user_roles.split(",") if role.strip())
    return Identity(x_user_id, roles)


async def logged_in(who: Annotated[Identity, Depends(identity)]) -> Identity:
    if who.user_id is None:
        raise HTTPException(401, "Login required")
    return who
