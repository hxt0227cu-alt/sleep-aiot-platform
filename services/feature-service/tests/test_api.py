from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models import SleepFeatureResponse


TENANT_A = UUID("11111111-1111-4111-8111-111111111111")
TENANT_B = UUID("22222222-2222-4222-8222-222222222222")


class FakeRepository:
    def __init__(self, values=None, ready=True):
        self.values = values or {}
        self.is_ready = ready
        self.calls = []
        self.last_query_seconds = 0.001

    async def ready(self):
        return self.is_ready

    async def get_sleep_features(self, tenant_id, device_id, window_days):
        self.calls.append((tenant_id, device_id, window_days))
        return self.values.get((tenant_id, device_id, window_days))

    async def close(self):
        return None


def feature(tenant_id, device_id, *, age_seconds=1, avg_heart_rate=68):
    now = datetime.now(timezone.utc)
    return SleepFeatureResponse(
        tenant_id=tenant_id,
        device_id=device_id,
        window_days=7,
        window_start=now - timedelta(days=7),
        window_end=now,
        telemetry_events=100,
        observed_hours=10,
        avg_heart_rate=avg_heart_rate,
        avg_breathing_rate=14,
        total_body_movement=12,
        deep_sleep_ratio=0.22,
        awake_ratio=0.08,
        p95_ingest_delay_ms=120,
        source_max_occurred_at=now - timedelta(minutes=1),
        refreshed_at=now - timedelta(seconds=age_seconds),
    )


def client(repository, **settings):
    config = Settings(service_token="test-token", **settings)
    return TestClient(create_app(config, repository))


def headers(tenant_id, token="test-token"):
    return {"authorization": f"Bearer {token}", "x-tenant-id": str(tenant_id)}


def test_requires_internal_service_credential():
    repository = FakeRepository()
    with client(repository) as api:
        missing = api.get("/v1/features/sleep/device-1", headers={"x-tenant-id": str(TENANT_A)})
        wrong = api.get("/v1/features/sleep/device-1", headers=headers(TENANT_A, "wrong"))
    assert missing.status_code == 401
    assert wrong.status_code == 401
    assert repository.calls == []


def test_query_and_cache_are_tenant_isolated():
    repository = FakeRepository({
        (TENANT_A, "shared-device", 7): feature(TENANT_A, "shared-device", avg_heart_rate=60),
        (TENANT_B, "shared-device", 7): feature(TENANT_B, "shared-device", avg_heart_rate=80),
    })
    with client(repository) as api:
        first_a = api.get("/v1/features/sleep/shared-device", headers=headers(TENANT_A))
        first_b = api.get("/v1/features/sleep/shared-device", headers=headers(TENANT_B))
        cached_a = api.get("/v1/features/sleep/shared-device", headers=headers(TENANT_A))
        metrics = api.get("/metrics")
    assert first_a.json()["avgHeartRate"] == 60
    assert first_b.json()["avgHeartRate"] == 80
    assert first_a.json()["cacheHit"] is False
    assert cached_a.json()["cacheHit"] is True
    assert repository.calls == [(TENANT_A, "shared-device", 7), (TENANT_B, "shared-device", 7)]
    assert 'sleep_feature_cache_requests_total{result="hit"} 1.0' in metrics.text


def test_cross_tenant_lookup_is_indistinguishable_from_missing_data():
    repository = FakeRepository({(TENANT_A, "device-a", 7): feature(TENANT_A, "device-a")})
    with client(repository) as api:
        response = api.get("/v1/features/sleep/device-a", headers=headers(TENANT_B))
    assert response.status_code == 404
    assert response.json() == {"detail": "features not found"}
    assert repository.calls == [(TENANT_B, "device-a", 7)]


def test_stale_features_fail_closed_and_are_not_cached():
    repository = FakeRepository({(TENANT_A, "device-a", 7): feature(TENANT_A, "device-a", age_seconds=61)})
    with client(repository, max_staleness_seconds=60) as api:
        first = api.get("/v1/features/sleep/device-a", headers=headers(TENANT_A))
        second = api.get("/v1/features/sleep/device-a", headers=headers(TENANT_A))
    assert first.status_code == 503
    assert second.status_code == 503
    assert len(repository.calls) == 2


def test_readiness_requires_repository_and_auth_configuration():
    with client(FakeRepository(ready=False)) as api:
        assert api.get("/health/live").status_code == 200
        assert api.get("/health/ready").status_code == 503
