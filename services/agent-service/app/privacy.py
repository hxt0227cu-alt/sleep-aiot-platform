import json
from datetime import datetime, timedelta, timezone
from typing import Any


PROHIBITED_HEALTH_FIELDS = {
    "raw_data",
    "rawData",
    "radar_samples",
    "heart_rate_series",
    "breathing_rate_series",
    "sleep_stage_series",
}


def validate_structured_agent_data(value: dict[str, Any], *, maximum_bytes: int = 16384) -> None:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > maximum_bytes:
        raise ValueError(f"structured agent data must not exceed {maximum_bytes} bytes")
    prohibited = sorted(_find_prohibited_fields(value))
    if prohibited:
        raise ValueError(f"raw health fields are not accepted: {', '.join(prohibited)}")


def validate_expiry(expires_at: datetime) -> None:
    now = datetime.now(timezone.utc)
    normalized = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=timezone.utc)
    if normalized <= now:
        raise ValueError("expires_at must be in the future")
    if normalized > now + timedelta(days=366):
        raise ValueError("expires_at must not exceed 366 days")


def _find_prohibited_fields(value: Any) -> set[str]:
    if isinstance(value, dict):
        found = PROHIBITED_HEALTH_FIELDS.intersection(value)
        for nested in value.values():
            found.update(_find_prohibited_fields(nested))
        return found
    if isinstance(value, list):
        found: set[str] = set()
        for nested in value:
            found.update(_find_prohibited_fields(nested))
        return found
    return set()
