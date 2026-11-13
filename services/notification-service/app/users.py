"""E-mail address and first name of a customer from User Service: GET /users/{id} (role SERVICE).

Order and shipment events carry only userId (no personal data in events), so Notification asks User.
Rules of D2 (docs/patterns.md, section 4): timeout 2 s per attempt, retries only after no connection,
timeout, 502, 503, 504 (at most 2, after 200 and 400 ms), one circuit breaker for User.
Headers of work in the background (docs/events.md, consumer rule 9): X-User-Roles: SERVICE,
X-User-Id = userId of the event, X-Request-Id = requestId of the event.
"""

import asyncio
from dataclasses import dataclass
from time import monotonic

import httpx

from .breaker import CircuitBreaker, CircuitOpen
from .consul import Discovery
from .logs import logger, reason

USER_SERVICE = "user-service"
ATTEMPT_TIMEOUT = 2.0
BACKOFF = (0.2, 0.4)
RETRY_STATUSES = {502, 503, 504}


class UserUnavailable(Exception):
    """User gave no usable answer: the event is tried again later (consumer retries, then DLQ)."""


class PermanentError(Exception):
    """User refused for good (4xx other than 404, 408, 429, or an answer outside the contract):
    trying again gets the same answer, so the event goes to the DLQ at once (docs/events.md, rule 4)."""


@dataclass(frozen=True)
class Recipient:
    email: str
    first_name: str


class _Failure(Exception):
    pass


class UserClient:
    def __init__(self, http: httpx.AsyncClient, discovery: Discovery):
        self.http = http
        self.discovery = discovery
        self.breaker = CircuitBreaker()

    async def recipient(self, user_id: str, request_id: str) -> Recipient | None:
        """None: User answered 404 (no profile), so there is nobody to write to."""
        headers = {"X-User-Roles": "SERVICE", "X-User-Id": user_id, "X-Request-Id": request_id}
        deadline = monotonic() + 8.0
        first = await self.discovery.pick(USER_SERVICE)
        if first is None:
            raise UserUnavailable("no healthy instance of user-service in Consul")
        try:
            response = await self.breaker.call(lambda: self._attempts(f"/users/{user_id}", headers, deadline, first))
        except CircuitOpen:
            raise UserUnavailable("circuit breaker of user-service open") from None
        except _Failure as exc:
            raise UserUnavailable(str(exc)) from None
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            # 400, 401, 403...: a working service refuses, trying again gets the same answer.
            # 408, 429 and 5xx never get here (temporary, counted by the breaker).
            raise PermanentError(f"user-service answered {response.status_code}")
        try:
            data = response.json()
            email, first_name = data["email"], data["firstName"]
            if not isinstance(email, str) or "@" not in email or not isinstance(first_name, str):
                raise ValueError("email or firstName")
        except (ValueError, KeyError, TypeError) as exc:
            logger.error("User answered outside the contract", extra=reason(exc))
            raise PermanentError("user-service answered outside the contract") from None
        return Recipient(email=email, first_name=first_name)

    async def _attempts(self, path: str, headers: dict, deadline: float, first: str) -> httpx.Response:
        last = "deadline exceeded"
        for attempt in range(1 + len(BACKOFF)):
            if attempt:
                pause = BACKOFF[attempt - 1]
                if monotonic() + pause >= deadline:
                    break
                await asyncio.sleep(pause)
            remaining = deadline - monotonic()
            if remaining <= 0:
                break
            base = first if attempt == 0 else await self.discovery.pick(USER_SERVICE)
            if base is None:
                break
            try:
                response = await self.http.get(base + path, headers=headers, timeout=min(ATTEMPT_TIMEOUT, remaining))
            except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                self.discovery.drop(USER_SERVICE, base)
                last = f"no connection ({type(exc).__name__})"
                continue
            except httpx.HTTPError as exc:
                last = type(exc).__name__
                continue
            if response.status_code in RETRY_STATUSES:
                last = f"HTTP {response.status_code}"
                continue
            if response.status_code >= 500 or response.status_code in (408, 429):
                raise _Failure(f"HTTP {response.status_code}")
            return response
        raise _Failure(last)
