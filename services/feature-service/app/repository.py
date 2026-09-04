from time import perf_counter
from typing import Protocol
from uuid import UUID

import httpx

from .models import SleepFeatureResponse


class FeatureRepositoryUnavailable(RuntimeError):
    pass


class FeatureRepository(Protocol):
    async def ready(self) -> bool: ...

    async def get_sleep_features(
        self, tenant_id: UUID, device_id: str, window_days: int
    ) -> SleepFeatureResponse | None: ...

    async def close(self) -> None: ...


class ClickHouseFeatureRepository:
    QUERY = """
      SELECT
        tenant_id,
        device_id,
        window_days,
        window_start,
        window_end,
        telemetry_events,
        observed_hours,
        avg_heart_rate,
        avg_breathing_rate,
        total_body_movement,
        deep_sleep_ratio,
        awake_ratio,
        p95_ingest_delay_ms,
        source_max_occurred_at,
        refreshed_at
      FROM ads.ads_agent_device_sleep_features
      WHERE tenant_id = {tenant_id:String}
        AND device_id = {device_id:String}
        AND window_days = {window_days:UInt8}
      LIMIT 1
      FORMAT JSON
    """

    def __init__(
        self,
        base_url: str,
        user: str,
        password: str,
        timeout_seconds: float,
        client: httpx.AsyncClient | None = None,
    ):
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            base_url=base_url,
            auth=(user, password),
            timeout=httpx.Timeout(timeout_seconds),
        )
        self.last_query_seconds = 0.0

    async def ready(self) -> bool:
        try:
            response = await self._client.post("/", content="SELECT 1")
            return response.is_success
        except httpx.HTTPError:
            return False

    async def get_sleep_features(
        self, tenant_id: UUID, device_id: str, window_days: int
    ) -> SleepFeatureResponse | None:
        started = perf_counter()
        try:
            response = await self._client.post(
                "/",
                params={
                    "param_tenant_id": str(tenant_id),
                    "param_device_id": device_id,
                    "param_window_days": str(window_days),
                },
                content=self.QUERY,
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise FeatureRepositoryUnavailable("feature repository query failed") from error
        finally:
            self.last_query_seconds = perf_counter() - started
        if payload.get("rows") != 1:
            return None
        return SleepFeatureResponse.model_validate(payload["data"][0])

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()
