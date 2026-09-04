import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    service_token: str
    clickhouse_url: str = "http://clickhouse:8123"
    clickhouse_user: str = "sleep"
    clickhouse_password: str = ""
    query_timeout_seconds: float = 2.0
    cache_ttl_seconds: float = 30.0
    cache_max_entries: int = 10_000
    max_staleness_seconds: float = 3_600.0

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            service_token=os.getenv("FEATURE_SERVICE_TOKEN", ""),
            clickhouse_url=os.getenv("CLICKHOUSE_URL", "http://clickhouse:8123"),
            clickhouse_user=os.getenv("CLICKHOUSE_USER", "sleep"),
            clickhouse_password=os.getenv("CLICKHOUSE_PASSWORD", ""),
            query_timeout_seconds=float(os.getenv("FEATURE_QUERY_TIMEOUT_SECONDS", "2")),
            cache_ttl_seconds=float(os.getenv("FEATURE_CACHE_TTL_SECONDS", "30")),
            cache_max_entries=int(os.getenv("FEATURE_CACHE_MAX_ENTRIES", "10000")),
            max_staleness_seconds=float(os.getenv("FEATURE_MAX_STALENESS_SECONDS", "3600")),
        )
