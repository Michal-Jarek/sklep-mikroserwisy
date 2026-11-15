"""Identyfikatory w całym sklepie to UUID zapisany tekstem (np. "3f0c9b1e-6a52-4a8e-9c1f-0b2f7e1d5a77")."""
import re
import uuid
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


def valid_uuid(value) -> str | None:
    """UUID małymi literami albo None, gdy wartości brak lub nie jest UUID zapisanym tekstem (np. liczba)."""
    if not value:
        return None
    try:
        return canonical_uuid(value)
    except ValueError:
        return None


# typ pola w treści żądania (productId, orderId); liczba zamiast tekstu też zostanie odrzucona
UuidText = Annotated[str, AfterValidator(canonical_uuid)]

REQUEST_ID_PATTERN = re.compile(r"[A-Za-z0-9._-]{1,64}")  # ta sama reguła co w Gateway


def request_id_or_new(value) -> str:
    """X-Request-Id albo requestId z koperty zdarzenia: wartość niepasująca do wzorca zastępuje nowy UUID."""
    if isinstance(value, str) and REQUEST_ID_PATTERN.fullmatch(value):
        return value
    return str(uuid.uuid4())
