"""Circuit breaker (wyłącznik) according to D2.

Last 10 calls; with 10 results and at least 50 % failures the breaker opens for 30 s and calls get the
fallback at once. After 30 s exactly one trial call goes through: success closes the breaker, failure
opens it for another 30 s. The lock guards only the state, never the call itself (D2).
Based on services/cart-service/app/circuit_breaker.py.
"""

import asyncio
from collections import deque
from collections.abc import Awaitable, Callable
from time import monotonic
from typing import TypeVar

T = TypeVar("T")

WINDOW = 10
FAILURE_RATIO = 0.5
OPEN_SECONDS = 30.0


class CircuitOpen(Exception):
    """The breaker is open: no call was made."""


class CircuitBreaker:
    def __init__(self, clock: Callable[[], float] = monotonic, open_seconds: float = OPEN_SECONDS):
        self.clock = clock
        self.open_seconds = open_seconds
        self.history: deque[bool] = deque(maxlen=WINDOW)
        self.opened_at: float | None = None
        self.probe_running = False
        self.generation = 0
        self.lock = asyncio.Lock()

    @property
    def state(self) -> str:
        if self.opened_at is None:
            return "CLOSED"
        return "HALF_OPEN" if self.clock() - self.opened_at >= self.open_seconds else "OPEN"

    async def call(self, operation: Callable[[], Awaitable[T]]) -> T:
        """Runs operation(). An exception from it counts as a failure; a returned value as a success.
        The operation decides what is a failure (D2: no connection, timeout, 5xx, 408, 429)."""
        async with self.lock:
            is_probe = self.opened_at is not None
            if is_probe:
                if self.clock() - self.opened_at < self.open_seconds or self.probe_running:
                    raise CircuitOpen()
                self.probe_running = True
            generation = self.generation
        try:
            result = await operation()
        except BaseException:
            # Also a cancelled trial call must not block the half-open state forever.
            await self._finish(False, is_probe, generation)
            raise
        await self._finish(True, is_probe, generation)
        return result

    async def _finish(self, success: bool, is_probe: bool, generation: int) -> None:
        async with self.lock:
            if generation != self.generation:
                return  # a result of an older call does not change the new state
            if is_probe:
                self.probe_running = False
                self.generation += 1
                self.history.clear()
                self.opened_at = None if success else self.clock()
                return
            self.history.append(success)
            failures = self.history.count(False)
            if len(self.history) == WINDOW and failures >= FAILURE_RATIO * WINDOW:
                self.opened_at = self.clock()
                self.generation += 1
