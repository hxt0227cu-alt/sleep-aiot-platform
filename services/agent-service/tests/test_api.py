from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi.testclient import TestClient

from app.capabilities import snapshot_capabilities
from app.main import app, runs, store
from app.models import AgentRun, AgentType, RunStatus


def test_metrics_are_real_prometheus_metrics():
    with TestClient(app) as client:
        response = client.get("/metrics")
    assert response.status_code == 200
    assert "sleep_agent_queue_depth" in response.text
    assert "sleep_agent_tool_failures_total" in response.text
    assert "sleep_agent_model_calls_total" in response.text
    assert "sleep_agent_model_tokens_total" in response.text
    assert "placeholder" not in response.text.lower()


def test_run_lookup_enforces_tenant_boundary():
    tenant_id = uuid4()
    with TestClient(app) as client:
        created = client.post("/v1/runs", json={
            "tenant_id": str(tenant_id), "user_id": str(uuid4()), "agent_type": "knowledge_answer",
            "input": {"question": "如何保持固定作息"}, "workflow_version": "test-v1",
        })
        assert created.status_code == 202
        run_id = created.json()["run_id"]
        forbidden = client.get(f"/v1/runs/{run_id}", headers={"x-tenant-id": str(uuid4())})
        allowed = client.get(f"/v1/runs/{run_id}", headers={"x-tenant-id": str(tenant_id)})
    assert forbidden.status_code == 404
    assert allowed.status_code == 200
    runs.pop(next(key for key in runs if str(key) == run_id), None)


def test_trace_view_is_tenant_scoped_and_metadata_only():
    tenant_id = uuid4()
    run = AgentRun(
        tenant_id=tenant_id,
        user_id=uuid4(),
        agent_type=AgentType.SLEEP_REPORT,
        workflow_version="workflow.interview.v1",
        correlation_id="interview-trace-42",
        input={"question": "private prompt", "device_id": "private-device"},
        status=RunStatus.SUCCEEDED,
        attempts=1,
        trace=[
            {
                "at": datetime.now(timezone.utc).isoformat(),
                "tool": "get_sleep_features",
                "arguments": {"device_id": "private-device"},
                "result": {
                    "source": "simulated",
                    "sleepScore": 88,
                    "heartRate": 61,
                },
            }
        ],
        output={
            "evidence": "simulated",
            "businessResult": {"summary": "private model output"},
            "model": {
                "provider": "openai_compatible",
                "model": "interview-model",
                "reason": "generated",
                "promptTokens": 120,
                "completionTokens": 30,
            },
        },
    )
    run.capabilities = snapshot_capabilities(run)
    store.save(run)
    runs[run.run_id] = run

    with TestClient(app) as client:
        denied = client.get(
            f"/v1/runs/{run.run_id}/trace",
            headers={"x-tenant-id": str(uuid4())},
        )
        allowed = client.get(
            f"/v1/runs/{run.run_id}/trace",
            headers={"x-tenant-id": str(tenant_id)},
        )

    assert denied.status_code == 404
    assert allowed.status_code == 200
    payload = allowed.json()
    assert payload["correlation_id"] == "interview-trace-42"
    assert payload["privacy_mode"] == "metadata_only"
    assert payload["capability_versions"]["policy_version"] == "policy.v2"
    assert payload["tool_calls"] == [
        {
            "at": payload["tool_calls"][0]["at"],
            "tool": "get_sleep_features",
            "outcome": "succeeded",
            "source": "simulated",
            "replayed": False,
        }
    ]
    assert payload["model_usage"]["total_tokens"] == 150
    serialized = allowed.text
    for sensitive in (
        "private prompt",
        "private-device",
        "private model output",
        "sleepScore",
        "heartRate",
        "arguments",
        "result",
    ):
        assert sensitive not in serialized
    runs.pop(run.run_id, None)


