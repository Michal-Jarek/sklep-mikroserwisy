"""Tożsamość pochodzi wyłącznie z zaufanego Gateway lub usługi wewnętrznej."""
from dataclasses import dataclass
from uuid import UUID
from fastapi import HTTPException, Request

@dataclass(frozen=True)
class Caller:
    user_id: UUID | None
    roles: frozenset[str]
    request_id: str


def identity(request: Request, *, require_user: bool = True) -> Caller:
    raw_roles = request.headers.get("X-User-Roles", "")
    if not raw_roles.strip():
        raise HTTPException(401, "Brak tożsamości z Gateway")
    roles = frozenset(part.strip() for part in raw_roles.split(","))
    if not roles.intersection({"CUSTOMER", "ADMIN", "SERVICE"}):
        raise HTTPException(403, "Brak uprawnień")
    raw_id = request.headers.get("X-User-Id")
    try:
        user_id = UUID(raw_id) if raw_id else None
    except ValueError:
        raise HTTPException(401, "Niepoprawny X-User-Id") from None
    if require_user and user_id is None:
        raise HTTPException(401, "Brak X-User-Id")
    return Caller(user_id, roles, request.state.request_id)


def current_user(request: Request) -> Caller:
    return identity(request)


def service_caller(request: Request) -> Caller:
    caller = identity(request, require_user=False)
    if "SERVICE" not in caller.roles:
        raise HTTPException(403, "Wymagana rola SERVICE")
    return caller


def profile_reader(request: Request) -> Caller:
    caller = identity(request, require_user=False)
    if not caller.roles.intersection({"ADMIN", "SERVICE"}):
        raise HTTPException(403, "Brak uprawnień")
    return caller
