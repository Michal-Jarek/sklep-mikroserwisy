"""Mały wyłącznik (circuit breaker) według D2: ostatnie 10 wyników, co najmniej 50 % awarii → otwarty na 30 s.

Po 30 s przechodzi jedno wywołanie próbne (stan półotwarty): sukces zamyka wyłącznik, awaria otwiera go na kolejne 30 s.
Endpointy Review są synchroniczne (pula wątków), więc stan chroni blokada wątków - tylko na czas zmiany stanu,
nigdy na czas samego wywołania. Zegar można podmienić w testach (bez czekania 30 s).

Użycie: ticket = breaker.before() (CircuitOpen, gdy otwarty) → wywołanie → breaker.after(ticket, wynik), gdzie wynik to
SUCCESS, FAILURE albo NOT_COUNTED (np. 2xx niezgodne z kontraktem - nie liczy się do okna).
"""
import threading
from collections import deque
from dataclasses import dataclass
from time import monotonic
from typing import Callable

WINDOW = 10
FAILURE_RATIO = 0.5
COOLDOWN = 30.0

SUCCESS = "success"
FAILURE = "failure"
NOT_COUNTED = "not_counted"


class CircuitOpen(Exception):
    """Wyłącznik otwarty: wywołanie nie zostało wykonane."""


@dataclass(frozen=True)
class Ticket:
    is_probe: bool
    generation: int


class CircuitBreaker:
    def __init__(self, clock: Callable[[], float] = monotonic, cooldown: float = COOLDOWN):
        self._clock = clock
        self._cooldown = cooldown
        self._history: deque[bool] = deque(maxlen=WINDOW)  # True = awaria
        self._opened_at: float | None = None
        self._probe_running = False
        self._generation = 0
        self._lock = threading.Lock()

    @property
    def is_open(self) -> bool:
        with self._lock:
            return self._opened_at is not None

    def before(self) -> Ticket:
        with self._lock:
            is_probe = self._opened_at is not None
            if is_probe:
                if self._clock() - self._opened_at < self._cooldown or self._probe_running:
                    raise CircuitOpen()
                self._probe_running = True
            return Ticket(is_probe, self._generation)

    def after(self, ticket: Ticket, outcome: str) -> None:
        with self._lock:
            if ticket.generation != self._generation:
                return  # wynik starszego wywołania nie zmienia wyłącznika, który w międzyczasie zmienił stan
            if ticket.is_probe:
                # próba, na którą usługa odpowiedziała (także NOT_COUNTED), zamyka wyłącznik
                self._probe_running = False
                self._generation += 1
                self._history.clear()
                self._opened_at = self._clock() if outcome == FAILURE else None
                return
            if outcome == NOT_COUNTED:
                return
            self._history.append(outcome == FAILURE)
            if len(self._history) == WINDOW and self._history.count(True) >= WINDOW * FAILURE_RATIO:
                self._opened_at = self._clock()
                self._generation += 1
