from uuid import uuid4

import pytest

from app.models import AgentType, AgentRun
from app.graph import execute_bounded_graph
from app.policy import allowed_tools, validate_tool_call
from app.store import RunStore
from app.tools import execute_tool
from app.evaluation import build_cases
from app.feature_client import FeatureServiceAuthorizationError, FeatureServiceUnavailable
from app.knowledge_client import KnowledgeServiceUnavailable


def test_ops_agent_is_read_only():
    assert "query_prometheus" in allowed_tools(AgentType.OPS_DIAGNOSIS)
    assert "set_light" not in allowed_tools(AgentType.OPS_DIAGNOSIS)


def test_device_write_requires_approval():
    with pytest.raises(PermissionError):
        validate_tool_call(AgentType.DEVICE_CONTROL, "set_light", {"brightness": 40})

    validate_tool_call(
        AgentType.DEVICE_CONTROL,
        "set_light",
        {"brightness": 40},
        approved=True,
    )


@pytest.mark.asyncio
async def test_device_graph_waits_for_approval():
    run = AgentRun(
        tenant_id=uuid4(),
        user_id=uuid4(),
        agent_type=AgentType.DEVICE_CONTROL,
        workflow_version="v1",
        input={"device_id": "sim-1", "allowed_device_ids": ["sim-1"], "power": True},
    )
    result = await execute_bounded_graph(run)
    assert result.status == "waiting_approval"
    assert "approval_required" in result.steps


@pytest.mark.asyncio
async def test_approved_device_graph_receives_write_tools():
    run = AgentRun(
        tenant_id=uuid4(),
        user_id=uuid4(),
        agent_type=AgentType.DEVICE_CONTROL,
        workflow_version="v1",
        input={"device_id": "sim-1", "allowed_device_ids": ["sim-1"], "power": True},
    )
    result = await execute_bounded_graph(run, approved=True)
    assert result.status == "succeeded"
    assert "set_light" in result.output["allowedTools"]
    assert result.output["toolResults"][0]["result"]["status"] == "acknowledged"
    assert result.output["evidence"] == "simulated"


@pytest.mark.asyncio
async def test_sleep_analysis_executes_real_read_tools():
    run = AgentRun(
        tenant_id=uuid4(),
        user_id=uuid4(),
        agent_type=AgentType.SLEEP_ANALYSIS,
        workflow_version="v1",
        input={"device_id": "sim-2", "allowed_device_ids": ["sim-2"], "question": "深睡少怎么办"},
    )
    result = await execute_bounded_graph(run)
    assert result.status == "succeeded"
    assert [item["tool"] for item in result.output["toolResults"]] == ["get_sleep_features", "search_knowledge"]
    assert result.trace[0]["result"]["source"] == "simulated"


@pytest.mark.asyncio
async def test_simulated_timeout_has_explained_terminal_failure():
    run = AgentRun(
        tenant_id=uuid4(),
        user_id=uuid4(),
        agent_type=AgentType.DEVICE_CONTROL,
        workflow_version="v1",
        input={"device_id": "sim-3", "allowed_device_ids": ["sim-3"], "brightness": 25, "failure_mode": "timeout"},
    )
    result = await execute_bounded_graph(run, approved=True)
    assert result.status == "failed"
    assert result.error == "simulated_device_timeout"
    assert "terminal_failure" in result.steps


def test_cross_device_tool_call_is_rejected():
    run = AgentRun(
        tenant_id=uuid4(), user_id=uuid4(), agent_type=AgentType.DEVICE_CONTROL,
        workflow_version="v1", input={"device_id": "sim-1", "allowed_device_ids": ["sim-1"]},
    )
    with pytest.raises(PermissionError):
        execute_tool(run, "set_light", {"device_id": "sim-foreign", "brightness": 20}, approved=True)


@pytest.mark.asyncio
async def test_sleep_analysis_uses_tenant_bound_feature_service(monkeypatch):
    tenant_id = uuid4()

    class Client:
        def get_sleep_features(self, actual_tenant, device_id, window_days=7, correlation_id=None):
            assert actual_tenant == tenant_id
            assert device_id == "device-real"
            return {
                "tenantId": str(actual_tenant),
                "deviceId": device_id,
                "windowDays": window_days,
                "telemetryEvents": 120,
                "deepSleepRatio": 0.23,
                "source": "ads_agent_device_sleep_features",
            }

    monkeypatch.setenv("FEATURE_PROVIDER", "service")
    monkeypatch.setattr("app.tools.FeatureServiceClient.from_env", lambda: Client())
    run = AgentRun(
        tenant_id=tenant_id,
        user_id=uuid4(),
        agent_type=AgentType.SLEEP_ANALYSIS,
        workflow_version="v1",
        input={"device_id": "device-real", "allowed_device_ids": ["device-real"], "question": "sleep"},
    )
    result = await execute_bounded_graph(run)
    assert result.status == "succeeded"
    assert result.output["toolResults"][0]["result"]["deepSleepRatio"] == 0.23
    assert result.output["evidence"] == "software"


