from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


def to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class SleepFeatureResponse(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)

    tenant_id: UUID
    device_id: str = Field(min_length=1, max_length=128)
    window_days: int = Field(ge=1, le=30)
    window_start: datetime
    window_end: datetime
    telemetry_events: int = Field(gt=0)
    observed_hours: int = Field(gt=0)
    avg_heart_rate: float | None = None
    avg_breathing_rate: float | None = None
    total_body_movement: float
    deep_sleep_ratio: float = Field(ge=0, le=1)
    awake_ratio: float = Field(ge=0, le=1)
    p95_ingest_delay_ms: float
    source_max_occurred_at: datetime
    refreshed_at: datetime
    source: str = "ads_agent_device_sleep_features"
    cache_hit: bool = False
