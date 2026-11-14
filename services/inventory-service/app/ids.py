"""Identyfikatory w całym sklepie to UUID zapisany tekstem (np. "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77")."""
from typing import Annotated
from uuid import UUID

from pydantic import AfterValidator

from app.errors import ApiError


def canonical_uuid(value: str) -> str:
    """Zwraca UUID małymi literami z myślnikami albo rzuca ValueError."""
    if not isinstance(value, str) or len(value) != 36:
        raise ValueError("musi być poprawnym UUID")
    try:
        return str(UUID(value))
    except ValueError:
        raise ValueError("musi być poprawnym UUID")


def uuid_or_400(value: str, name: str = "productId") -> str:
    """Dla parametrów ścieżki: niepoprawny UUID to 400 VALIDATION_ERROR."""
    try:
        return canonical_uuid(value)
    except ValueError:
        raise ApiError(400, "VALIDATION_ERROR", f"{name}: musi być poprawnym UUID")


def valid_uuid(value: str | None) -> str | None:
    """UUID małymi literami albo None, gdy wartości brak lub nie jest UUID (np. do logów)."""
    if not value:
        return None
    try:
        return canonical_uuid(value)
    except ValueError:
        return None


# typ pola w treści żądania; liczba zamiast tekstu też zostanie odrzucona
ProductId = Annotated[str, AfterValidator(canonical_uuid)]