def test_trace_view_tolerates_malformed_legacy_metadata():
    tenant_id = uuid4()
    run = AgentRun(
        tenant_id=tenant_id,
        user_id=uuid4(),
        agent_type=AgentType.SLEEP_REPORT,
        workflow_version="workflow.legacy.v1",
        input={},
        status=RunStatus.FAILED,
        trace=[
            {
                "at": "not-a-timestamp",
                "tool": "get_sleep_features",
                "result": {"source": "private-device-id"},
            },
            {
                "at": datetime.now(timezone.utc).isoformat(),
                "tool": "search_knowledge",
                "result": {"source": "untrusted private prompt"},
            },
        ],
        output={
            "model": {
                "provider": "deterministic_fallback",
                "model": "fallback",
                "reason": "provider_error",
                "promptTokens": "not-a-number",
                "completionTokens": -1,
            }
        },
    )
    store.save(run)
    runs[run.run_id] = run

    with TestClient(app) as client:
        response = client.get(
            f"/v1/runs/{run.run_id}/trace",
            headers={"x-tenant-id": str(tenant_id)},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["tool_calls"] == [
        {
            "at": payload["tool_calls"][0]["at"],
            "tool": "search_knowledge",
            "outcome": "succeeded",
            "source": None,
            "replayed": False,
        }
    ]
    assert payload["model_usage"]["total_tokens"] == 0
    assert "private" not in response.text
    runs.pop(run.run_id, None)


def test_api_accepts_four_business_agent_contracts():
    cases = [
        (
            "sleep_report",
            {"device_id": "sim-1", "allowed_device_ids": ["sim-1"]},
        ),
        (
            "sleep_improvement",
            {
                "device_id": "sim-1",
                "allowed_device_ids": ["sim-1"],
                "window_days": 28,
            },
        ),
        ("voice_companion", {"transcript": "今晚有点累"}),
        ("algorithm_optimization", {"cohort_id": "employee-opt-in"}),
    ]
    tenant_id = uuid4()
    with TestClient(app) as client:
        for agent_type, input_data in cases:
            response = client.post(
                "/v1/runs",
                json={
                    "tenant_id": str(tenant_id),
                    "user_id": str(uuid4()),
                    "agent_type": agent_type,
                    "input": input_data,
                    "workflow_version": "business-v1",
                },
            )
            assert response.status_code == 202
            run_id = response.json()["run_id"]
            runs.pop(next(key for key in runs if str(key) == run_id), None)


def test_api_rejects_raw_health_data_before_run_persistence():
    with TestClient(app) as client:
        run_ids_before = set(runs)
        response = client.post(
            "/v1/runs",
            json={
                "tenant_id": str(uuid4()),
                "user_id": str(uuid4()),
                "agent_type": "sleep_report",
                "input": {
                    "device_id": "sim-1",
                    "allowed_device_ids": ["sim-1"],
                    "payload": {"radar_samples": [1, 2, 3]},
                },
            },
        )

        assert response.status_code == 422
        assert set(runs) == run_ids_before


def test_preference_memory_is_tenant_scoped_and_revocable():
    tenant_id = uuid4()
    other_tenant_id = uuid4()
    user_id = uuid4()
    headers = {"x-tenant-id": str(tenant_id), "x-user-id": str(user_id)}
    payload = {
        "tenant_id": str(tenant_id),
        "user_id": str(user_id),
        "preference_key": "sleep.bedtime_window",
        "value": {"start": "22:30", "end": "23:00"},
        "source": "user_setting",
        "purpose": "personalize_sleep_plan",
        "consent_id": "consent-v1",
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(),
    }
    with TestClient(app) as client:
        created = client.post("/v1/memories/preferences", json=payload, headers=headers)
        assert created.status_code == 201
        memory_id = created.json()["memory_id"]

        isolated = client.get(
            "/v1/memories/preferences",
            headers={"x-tenant-id": str(other_tenant_id), "x-user-id": str(user_id)},
        )
        assert isolated.status_code == 200
        assert isolated.json() == []

        wrong_delete = client.delete(
            f"/v1/memories/preferences/{memory_id}",
            headers={"x-tenant-id": str(other_tenant_id), "x-user-id": str(user_id)},
        )
        assert wrong_delete.status_code == 404
        deleted = client.delete(
            f"/v1/memories/preferences/{memory_id}", headers=headers
        )
        assert deleted.status_code == 204
        assert client.get("/v1/memories/preferences", headers=headers).json() == []
        audit = store.audit_events(tenant_id, user_id)
        assert audit[-1]["action"] == "delete"
        assert audit[-1]["resource_type"] == "preference_memory"
        assert "value" not in audit[-1]


def test_memory_rejects_raw_health_series():
    tenant_id = uuid4()
    user_id = uuid4()
    with TestClient(app) as client:
        response = client.post(
            "/v1/memories/preferences",
            headers={"x-tenant-id": str(tenant_id), "x-user-id": str(user_id)},
            json={
                "tenant_id": str(tenant_id),
                "user_id": str(user_id),
                "preference_key": "sleep.raw",
                "value": {"heart_rate_series": [60, 61]},
                "source": "device",
                "purpose": "personalize_sleep_plan",
                "consent_id": "consent-v1",
                "expires_at": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
            },
        )
    assert response.status_code == 422


def test_workspace_artifact_is_tenant_scoped():
    tenant_id = uuid4()
    other_tenant_id = uuid4()
    user_id = uuid4()
    payload = {
        "tenant_id": str(tenant_id),
        "user_id": str(user_id),
        "session_id": str(uuid4()),
        "artifact_key": "plans/nightly-plan.json",
        "artifact_type": "plan",
        "content": {"actions": ["dim_light"]},
        "source": "agent_plan",
        "purpose": "approved_device_plan",
        "expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
    }
    headers = {"x-tenant-id": str(tenant_id), "x-user-id": str(user_id)}
    with TestClient(app) as client:
        created = client.post("/v1/workspaces/artifacts", json=payload, headers=headers)
        assert created.status_code == 201
        artifact_id = created.json()["artifact_id"]
        denied = client.get(
            f"/v1/workspaces/artifacts/{artifact_id}",
            headers={"x-tenant-id": str(other_tenant_id)},
        )
        assert denied.status_code == 404
        allowed = client.get(
            f"/v1/workspaces/artifacts/{artifact_id}",
            headers={"x-tenant-id": str(tenant_id)},
        )
        assert allowed.status_code == 200