@pytest.mark.asyncio
async def test_knowledge_search_uses_tenant_and_correlation_id(monkeypatch):
    tenant_id = uuid4()

    class Client:
        def search(self, actual_tenant, trace_id, query, top_k=2):
            assert actual_tenant == tenant_id
            assert trace_id == "request-42"
            return {
                "tenantId": str(actual_tenant),
                "chunks": [{
                    "chunkId": "chunk-1",
                    "content": "固定作息有助于睡眠连续性。",
                    "title": "睡眠指南",
                    "sourcePath": "guide.md",
                    "section": "作息",
                    "similarity": 0.91,
                }],
            }

    monkeypatch.setenv("KNOWLEDGE_PROVIDER", "service")
    monkeypatch.setattr("app.tools.KnowledgeServiceClient.from_env", lambda: Client())
    run = AgentRun(
        tenant_id=tenant_id,
        user_id=uuid4(),
        agent_type=AgentType.KNOWLEDGE_ANSWER,
        workflow_version="v1",
        correlation_id="request-42",
        input={"question": "如何保持固定作息"},
    )
    result = await execute_bounded_graph(run)
    citation = result.output["toolResults"][0]["result"]["citations"][0]
    assert citation["id"] == "chunk-1"
    assert result.output["traceId"] == "request-42"


@pytest.mark.asyncio
async def test_knowledge_outage_degrades_without_fabricated_citations(monkeypatch):
    class Client:
        def search(self, *_args, **_kwargs):
            raise KnowledgeServiceUnavailable("timeout")

    monkeypatch.setenv("KNOWLEDGE_PROVIDER", "service")
    monkeypatch.setattr("app.tools.KnowledgeServiceClient.from_env", lambda: Client())
    run = AgentRun(
        tenant_id=uuid4(), user_id=uuid4(), agent_type=AgentType.KNOWLEDGE_ANSWER,
        workflow_version="v1", input={"question": "sleep"},
    )
    result = await execute_bounded_graph(run)
    retrieval = result.output["toolResults"][0]["result"]
    assert result.output["evidence"] == "degraded"
    assert retrieval["citations"] == []
    assert retrieval["degraded"] is True


@pytest.mark.asyncio
async def test_feature_service_outage_degrades_without_invented_metrics(monkeypatch):
    class Client:
        def get_sleep_features(self, *_args, **_kwargs):
            raise FeatureServiceUnavailable("timeout")

    monkeypatch.setenv("FEATURE_PROVIDER", "service")
    monkeypatch.setattr("app.tools.FeatureServiceClient.from_env", lambda: Client())
    run = AgentRun(
        tenant_id=uuid4(),
        user_id=uuid4(),
        agent_type=AgentType.SLEEP_ANALYSIS,
        workflow_version="v1",
        input={"device_id": "device-1", "allowed_device_ids": ["device-1"]},
    )
    result = await execute_bounded_graph(run)
    feature = result.output["toolResults"][0]["result"]
    assert result.status == "succeeded"
    assert result.output["evidence"] == "degraded"
    assert feature["degraded"] is True
    assert "sleepScore" not in feature
    assert "deepSleepRatio" not in feature


@pytest.mark.asyncio
async def test_feature_authorization_failure_is_terminal(monkeypatch):
    class Client:
        def get_sleep_features(self, *_args, **_kwargs):
            raise FeatureServiceAuthorizationError("identity mismatch")

    monkeypatch.setenv("FEATURE_PROVIDER", "service")
    monkeypatch.setattr("app.tools.FeatureServiceClient.from_env", lambda: Client())
    run = AgentRun(
        tenant_id=uuid4(),
        user_id=uuid4(),
        agent_type=AgentType.SLEEP_ANALYSIS,
        workflow_version="v1",
        input={"device_id": "device-1", "allowed_device_ids": ["device-1"]},
    )
    result = await execute_bounded_graph(run)
    assert result.status == "failed"
    assert result.error == "identity mismatch"


def test_run_store_survives_restart(tmp_path):
    path = str(tmp_path / "runs.sqlite3")
    first = RunStore(path)
    run = AgentRun(tenant_id=uuid4(), user_id=uuid4(), agent_type=AgentType.KNOWLEDGE_ANSWER, workflow_version="v1", input={"question": "睡眠"})
    first.save(run)
    second = RunStore(path)
    restored = second.get(run.run_id)
    assert restored is not None
    assert restored.input == run.input
    assert second.recoverable()[0].run_id == run.run_id


def test_evaluation_dataset_has_required_coverage():
    cases = build_cases()
    assert len(cases) == 84
    assert any(case["id"].startswith("injection-") for case in cases)
    assert any(case["id"].startswith("business-report-") for case in cases)
    assert any(case["id"].startswith("privacy-reject-") for case in cases)
    assert any(case["expected"] == "waiting_approval" for case in cases)
    assert any(case["expected"] == "failed" for case in cases)
