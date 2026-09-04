import os
from uuid import UUID

import httpx


class KnowledgeServiceUnavailable(RuntimeError):
    pass


class KnowledgeServiceAuthorizationError(RuntimeError):
    pass


class KnowledgeServiceClient:
    def __init__(self, base_url: str, token: str, timeout_seconds: float = 2.0):
        if not token:
            raise KnowledgeServiceAuthorizationError(
                "knowledge service credential is not configured"
            )
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.timeout_seconds = timeout_seconds

    @classmethod
    def from_env(cls) -> "KnowledgeServiceClient":
        return cls(
            os.getenv("KNOWLEDGE_SERVICE_URL", "http://backend-api:3000/api"),
            os.getenv("KNOWLEDGE_SERVICE_TOKEN", ""),
            float(os.getenv("KNOWLEDGE_SERVICE_TIMEOUT_SECONDS", "2.0")),
        )

    def search(self, tenant_id: UUID, trace_id: str, query: str, top_k: int = 2) -> dict:
        try:
            response = httpx.post(
                f"{self.base_url}/internal/knowledge/search",
                json={"query": query, "topK": top_k},
                headers={
                    "authorization": f"Bearer {self.token}",
                    "x-tenant-id": str(tenant_id),
                    "x-trace-id": trace_id,
                },
                timeout=self.timeout_seconds,
            )
        except (httpx.TimeoutException, httpx.NetworkError) as error:
            raise KnowledgeServiceUnavailable("knowledge service unavailable") from error
        if response.status_code in {401, 403}:
            raise KnowledgeServiceAuthorizationError(
                "knowledge service rejected the caller"
            )
        if response.status_code == 429 or response.status_code >= 500:
            raise KnowledgeServiceUnavailable("knowledge service unavailable")
        try:
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise KnowledgeServiceUnavailable(
                "invalid knowledge service response"
            ) from error
        if payload.get("tenantId") != str(tenant_id):
            raise KnowledgeServiceAuthorizationError(
                "knowledge service response tenant mismatch"
            )
        chunks = payload.get("chunks")
        if not isinstance(chunks, list):
            raise KnowledgeServiceUnavailable("invalid knowledge service response")
        return payload
