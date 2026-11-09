"""Prosty circuit breaker: ostatnie 10 wyników, 50% błędów, przerwa 30 s.

Po przerwie przechodzi tylko jedna próba (half-open). Zegar można podmienić
w testach, więc nie trzeba czekać 30 sekund, aby sprawdzić powrót do działania.
"""
import asyncio
from collections import deque
from time import monotonic
from typing import Awaitable, Callable, TypeVar

T = TypeVar("T")

class CircuitOpen(Exception):
    pass

class ResourceMissing(Exception):
    """404 jest wynikiem biznesowym, nie awarią połączenia."""

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
        except ResourceMissing:
            await self.finish(True, is_probe, generation)
            raise
        except BaseException:
            # Także anulowana próba nie może na zawsze zablokować half-open.
            await self.finish(False, is_probe, generation)
            raise
        await self.finish(True, is_probe, generation)
        return result

    async def finish(self, success: bool, is_probe: bool, generation: int) -> None:
        async with self.lock:
            if generation != self.generation:
                return  # Wynik starszego żądania nie zamknie już otwartego obwodu.
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
