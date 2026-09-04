import asyncio
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from uuid import UUID

from fastapi import FastAPI, Header, HTTPException, Response, status

from .business_agents import validate_business_input
from .capabilities import snapshot_capabilities
from .context_compaction import compact_run_output
from .graph import execute_bounded_graph
from .input_guard import guard_input
from .model_gateway import model_gateway_metrics
from .models import (
    AgentRun,
    AgentTraceView,
    CreateRunRequest,
    PreferenceMemory,
    PreferenceMemoryCreate,
    RunStatus,
    WorkspaceArtifact,
    WorkspaceArtifactCreate,
)
from .privacy import validate_expiry, validate_structured_agent_data
from .store import RunStore, create_state_store
from .temporal_worker import TemporalRuntime, create_temporal_runtime
from .trace_view import build_trace_view


store = create_state_store()
runs: dict[UUID, AgentRun] = store.load_all() if isinstance(store, RunStore) else {}
queue_max = int(os.getenv("AGENT_QUEUE_MAX", "1000"))
worker_concurrency = int(os.getenv("AGENT_WORKER_CONCURRENCY", "10"))
run_queue: asyncio.Queue[tuple[UUID, bool]] = asyncio.Queue(maxsize=queue_max)
worker_tasks: list[asyncio.Task[None]] = []
temporal_runtime: TemporalRuntime | None = None
metrics_state = {
    "created": 0,
    "completed": 0,
    "failed": 0,
    "tool_failures": 0,
    "degraded": 0,
}


def coordinator_name() -> str:
    return os.getenv("AGENT_COORDINATOR", "local").strip().lower()


def _save(run: AgentRun) -> None:
    if isinstance(store, RunStore):
        runs[run.run_id] = run
    store.save(run)


async def run_worker() -> None:
    while True:
        run_id, approved = await run_queue.get()
        try:
            run = store.get(run_id)
            if run and run.status != RunStatus.CANCELLED:
                run = await execute_bounded_graph(run, approved=approved)
                run = compact_run_output(run, store)
                _save(run)
                if (
                    run.status == RunStatus.FAILED
                    and "timeout" in (run.error or "")
                    and run.attempts < 3
                ):
                    await asyncio.sleep(0.05 * run.attempts)
                    run.status = RunStatus.QUEUED
                    _save(run)
                    run_queue.put_nowait((run_id, approved))
                elif run.status == RunStatus.SUCCEEDED:
                    metrics_state["completed"] += 1
                    if run.output and run.output.get("evidence") == "degraded":
                        metrics_state["degraded"] += 1
                elif run.status == RunStatus.FAILED:
                    metrics_state["failed"] += 1
                    metrics_state["tool_failures"] += 1
        finally:
            run_queue.task_done()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global temporal_runtime
    coordinator = coordinator_name()
    store.purge_expired()
    if coordinator == "local":
        for run in store.recoverable():
            run.status = RunStatus.QUEUED
            _save(run)
            run_queue.put_nowait((run.run_id, False))
        worker_tasks.extend(
            asyncio.create_task(run_worker()) for _ in range(worker_concurrency)
        )
    elif coordinator == "temporal":
        if os.getenv("AGENT_STATE_BACKEND", "sqlite").lower() != "postgres":
            raise RuntimeError("Temporal coordinator requires AGENT_STATE_BACKEND=postgres")
        temporal_runtime = await create_temporal_runtime()
        await temporal_runtime.start()
    else:
        raise RuntimeError("AGENT_COORDINATOR must be local or temporal")
    yield
    for task in worker_tasks:
        task.cancel()
    await asyncio.gather(*worker_tasks, return_exceptions=True)
    worker_tasks.clear()
    if temporal_runtime:
        await temporal_runtime.close()
        temporal_runtime = None


app = FastAPI(title="Sleep Agent Service", version="0.2.0", lifespan=lifespan)


@app.get("/health/live")
async def live() -> dict[str, str]:
    return {"status": "ok", "service": "agent-service"}


@app.get("/health/ready")
async def ready() -> dict[str, str]:
    if not store.healthcheck():
        raise HTTPException(status_code=503, detail="Agent state store is not ready")
    if coordinator_name() == "temporal" and (
        temporal_runtime is None or not await temporal_runtime.is_healthy()
    ):
        raise HTTPException(status_code=503, detail="Temporal is not ready")
    return {
        "status": "ready",
        "workflowEngine": coordinator_name(),
        "stateBackend": os.getenv("AGENT_STATE_BACKEND", "sqlite"),
        "queueDepth": str(run_queue.qsize()) if coordinator_name() == "local" else "managed-by-temporal",
        "queueCapacity": str(queue_max) if coordinator_name() == "local" else "managed-by-temporal",
        "workers": str(worker_concurrency) if coordinator_name() == "local" else "temporal",
    }


