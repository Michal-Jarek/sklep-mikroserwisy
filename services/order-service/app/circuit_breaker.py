"""Small circuit breaker (D2): last 10 results, at least 50 % failures, open for 30 s.

After the break only one probe passes (half-open). The clock can be replaced in tests, so the return to the
closed state is checked without waiting 30 seconds. The lock covers only state changes, never the call itself.
"""
import asyncio
from collections import deque
from time import monotonic
from typing import Awaitable, Callable, TypeVar

T = TypeVar("T")


class CircuitOpen(Exception):
    pass


class CircuitBreaker:
    def __init__(self, clock: Callable[[], float] = monotonic, cooldown: float = 30):
        self.clock = clock
        self.cooldown = cooldown
        self.history: deque[bool] = deque(maxlen=10)
        self.opened_at: float | None = None
        self.probe = False
        self.generation = 0
        self.lock = asyncio.Lock()

    async def call(self, operation: Callable[[], Awaitable[T]]) -> T:
        async with self.lock:
            is_probe = self.opened_at is not None
            if is_probe:
                if self.clock() - self.opened_at < self.cooldown or self.probe:
                    raise CircuitOpen()
                self.probe = True
            generation = self.generation
        try:
            result = await operation()
        except BaseException:
            # A cancelled probe must not block half-open forever either.
            await self.finish(False, is_probe, generation)
            raise
        await self.finish(True, is_probe, generation)
        return result

    async def finish(self, success: bool, is_probe: bool, generation: int) -> None:
        async with self.lock:
            if generation != self.generation:
                return  # A result of an older call does not close a circuit that opened meanwhile.
            if is_probe:
                self.probe = False
                self.generation += 1
                self.history.clear()
                self.opened_at = None if success else self.clock()
            else:
                self.history.append(success)
                if len(self.history) == 10 and self.history.count(False) >= 5:
                    self.opened_at = self.clock()
                    self.generation += 1
