from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import pytest

from app.graph import execute_bounded_graph
from app.context_compaction import compact_run_output
from app.models import AgentRun, AgentType, PreferenceMemory, RunBudget
from app.store import PostgresRunStore, RunStore
from app.temporal_worker import TemporalRuntime


@pytest.mark.asyncio
async def test_run_freezes_runtime_and_capability_versions():
    run = AgentRun(
        tenant_id=uuid4(),
        user_id=uuid4(),
        session_id=uuid4(),
        agent_type=AgentType.KNOWLEDGE_ANSWER,
        workflow_version="workflow.v7",
        input={"question": "如何保持作息"},
    )
    result = await execute_bounded_graph(run)

    assert result.status == "succeeded"
    assert result.runtime_context is not None
    assert result.runtime_context.trace_id == result.run_id
    assert result.capabilities is not None
    assert result.capabilities.workflow_version == "workflow.v7"
    assert result.capabilities.policy_version == "policy.v2"
    assert result.capabilities.allowed_tools == ["search_knowledge"]


@pytest.mark.asyncio
async def test_tool_call_budget_fails_closed():
    run = AgentRun(
        tenant_id=uuid4(),
        user_id=uuid4(),
        agent_type=AgentType.SLEEP_ANALYSIS,
        workflow_version="v1",
        input={"device_id": "sim-1", "allowed_device_ids": ["sim-1"]},
        budget=RunBudget(max_tool_calls=1),
    )
    result = await execute_bounded_graph(run)

    assert result.status == "failed"
    assert result.error == "run budget exceeded: tool calls"
    assert result.steps[-1] == "budget_exceeded"


@pytest.mark.asyncio
async def test_estimated_input_token_budget_fails_before_tools():
    run = AgentRun(
        tenant_id=uuid4(),
        user_id=uuid4(),
        agent_type=AgentType.KNOWLEDGE_ANSWER,
        workflow_version="v1",
        input={"question": "x" * 2000},
        budget=RunBudget(max_input_tokens=128),
    )
    result = await execute_bounded_graph(run)

    assert result.status == "failed"
    assert "estimated input tokens" in (result.error or "")
    assert result.steps == ["budget_exceeded"]


def test_large_result_is_evicted_to_tenant_workspace(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENT_CONTEXT_INLINE_MAX_BYTES", "100")
    store = RunStore(str(tmp_path / "runtime.sqlite3"))
    run = AgentRun(
        tenant_id=uuid4(),
        user_id=uuid4(),
        session_id=uuid4(),
        agent_type=AgentType.KNOWLEDGE_ANSWER,
        workflow_version="v1",
        input={"question": "sleep"},
        output={"message": "x" * 500},
    )

    compacted = compact_run_output(run, store)

    assert compacted.output["compaction"] == "result_eviction.v1"
    artifact = store.get_artifact(
        UUID(compacted.output["artifactId"]), run.tenant_id
    )
    assert artifact is not None
    assert artifact.content["output"]["message"] == "x" * 500
    assert store.get_artifact(UUID(compacted.output["artifactId"]), uuid4()) is None


@pytest.mark.asyncio
async def test_temporal_runtime_uses_durable_run_id_and_signals():
    calls: list[tuple[str, object]] = []

    class Handle:
        async def signal(self, signal):
            calls.append(("signal", signal.__name__))

    class Client:
        async def start_workflow(self, _workflow, _payload, **kwargs):
            calls.append(("start", kwargs["id"]))

        def get_workflow_handle(self, workflow_id):
            calls.append(("handle", workflow_id))
            return Handle()

    run = AgentRun(
        tenant_id=uuid4(),
        user_id=uuid4(),
        agent_type=AgentType.DEVICE_CONTROL,
        workflow_version="v1",
        input={"device_id": "sim-1", "brightness": 20},
    )
    runtime = TemporalRuntime(Client(), None)

    await runtime.start_run(run)
    await runtime.approve_run(str(run.run_id))
    await runtime.cancel_run(str(run.run_id))

    durable_id = f"sleep-agent-run-{run.run_id}"
    assert ("start", durable_id) in calls
    assert ("signal", "approve") in calls
    assert ("signal", "cancel") in calls


def test_expired_memory_content_is_redacted_and_audited(tmp_path):
    store = RunStore(str(tmp_path / "retention.sqlite3"))
    memory = PreferenceMemory(
        tenant_id=uuid4(),
        user_id=uuid4(),
        preference_key="sleep.window",
        value={"start": "22:00"},
        source="user_setting",
        purpose="personalize_sleep_plan",
        consent_id="consent-v1",
        expires_at=datetime.now(timezone.utc) - timedelta(seconds=1),
    )
    store.save_memory(memory)

    assert store.purge_expired() == 1
    with store._connect() as connection:
        payload = connection.execute(
            "SELECT payload FROM agent_preference_memories WHERE memory_id = ?",
            (str(memory.memory_id),),
        ).fetchone()[0]
    tombstone = PreferenceMemory.model_validate_json(payload)
    assert tombstone.value == {}
    assert tombstone.deleted_at is not None
    assert store.audit_events(memory.tenant_id, memory.user_id)[-1]["action"] == "expire"


def test_postgres_store_binds_prisma_scope_ids_as_text():
    calls: list[tuple[str, tuple[object, ...] | None]] = []

    class Cursor:
        @staticmethod
        def fetchall():
            return []

    class Connection:
        def execute(self, query, params=None):
            calls.append((query, params))
            return Cursor()

    class Context:
        def __enter__(self):
            return Connection()

        def __exit__(self, *_args):
            return None

    store = object.__new__(PostgresRunStore)
    store._connect = lambda: Context()
    tenant_id = uuid4()
    user_id = uuid4()

    assert store.list_memories(tenant_id, user_id) == []
    assert calls[-1][1] == (str(tenant_id), str(user_id))
