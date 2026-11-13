"""In-memory cache with a time limit (TTL), like Caffeine in the lab instructions (topic 2).

The catalog is read far more often than it changes. Every write (POST, PUT, DELETE) clears the whole
cache, so this instance never returns old data after its own change. With several instances each has
its own cache: a change made by another instance is visible here after at most the TTL (60 s by default).
"""

import threading
from collections import OrderedDict
from collections.abc import Callable, Hashable
from time import monotonic
from typing import Any

MISSING = object()


class TtlCache:
    def __init__(self, ttl_seconds: float, max_entries: int = 1000, clock: Callable[[], float] = monotonic):
        self.ttl = ttl_seconds
        self.max_entries = max_entries
        self.clock = clock
        self.entries: OrderedDict[Hashable, tuple[float, Any]] = OrderedDict()
        # Endpoints that touch the database run in a thread pool, so access is guarded.
        self.lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    def get(self, key: Hashable) -> Any:
        with self.lock:
            entry = self.entries.get(key)
            if entry is None or entry[0] <= self.clock():
                self.entries.pop(key, None)
                self.misses += 1
                return MISSING
            self.entries.move_to_end(key)
            self.hits += 1
            return entry[1]

    def put(self, key: Hashable, value: Any) -> None:
        if self.ttl <= 0:
            return
        with self.lock:
            self.entries[key] = (self.clock() + self.ttl, value)
            self.entries.move_to_end(key)
            while len(self.entries) > self.max_entries:
                self.entries.popitem(last=False)  # the least recently used entry

    def get_or_load(self, key: Hashable, load: Callable[[], Any]) -> Any:
        value = self.get(key)
        if value is MISSING:
            value = load()
            self.put(key, value)
        return value

    def clear(self) -> None:
        with self.lock:
            self.entries.clear()

    def stats(self) -> dict:
        with self.lock:
            return {"entries": len(self.entries), "hits": self.hits, "misses": self.misses}
