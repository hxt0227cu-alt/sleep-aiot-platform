import json
import os
from datetime import datetime, timedelta, timezone

from .models import AgentRun, WorkspaceArtifact
from .store import AgentStateStore


def compact_run_output(run: AgentRun, store: AgentStateStore) -> AgentRun:
    if run.output is None:
        return run
    threshold = int(os.getenv("AGENT_CONTEXT_INLINE_MAX_BYTES", "80000"))
    encoded = json.dumps(run.output, ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )
    if len(encoded) <= threshold:
        return run

    artifact = WorkspaceArtifact(
        tenant_id=run.tenant_id,
        user_id=run.user_id,
        session_id=run.session_id or run.run_id,
        artifact_key=f"runs/{run.run_id}/result.json",
        artifact_type="run_result",
        content={"output": run.output},
        source="result_eviction",
        purpose="context_compaction",
        expires_at=datetime.now(timezone.utc) + timedelta(days=30),
    )
    store.save_artifact(artifact)
    run.output = {
        "message": "Agent result was moved to the tenant workspace.",
        "artifactId": str(artifact.artifact_id),
        "artifactKey": artifact.artifact_key,
        "compaction": "result_eviction.v1",
        "originalBytes": len(encoded),
        "workflowVersion": run.workflow_version,
        "traceId": run.runtime_context.correlation_id if run.runtime_context else str(run.run_id),
    }
    return run
