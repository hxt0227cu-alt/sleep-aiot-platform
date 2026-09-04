import hashlib
import os
from datetime import datetime, timezone
from typing import Any

from .feature_client import FeatureServiceClient, FeatureServiceUnavailable
from .knowledge_client import (
    KnowledgeServiceAuthorizationError,
    KnowledgeServiceClient,
    KnowledgeServiceUnavailable,
)
from .models import AgentRun, AgentType
from .policy import validate_tool_call


KNOWLEDGE = (
    {"id": "sleep-hygiene-v1", "text": "\u4fdd\u6301\u56fa\u5b9a\u4f5c\u606f\uff0c\u7761\u524d\u51cf\u5c11\u5f3a\u5149\u548c\u5496\u5561\u56e0\uff0c\u6709\u52a9\u4e8e\u6539\u5584\u7761\u7720\u8fde\u7eed\u6027\u3002"},
    {"id": "deep-sleep-v1", "text": "\u6df1\u7761\u504f\u5c11\u65f6\u5e94\u5148\u89c2\u5bdf\u4e00\u5230\u4e24\u5468\u8d8b\u52bf\uff0c\u540c\u65f6\u7ed3\u5408\u603b\u7761\u7720\u65f6\u957f\u548c\u591c\u95f4\u89c9\u9192\u6b21\u6570\u3002"},
    {"id": "device-offline-v1", "text": "\u8bbe\u5907\u79bb\u7ebf\u65f6\u63a7\u5236\u547d\u4ee4\u4e0d\u5f97\u5047\u5b9a\u6210\u529f\uff0c\u5e94\u8fd4\u56de\u660e\u786e\u5931\u8d25\u5e76\u5141\u8bb8\u6709\u9650\u91cd\u8bd5\u3002"},
)

_idempotent_results: dict[str, dict[str, Any]] = {}
_AUDIT_REDACTED_KEYS = {"token", "secret", "text", "transcript", "prompt", "question"}


def _audit(run: AgentRun, tool: str, arguments: dict[str, Any], result: dict[str, Any]) -> None:
    run.trace.append({
        "at": datetime.now(timezone.utc).isoformat(),
        "runId": str(run.run_id),
        "correlationId": run.runtime_context.correlation_id if run.runtime_context else str(run.run_id),
        "tenantId": str(run.tenant_id),
        "tool": tool,
        "arguments": {
            key: "[REDACTED]" if key in _AUDIT_REDACTED_KEYS else value
            for key, value in arguments.items()
        },
        "result": result,
    })


def _authorize_device(run: AgentRun, device_id: str) -> None:
    allowed = run.input.get("allowed_device_ids", [run.input.get("device_id")])
    if device_id not in allowed:
        raise PermissionError("device is not authorized for this run")