@app.post("/v1/runs", response_model=AgentRun, status_code=status.HTTP_202_ACCEPTED)
async def create_run(request: CreateRunRequest) -> AgentRun:
    try:
        validate_business_input(request.agent_type, request.input)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    # L0: Input guard — prompt injection detection.
    # Blocked runs (L3/L4: tool hijack, data exfiltration) are rejected
    # at the API boundary. Detected-but-not-blocked (L1/L2) are logged
    # in the run trace and proceed with policy enforcement (defense in depth).
    guard_result = guard_input(request.input, request.agent_type.value)
    if guard_result.blocked:
        raise HTTPException(
            status_code=403,
            detail={
                "message": "Run blocked by input guard",
                "riskLevel": guard_result.risk_level.value,
                "injectionType": guard_result.injection_type.value,
                "reason": guard_result.reason,
            },
        )
    if request.run_id:
        existing = store.get(request.run_id)
        if existing:
            if existing.tenant_id != request.tenant_id:
                raise HTTPException(status_code=409, detail="Run id already exists")
            if coordinator_name() == "temporal":
                if temporal_runtime is None:
                    raise HTTPException(status_code=503, detail="Temporal runtime is not ready")
                await temporal_runtime.start_run(existing)
            return existing
    run = AgentRun(
        **({"run_id": request.run_id} if request.run_id else {}),
        tenant_id=request.tenant_id,
        user_id=request.user_id,
        session_id=request.session_id,
        agent_type=request.agent_type,
        workflow_version=request.workflow_version,
        input=request.input,
        budget=request.budget,
        correlation_id=request.correlation_id,
    )
    run.capabilities = snapshot_capabilities(run)
    if coordinator_name() == "local" and run_queue.full():
        raise HTTPException(status_code=429, detail="Agent admission queue is full")
    _save(run)
    metrics_state["created"] += 1
    if coordinator_name() == "temporal":
        if temporal_runtime is None:
            raise HTTPException(status_code=503, detail="Temporal runtime is not ready")
        await temporal_runtime.start_run(run)
    else:
        run_queue.put_nowait((run.run_id, False))
    return run


def _tenant_run(run_id: UUID, tenant_id: UUID) -> AgentRun:
    run = store.get(run_id)
    if not run or run.tenant_id != tenant_id:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return run


@app.get("/v1/runs/{run_id}", response_model=AgentRun)
async def get_run(run_id: UUID, x_tenant_id: UUID = Header()) -> AgentRun:
    return _tenant_run(run_id, x_tenant_id)


@app.get("/v1/runs/{run_id}/trace", response_model=AgentTraceView)
async def get_run_trace(run_id: UUID, x_tenant_id: UUID = Header()) -> AgentTraceView:
    return build_trace_view(_tenant_run(run_id, x_tenant_id))


@app.post("/v1/runs/{run_id}/cancel", response_model=AgentRun)
async def cancel_run(run_id: UUID, x_tenant_id: UUID = Header()) -> AgentRun:
    run = _tenant_run(run_id, x_tenant_id)
    if run.status in {RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED}:
        raise HTTPException(status_code=409, detail="Agent run is already terminal")
    if coordinator_name() == "temporal":
        if temporal_runtime is None:
            raise HTTPException(status_code=503, detail="Temporal runtime is not ready")
        await temporal_runtime.cancel_run(str(run_id))
    run.status = RunStatus.CANCELLED
    run.updated_at = datetime.now(timezone.utc)
    _save(run)
    return run


@app.post("/v1/runs/{run_id}/approve", response_model=AgentRun)
async def approve_run(run_id: UUID, x_tenant_id: UUID = Header()) -> AgentRun:
    run = _tenant_run(run_id, x_tenant_id)
    if run.status != RunStatus.WAITING_APPROVAL:
        raise HTTPException(status_code=409, detail="Agent run is not waiting for approval")
    if coordinator_name() == "temporal":
        if temporal_runtime is None:
            raise HTTPException(status_code=503, detail="Temporal runtime is not ready")
        await temporal_runtime.approve_run(str(run_id))
    else:
        if run_queue.full():
            raise HTTPException(status_code=429, detail="Agent admission queue is full")
        run_queue.put_nowait((run_id, True))
    run.status = RunStatus.RUNNING
    run.updated_at = datetime.now(timezone.utc)
    _save(run)
    return run


def _require_identity(body_tenant_id: UUID, body_user_id: UUID, header_tenant_id: UUID, header_user_id: UUID) -> None:
    if body_tenant_id != header_tenant_id or body_user_id != header_user_id:
        raise HTTPException(status_code=404, detail="Agent resource not found")


@app.post("/v1/memories/preferences", response_model=PreferenceMemory, status_code=201)
async def create_preference_memory(
    request: PreferenceMemoryCreate,
    x_tenant_id: UUID = Header(),
    x_user_id: UUID = Header(),
) -> PreferenceMemory:
    _require_identity(request.tenant_id, request.user_id, x_tenant_id, x_user_id)
    try:
        validate_structured_agent_data(request.value)
        validate_expiry(request.expires_at)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    memory = PreferenceMemory(**request.model_dump())
    store.save_memory(memory)
    return memory


