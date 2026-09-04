from collections import OrderedDict
from dataclasses import dataclass
from time import monotonic

from .models import SleepFeatureResponse


@dataclass
class CacheEntry:
    expires_at: float
    value: SleepFeatureResponse


class FeatureCache:
    def __init__(self, ttl_seconds: float, max_entries: int):
        self.ttl_seconds = ttl_seconds
        self.max_entries = max_entries
        self._entries: OrderedDict[tuple[str, str, int], CacheEntry] = OrderedDict()

    def get(self, key: tuple[str, str, int]) -> SleepFeatureResponse | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        if entry.expires_at <= monotonic():
            self._entries.pop(key, None)
            return None
        self._entries.move_to_end(key)
        return entry.value.model_copy(update={"cache_hit": True})

    def put(self, key: tuple[str, str, int], value: SleepFeatureResponse) -> None:
        self._entries[key] = CacheEntry(monotonic() + self.ttl_seconds, value)
        self._entries.move_to_end(key)
        while len(self._entries) > self.max_entries:
            self._entries.popitem(last=False)

    def size(self) -> int:
        return len(self._entries)
