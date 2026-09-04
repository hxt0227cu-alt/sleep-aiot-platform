import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from uuid import UUID

from fastapi import FastAPI, Header, HTTPException, Path, Query, Request, Response, status
from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram, generate_latest

from .cache import FeatureCache
from .config import Settings
from .models import SleepFeatureResponse
from .repository import ClickHouseFeatureRepository, FeatureRepository, FeatureRepositoryUnavailable


def create_app(settings: Settings | None = None, repository: FeatureRepository | None = None) -> FastAPI:
    resolved = settings or Settings.from_env()
    repo = repository or ClickHouseFeatureRepository(
        resolved.clickhouse_url,
        resolved.clickhouse_user,
        resolved.clickhouse_password,
        resolved.query_timeout_seconds,
    )
    cache = FeatureCache(resolved.cache_ttl_seconds, resolved.cache_max_entries)
    registry = CollectorRegistry()
    requests = Counter("sleep_feature_requests_total", "Feature requests by outcome.", ["outcome"], registry=registry)
    cache_requests = Counter("sleep_feature_cache_requests_total", "Feature cache requests.", ["result"], registry=registry)
    query_seconds = Histogram("sleep_feature_query_seconds", "ClickHouse feature query duration.", registry=registry)
    feature_age = Gauge("sleep_feature_age_seconds", "Age of the latest served feature snapshot.", registry=registry)
    cache_entries = Gauge("sleep_feature_cache_entries", "Current feature cache entries.", registry=registry)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        await repo.close()

    app = FastAPI(title="Sleep Feature Service", version="0.1.0", lifespan=lifespan)

    def authorize(authorization: str, tenant_id: UUID) -> UUID:
        if not resolved.service_token:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="feature service authentication is not configured")
        expected = f"Bearer {resolved.service_token}"
        if not secrets.compare_digest(authorization, expected):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid service credential")
        return tenant_id

    @app.get("/health/live")
    async def live() -> dict[str, str]:
        return {"status": "ok", "service": "feature-service"}

    @app.get("/health/ready")
    async def ready() -> dict[str, str]:
        if not resolved.service_token or not await repo.ready():
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="feature service is not ready")
        return {"status": "ready", "repository": "clickhouse", "cacheEntries": str(cache.size())}

    @app.get("/v1/features/sleep/{device_id}", response_model=SleepFeatureResponse)
    async def sleep_features(
        device_id: str = Path(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$"),
        window_days: int = Query(default=7, ge=7, le=7),
        authorization: str = Header(default=""),
        x_tenant_id: UUID = Header(),
    ) -> SleepFeatureResponse:
        tenant_id = authorize(authorization, x_tenant_id)
        key = (str(tenant_id), device_id, window_days)
        cached = cache.get(key)
        if cached is not None:
            cache_requests.labels("hit").inc()
            requests.labels("success").inc()
            cache_entries.set(cache.size())
            return cached
        cache_requests.labels("miss").inc()
        try:
            result = await repo.get_sleep_features(tenant_id, device_id, window_days)
            query_seconds.observe(getattr(repo, "last_query_seconds", 0.0))
        except FeatureRepositoryUnavailable as error:
            requests.labels("repository_unavailable").inc()
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="feature repository unavailable") from error
        if result is None:
            requests.labels("not_found").inc()
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="features not found")
        refreshed_at = result.refreshed_at
        if refreshed_at.tzinfo is None:
            refreshed_at = refreshed_at.replace(tzinfo=timezone.utc)
        age_seconds = max(0.0, (datetime.now(timezone.utc) - refreshed_at).total_seconds())
        feature_age.set(age_seconds)
        if age_seconds > resolved.max_staleness_seconds:
            requests.labels("stale").inc()
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="feature snapshot is stale")
        cache.put(key, result)
        cache_entries.set(cache.size())
        requests.labels("success").inc()
        return result

    @app.get("/metrics")
    async def metrics() -> Response:
        return Response(generate_latest(registry), media_type="text/plain; version=0.0.4")

    return app


app = create_app()
