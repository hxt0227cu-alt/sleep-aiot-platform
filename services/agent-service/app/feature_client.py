import os
from urllib.parse import quote
from uuid import UUID

import httpx


class FeatureServiceUnavailable(RuntimeError):
    pass


class FeatureServiceNotFound(RuntimeError):
    pass


class FeatureServiceAuthorizationError(RuntimeError):
    pass


class FeatureServiceClient:
    def __init__(self, base_url: str, token: str, timeout_seconds: float = 1.5):
        if not token:
            raise FeatureServiceAuthorizationError("feature service credential is not configured")
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout_seconds = timeout_seconds

    @classmethod
    def from_env(cls) -> "FeatureServiceClient":
        return cls(
            os.getenv("FEATURE_SERVICE_URL", "http://feature-service:8101"),
            os.getenv("FEATURE_SERVICE_TOKEN", ""),
            float(os.getenv("FEATURE_SERVICE_TIMEOUT_SECONDS", "1.5")),
        )

    def get_sleep_features(
        self,
        tenant_id: UUID,
        device_id: str,
        window_days: int = 7,
        correlation_id: str | None = None,
    ) -> dict:
        url = f"{self.base_url}/v1/features/sleep/{quote(device_id, safe='')}"
        try:
            response = httpx.get(
                url,
                params={"window_days": window_days},
                headers={
                    "authorization": f"Bearer {self.token}",
                    "x-tenant-id": str(tenant_id),
                    **({"x-trace-id": correlation_id} if correlation_id else {}),
                },
                timeout=self.timeout_seconds,
            )
        except (httpx.TimeoutException, httpx.NetworkError) as error:
            raise FeatureServiceUnavailable("feature service unavailable") from error
        if response.status_code == 404:
            raise FeatureServiceNotFound("sleep features not found")
        if response.status_code in {401, 403}:
            raise FeatureServiceAuthorizationError("feature service rejected the caller")
        if response.status_code == 429 or response.status_code >= 500:
            raise FeatureServiceUnavailable("feature service unavailable")
        try:
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise FeatureServiceUnavailable("invalid feature service response") from error
        if payload.get("tenantId") != str(tenant_id) or payload.get("deviceId") != device_id:
            raise FeatureServiceAuthorizationError("feature service response identity mismatch")
        return payload
