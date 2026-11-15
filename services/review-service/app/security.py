"""Tożsamość i role pochodzą wyłącznie z nagłówków ustawianych przez Gateway (D11).

* X-User-Id: UUID użytkownika; wartość niebędąca UUID to 400 VALIDATION_ERROR.
* X-User-Roles: lista oddzielona przecinkami (np. "CUSTOMER,SERVICE"). Role to zbiór; wielkość liter ma znaczenie,
  a rolę sprawdza się przez przynależność do zbioru, nigdy przez szukanie tekstu w nagłówku ("XSERVICE" to nie SERVICE).
Usługa wołająca inną usługę dopisuje do ról SERVICE.
Nagłówki są parametrami zależności, więc Swagger UI pokazuje na nie pola.
"""
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Header

from app.errors import ApiError
from app.ids import valid_uuid


@dataclass(frozen=True)
class Principal:
    user_id: str | None  # None: klient anonimowy albo praca w tle (np. wywołanie z samą rolą SERVICE)
    roles: frozenset[str]


def identity(
    x_user_id: Annotated[str | None, Header()] = None,
    x_user_roles: Annotated[str, Header()] = "",
) -> Principal:
    """Działa bez nagłówków (brak user_id, pusty zbiór ról)."""
    user_id = None
    if x_user_id is not None:
        user_id = valid_uuid(x_user_id)
        if user_id is None:
            raise ApiError(400, "VALIDATION_ERROR", "X-User-Id: musi być poprawnym UUID")
    roles = frozenset(role.strip() for role in x_user_roles.split(",") if role.strip())
    return Principal(user_id, roles)


def logged_in(who: Principal = Depends(identity)) -> Principal:
    """Endpoint wymagający logowania: bez X-User-Id 401."""
    if who.user_id is None:
        raise ApiError(401, "UNAUTHORIZED", "Wymagane uwierzytelnienie")
    return who


def admin_only(who: Principal = Depends(logged_in)) -> Principal:
    """Zalogowany użytkownik z rolą ADMIN; zalogowany bez tej roli dostaje 403."""
    if "ADMIN" not in who.roles:
        raise ApiError(403, "FORBIDDEN", "Brak uprawnień do tej operacji")
    return who


def service_only(who: Principal = Depends(identity)) -> Principal:
    """Endpoint wewnętrzny (D10): bez roli SERVICE 403. X-User-Id nie jest wymagany."""
    if "SERVICE" not in who.roles:
        raise ApiError(403, "FORBIDDEN", "Tylko dla innych usług")
    return who