def execute_tool(run: AgentRun, tool: str, arguments: dict[str, Any], *, approved: bool) -> dict[str, Any]:
    validate_tool_call(run.agent_type, tool, arguments, approved=approved)
    device_id = str(arguments.get("device_id") or run.input.get("device_id") or "")
    if tool in {"get_sleep_features", "set_light", "set_audio"}:
        if not device_id:
            raise ValueError("device_id is required")
        _authorize_device(run, device_id)

    if tool == "get_sleep_features" and os.getenv("FEATURE_PROVIDER", "simulated") == "service":
        window_days = int(arguments.get("window_days", 7))
        if not 1 <= window_days <= 28:
            raise ValueError("window_days must be between 1 and 28")
        try:
            result = FeatureServiceClient.from_env().get_sleep_features(
                run.tenant_id,
                device_id,
                window_days=window_days,
                correlation_id=(
                    run.runtime_context.correlation_id
                    if run.runtime_context
                    else str(run.run_id)
                ),
            )
        except FeatureServiceUnavailable:
            result = {
                "deviceId": device_id,
                "windowDays": window_days,
                "source": "deterministic-degraded",
                "degraded": True,
                "reason": "sleep_features_temporarily_unavailable",
                "message": "Sleep metrics are temporarily unavailable; no inferred values were substituted.",
            }
    elif tool == "get_sleep_features":
        window_days = int(arguments.get("window_days", 7))
        if not 1 <= window_days <= 28:
            raise ValueError("window_days must be between 1 and 28")
        seed = int(hashlib.sha256(device_id.encode()).hexdigest()[:8], 16)
        result = {
            "deviceId": device_id,
            "windowDays": window_days,
            "source": "simulated",
            "sleepScore": 65 + seed % 25,
            "averageDurationMinutes": 390 + seed % 80,
            "deepSleepRatio": round(0.16 + (seed % 9) / 100, 2),
            "awakenings": 1 + seed % 4,
        }
    elif tool == "search_knowledge":
        query = str(arguments.get("query") or run.input.get("question") or "").lower()
        if os.getenv("KNOWLEDGE_PROVIDER", "embedded") == "service":
            try:
                payload = KnowledgeServiceClient.from_env().search(
                    run.tenant_id,
                    run.runtime_context.correlation_id if run.runtime_context else str(run.run_id),
                    query,
                    top_k=2,
                )
                result = {
                    "query": query,
                    "citations": [
                        {
                            "id": chunk.get("chunkId"),
                            "text": chunk.get("content"),
                            "title": chunk.get("title"),
                            "path": chunk.get("sourcePath"),
                            "section": chunk.get("section"),
                            "similarity": chunk.get("similarity"),
                        }
                        for chunk in payload["chunks"]
                    ],
                    "source": "backend-rag",
                }
            except KnowledgeServiceUnavailable:
                result = {
                    "query": query,
                    "citations": [],
                    "source": "backend-rag-degraded",
                    "degraded": True,
                    "reason": "knowledge_temporarily_unavailable",
                }
            except KnowledgeServiceAuthorizationError:
                raise
        else:
            ranked = sorted(
                KNOWLEDGE,
                key=lambda item: sum(character in item["text"].lower() for character in set(query)),
                reverse=True,
            )
            result = {"query": query, "citations": list(ranked[:2]), "source": "embedded-evaluation-corpus"}
    elif tool == "moderate_companion_input":
        transcript = str(arguments.get("transcript") or "")
        lowered = transcript.lower()
        crisis_terms = {"自杀", "不想活", "伤害自己", "suicide", "kill myself"}
        blocked_terms = {"色情", "仇恨", "暴力教程", "毒品制作"}
        risk_level = (
            "crisis"
            if any(term in lowered for term in crisis_terms)
            else "blocked"
            if any(term in lowered for term in blocked_terms)
            else "normal"
        )
        result = {
            "riskLevel": risk_level,
            "source": "deterministic-safety-policy",
            "contentStored": False,
        }
    elif tool == "get_intervention_effects":
        cohort = str(arguments.get("cohort_id") or "")
        if not cohort:
            raise ValueError("cohort_id is required")
        seed = int(hashlib.sha256(cohort.encode()).hexdigest()[:8], 16)
        result = {
            "cohort": cohort,
            "sampleSize": 400 + seed % 600,
            "sleepContinuityDelta": round(0.01 + (seed % 4) / 100, 3),
            "optOutRate": round(0.005 + (seed % 3) / 1000, 3),
            "source": "simulated-aggregate",
            "containsRawHealthData": False,
        }
    elif tool in {"set_light", "set_audio"}:
        idempotency_key = str(arguments.get("idempotency_key") or f"{run.run_id}:{tool}")
        if idempotency_key in _idempotent_results:
            result = {**_idempotent_results[idempotency_key], "replayed": True}
        else:
            failure_mode = run.input.get("failure_mode")
            if failure_mode in {"offline", "timeout", "rejected"}:
                raise RuntimeError(f"simulated_device_{failure_mode}")
            result = {
                "deviceId": device_id,
                "commandId": hashlib.sha256(idempotency_key.encode()).hexdigest()[:16],
                "status": "acknowledged",
                "source": "simulated-device",
                "parameters": {key: value for key, value in arguments.items() if key not in {"device_id", "idempotency_key"}},
                "replayed": False,
            }
            _idempotent_results[idempotency_key] = result
    else:
        raise ValueError(f"unknown tool: {tool}")

    _audit(run, tool, arguments, result)
    return result


def planned_tools(run: AgentRun) -> list[tuple[str, dict[str, Any]]]:
    if run.agent_type == AgentType.SLEEP_ANALYSIS:
        return [
            ("get_sleep_features", {"device_id": run.input.get("device_id")}),
            ("search_knowledge", {"query": run.input.get("question", "\u5982\u4f55\u6539\u5584\u7761\u7720")}),
        ]
    if run.agent_type == AgentType.KNOWLEDGE_ANSWER:
        return [("search_knowledge", {"query": run.input.get("question", "")})]
    if run.agent_type == AgentType.SLEEP_REPORT:
        return [
            ("get_sleep_features", {"device_id": run.input.get("device_id"), "window_days": 1}),
            ("search_knowledge", {"query": "温和的睡眠卫生建议"}),
        ]
    if run.agent_type == AgentType.SLEEP_IMPROVEMENT:
        return [
            (
                "get_sleep_features",
                {
                    "device_id": run.input.get("device_id"),
                    "window_days": run.input.get("window_days", 28),
                },
            ),
            ("search_knowledge", {"query": "循序渐进改善睡眠习惯"}),
        ]
    if run.agent_type == AgentType.VOICE_COMPANION:
        return [
            (
                "moderate_companion_input",
                {"transcript": run.input.get("transcript", "")},
            )
        ]
    if run.agent_type == AgentType.ALGORITHM_OPTIMIZATION:
        return [
            (
                "get_intervention_effects",
                {"cohort_id": run.input.get("cohort_id", "")},
            )
        ]
    if run.agent_type == AgentType.DEVICE_CONTROL:
        device_id = run.input.get("device_id")
        calls: list[tuple[str, dict[str, Any]]] = []
        if "brightness" in run.input or "power" in run.input:
            calls.append(("set_light", {"device_id": device_id, "brightness": run.input.get("brightness"), "power": run.input.get("power"), "idempotency_key": f"{run.run_id}:light"}))
        if "sound" in run.input or "volume" in run.input:
            calls.append(("set_audio", {"device_id": device_id, "sound": run.input.get("sound", "rain"), "volume": run.input.get("volume", 50), "idempotency_key": f"{run.run_id}:audio"}))
        if not calls:
            raise ValueError("device control requires light or audio parameters")
        return calls
    return []
