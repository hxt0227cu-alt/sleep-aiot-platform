from datetime import datetime
from typing import Any

from .models import (
    AgentRun,
    AgentTraceView,
    RunStatus,
    TraceCapabilityVersions,
    TraceModelUsage,
    TraceToolCall,
)


_TRACE_SOURCES = {
    "ads_agent_device_sleep_features",
    "backend-rag",
    "backend-rag-degraded",
    "deterministic-degraded",
    "deterministic-safety-policy",
    "embedded-evaluation-corpus",
    "simulated",
    "simulated-aggregate",
    "simulated-device",
}


def _non_negative_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError, OverflowError):
        return 0


def _trace_time(value: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def _tool_calls(run: AgentRun) -> list[TraceToolCall]:
    calls: list[TraceToolCall] = []
    for event in run.trace:
        if not isinstance(event, dict) or not event.get("tool") or not event.get("at"):
            continue
        at = _trace_time(event["at"])
        if at is None:
            continue
        result = event.get("result") if isinstance(event.get("result"), dict) else {}
        source = result.get("source")
        calls.append(
            TraceToolCall(
                at=at,
                tool=str(event["tool"]),
                outcome="degraded" if result.get("degraded") else "succeeded",
                source=str(source) if source in _TRACE_SOURCES else None,
                replayed=bool(result.get("replayed", False)),
            )
        )
    return calls


def _model_usage(output: dict[str, Any]) -> TraceModelUsage | None:
    model = output.get("model")
    if not isinstance(model, dict):
        return None
    prompt_tokens = _non_negative_int(model.get("promptTokens"))
    completion_tokens = _non_negative_int(model.get("completionTokens"))
    provider = str(model.get("provider") or "unknown")
    decision = str(model.get("reason") or "unknown")
    return TraceModelUsage(
        provider=provider,
        model=str(model.get("model") or "unknown"),
        decision=decision,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=prompt_tokens + completion_tokens,
        fallback="fallback" in provider or decision in {"circuit_open", "provider_error"},
    )


def _error_code(run: AgentRun) -> str | None:
    if run.status == RunStatus.CANCELLED:
        return "cancelled"
    if not run.error:
        return None
    if "run budget exceeded" in run.error:
        return "budget_exceeded"
    return "terminal_failure"


def build_trace_view(run: AgentRun) -> AgentTraceView:
    context = run.runtime_context
    capabilities = run.capabilities
    output = run.output if isinstance(run.output, dict) else {}
    duration_ms = max(0, int((run.updated_at - run.created_at).total_seconds() * 1000))
    return AgentTraceView(
        run_id=run.run_id,
        trace_id=context.trace_id if context is not None else run.run_id,
        correlation_id=(
            context.correlation_id
            if context is not None and context.correlation_id
            else run.correlation_id or str(run.run_id)
        ),
        tenant_id=run.tenant_id,
        agent_type=run.agent_type,
        status=run.status,
        attempts=run.attempts,
        duration_ms=duration_ms,
        approval_required=(
            run.status == RunStatus.WAITING_APPROVAL or "approval_required" in run.steps
        ),
        evidence=str(output["evidence"]) if output.get("evidence") is not None else None,
        error_code=_error_code(run),
        capability_versions=TraceCapabilityVersions(
            workflow_version=(
                capabilities.workflow_version if capabilities is not None else run.workflow_version
            ),
            prompt_version=(
                capabilities.prompt_version if capabilities is not None else "unknown"
            ),
            policy_version=(
                capabilities.policy_version if capabilities is not None else "unknown"
            ),
            toolset_version=(
                capabilities.toolset_version if capabilities is not None else "unknown"
            ),
            context_version=(
                capabilities.context_version
                if capabilities is not None
                else context.context_version
                if context is not None
                else "unknown"
            ),
        ),
        tool_calls=_tool_calls(run),
        model_usage=_model_usage(output),
        created_at=run.created_at,
        updated_at=run.updated_at,
    )