@app.get("/v1/memories/preferences", response_model=list[PreferenceMemory])
async def list_preference_memories(
    x_tenant_id: UUID = Header(), x_user_id: UUID = Header()
) -> list[PreferenceMemory]:
    return store.list_memories(x_tenant_id, x_user_id)


@app.delete("/v1/memories/preferences/{memory_id}", status_code=204)
async def delete_preference_memory(
    memory_id: UUID, x_tenant_id: UUID = Header(), x_user_id: UUID = Header()
) -> Response:
    if not store.delete_memory(memory_id, x_tenant_id, x_user_id):
        raise HTTPException(status_code=404, detail="Preference memory not found")
    return Response(status_code=204)


@app.post("/v1/workspaces/artifacts", response_model=WorkspaceArtifact, status_code=201)
async def create_workspace_artifact(
    request: WorkspaceArtifactCreate,
    x_tenant_id: UUID = Header(),
    x_user_id: UUID = Header(),
) -> WorkspaceArtifact:
    _require_identity(request.tenant_id, request.user_id, x_tenant_id, x_user_id)
    try:
        validate_structured_agent_data(request.content)
        validate_expiry(request.expires_at)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    artifact = WorkspaceArtifact(**request.model_dump())
    store.save_artifact(artifact)
    return artifact


@app.get("/v1/workspaces/artifacts/{artifact_id}", response_model=WorkspaceArtifact)
async def get_workspace_artifact(
    artifact_id: UUID, x_tenant_id: UUID = Header()
) -> WorkspaceArtifact:
    artifact = store.get_artifact(artifact_id, x_tenant_id)
    if not artifact:
        raise HTTPException(status_code=404, detail="Workspace artifact not found")
    return artifact


@app.delete("/v1/workspaces/artifacts/{artifact_id}", status_code=204)
async def delete_workspace_artifact(
    artifact_id: UUID, x_tenant_id: UUID = Header(), x_user_id: UUID = Header()
) -> Response:
    if not store.delete_artifact(artifact_id, x_tenant_id, x_user_id):
        raise HTTPException(status_code=404, detail="Workspace artifact not found")
    return Response(status_code=204)


@app.get("/metrics")
async def metrics(response: Response) -> str:
    response.headers["content-type"] = "text/plain; version=0.0.4"
    status_counts = store.status_counts()
    model_metrics = model_gateway_metrics()
    lines = [
        "# HELP sleep_agent_queue_depth Current admission queue depth.",
        "# TYPE sleep_agent_queue_depth gauge",
        f"sleep_agent_queue_depth {run_queue.qsize()}",
        "# HELP sleep_agent_runs_total Agent runs by outcome.",
        "# TYPE sleep_agent_runs_total counter",
        *(f'sleep_agent_runs_total{{outcome="{key}"}} {value}' for key, value in metrics_state.items() if key != "tool_failures"),
        "# HELP sleep_agent_tool_failures_total Failed tool executions.",
        "# TYPE sleep_agent_tool_failures_total counter",
        f'sleep_agent_tool_failures_total {metrics_state["tool_failures"]}',
        "# HELP sleep_agent_run_status Current persisted runs by status.",
        "# TYPE sleep_agent_run_status gauge",
        *(f'sleep_agent_run_status{{status="{key}"}} {value}' for key, value in status_counts.items()),
        "# HELP sleep_agent_model_calls_total Business model calls by outcome.",
        "# TYPE sleep_agent_model_calls_total counter",
        f'sleep_agent_model_calls_total{{outcome="success"}} {model_metrics["successes"]}',
        f'sleep_agent_model_calls_total{{outcome="failure"}} {model_metrics["failures"]}',
        f'sleep_agent_model_calls_total{{outcome="fallback"}} {model_metrics["fallbacks"]}',
        f'sleep_agent_model_calls_total{{outcome="circuit_rejected"}} {model_metrics["circuit_rejections"]}',
        "# HELP sleep_agent_model_inflight Current external model requests.",
        "# TYPE sleep_agent_model_inflight gauge",
        f'sleep_agent_model_inflight {model_metrics["inflight"]}',
        "# HELP sleep_agent_model_tokens_total Model tokens by direction.",
        "# TYPE sleep_agent_model_tokens_total counter",
        f'sleep_agent_model_tokens_total{{direction="prompt"}} {model_metrics["prompt_tokens"]}',
        f'sleep_agent_model_tokens_total{{direction="completion"}} {model_metrics["completion_tokens"]}',
        "# HELP sleep_agent_model_latency_seconds_sum Total external model request latency.",
        "# TYPE sleep_agent_model_latency_seconds_sum counter",
        f'sleep_agent_model_latency_seconds_sum {model_metrics["latency_seconds_sum"]}',
    ]
    return "\n".join(lines) + "\n"
