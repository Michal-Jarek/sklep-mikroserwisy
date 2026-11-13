"""Uwierzytelnianie i autoryzacja po stronie usługi.

Dwa tryby (wybierane zmienną JWT_JWKS_URL):
* ustawiona  -> nagłówek Authorization: Bearer <JWT> jest weryfikowany (RS256, klucz publiczny z JWKS Auth Service),
                role i identyfikator użytkownika pochodzą z tokenu (claims: sub, roles),
* pusta      -> zaufanie nagłówkom X-User-Id / X-User-Roles (ustawia je wyłącznie Gateway;
                ruch do usługi ogranicza NetworkPolicy).
"""
from dataclasses import dataclass
from functools import lru_cache

import jwt
from fastapi import Depends, Request
from jwt import PyJWKClient

from app.config import get_settings
from app.errors import ApiError


@dataclass(frozen=True)
class Principal:
    user_id: str | None
    roles: frozenset[str]


def _roles(value) -> frozenset[str]:
    if value is None:
        return frozenset()
    if isinstance(value, str):
        value = value.split(",")
    return frozenset(str(v).strip().upper() for v in value if str(v).strip())


@lru_cache
def _jwks_client(url: str) -> PyJWKClient:
    return PyJWKClient(url, cache_keys=True, lifetime=300)


def get_principal(request: Request) -> Principal | None:
    settings = get_settings()
    auth = request.headers.get("authorization", "")

    if settings.jwt_jwks_url and auth.lower().startswith("bearer "):
        token = auth[7:].strip()
        try:
            key = _jwks_client(settings.jwt_jwks_url).get_signing_key_from_jwt(token).key
            claims = jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                issuer=settings.jwt_issuer or None,
                audience=settings.jwt_audience or None,
                options={"verify_aud": bool(settings.jwt_audience)},
            )
        except jwt.PyJWTError:
            raise ApiError(401, "UNAUTHORIZED", "Nieprawidłowy lub wygasły token")
        sub = claims.get("sub")
        return Principal(str(sub) if sub is not None else None, _roles(claims.get("roles", claims.get("role"))))

    user_id = request.headers.get("x-user-id")
    roles = _roles(request.headers.get("x-user-roles"))
    if user_id is None and not roles:
        return None
    return Principal(user_id, roles)


def require_roles(*allowed: str):
    allowed_set = {r.upper() for r in allowed}

    def dependency(principal: Principal | None = Depends(get_principal)) -> Principal:
        if principal is None:
            raise ApiError(401, "UNAUTHORIZED", "Wymagane uwierzytelnienie")
        if not principal.roles & allowed_set:
            raise ApiError(403, "FORBIDDEN", "Brak uprawnień do tej operacji")
        return principal

    return dependency
