"""
Risk Governance: L0-L4 five-level risk system for the Agent Runtime.

Each level maps to a concrete enforcement mechanism already present in
the codebase. This module provides a unified risk assessment API that
combines input guard results, agent type baseline, tool classification,
budget constraints, and approval state into a single structured verdict.

Five levels:
  L0  Input validation layer    — schema check, raw health data interception,
                                   prompt injection pre-scan
  L1  Policy allowlist layer    — per-agent-type tool whitelist, parameter
                                   boundary validation, knowledge untrusted-data
                                   marking
  L2  Approval gate layer       — high-risk write operations require explicit
                                   human approval (device control, algorithm
                                   publication)
  L3  Budget hard-limit layer   — max steps / duration / input tokens / output
                                   tokens / tool calls, circuit breaker on
                                   model gateway
  L4  Audit & redaction layer   — trace logging with sensitive field redaction,
                                   tenant-scoped audit events, security alerting
                                   on severe injection
"""

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from .input_guard import GuardResult, RiskLevel, guard_input
from .models import AgentType, RunBudget


class RiskTier(StrEnum):
    """Operational risk tier derived from the L0-L4 assessment."""
    SAFE = "safe"           # L0 — read-only, no approval, no monitoring
    LOW = "low"             # L1 — monitored, no approval needed
    MEDIUM = "medium"       # L2 — approval required for write operations
    HIGH = "high"           # L3 — blocked by default, explicit override needed
    CRITICAL = "critical"   # L4 — hard block, security alert triggered


@dataclass
class RiskAssessment:
    """Structured risk assessment for an agent run or tool call."""
    tier: RiskTier
    level: RiskLevel
    requires_approval: bool
    blocked: bool
    reasons: list[str] = field(default_factory=list)
    guard_result: GuardResult | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "tier": self.tier.value,
            "level": self.level.value,
            "requiresApproval": self.requires_approval,
            "blocked": self.blocked,
            "reasons": self.reasons,
            "guard": self.guard_result.to_dict() if self.guard_result else None,
        }


# ---------------------------------------------------------------------------
# Risk baseline tables
# ---------------------------------------------------------------------------

# Agent type → baseline risk tier (L1 policy allowlist layer)
_AGENT_BASELINE: dict[AgentType, RiskTier] = {
    AgentType.KNOWLEDGE_ANSWER: RiskTier.SAFE,
    AgentType.SLEEP_ANALYSIS: RiskTier.SAFE,
    AgentType.SLEEP_REPORT: RiskTier.LOW,
    AgentType.SLEEP_IMPROVEMENT: RiskTier.LOW,
    AgentType.VOICE_COMPANION: RiskTier.LOW,
    AgentType.OPS_DIAGNOSIS: RiskTier.MEDIUM,
    AgentType.ALGORITHM_OPTIMIZATION: RiskTier.MEDIUM,
    AgentType.DEVICE_CONTROL: RiskTier.HIGH,
}

# Tool name → risk tier (L1 policy + L2 approval gate)
_TOOL_RISK: dict[str, RiskTier] = {
    # Read-only safe tools
    "search_knowledge": RiskTier.SAFE,
    "get_sleep_features": RiskTier.SAFE,
    "read_runbook": RiskTier.LOW,
    # Low-risk tools
    "moderate_companion_input": RiskTier.LOW,
    # Medium-risk tools (approval recommended)
    "get_intervention_effects": RiskTier.MEDIUM,
    "query_prometheus": RiskTier.MEDIUM,
    "query_logs": RiskTier.MEDIUM,
    # High-risk write tools (approval required)
    "set_light": RiskTier.HIGH,
    "set_audio": RiskTier.HIGH,
    "schedule_device_action": RiskTier.CRITICAL,
}

# Budget safety thresholds (L3 hard-limit layer)
_BUDGET_THRESHOLDS = {
    "max_duration_seconds": 300.0,
    "max_tool_calls": 20,
    "max_input_tokens": 50000,
    "max_output_tokens": 8000,
    "max_steps": 50,
}


class RiskGovernor:
    """
    Unified L0-L4 risk assessor.

    Combines:
    - L0: InputGuard prompt injection detection
    - L1: Agent type / tool whitelist baseline
    - L2: Approval gate for write-capable agents and tools
    - L3: Budget hard-limit verification
    - L4: Audit redaction (enforced in tools.py _audit and store.py)
    """

    def assess_run(
        self,
        agent_type: AgentType,
        input_data: dict[str, Any],
        budget: RunBudget | None = None,
    ) -> RiskAssessment:
        """
        Assess overall risk for an agent run before execution.

        Returns a RiskAssessment with tier, level, approval requirement,
        block decision, and per-layer reasons.
        """
        reasons: list[str] = []

        # --- L0: Input validation ---
        guard = guard_input(input_data, agent_type.value)
        if guard.detected:
            reasons.append(
                f"L0: InputGuard detected {guard.injection_type.value} "
                f"(risk={guard.risk_level.value}, patterns={len(guard.matched_patterns)})"
            )
        else:
            reasons.append("L0: Input validation passed — no injection patterns, schema valid")

        # Determine starting tier from guard result
        if guard.blocked:
            tier = RiskTier.CRITICAL
            level = guard.risk_level
            blocked = True
            requires_approval = False
            reasons.append(
                f"L4: Hard block triggered by InputGuard ({guard.injection_type.value}). "
                "Security alert generated. Run will not execute."
            )
            return RiskAssessment(
                tier=tier, level=level, requires_approval=requires_approval,
                blocked=blocked, reasons=reasons, guard_result=guard,
            )

        # --- L1: Policy allowlist baseline ---
        baseline = _AGENT_BASELINE.get(agent_type, RiskTier.MEDIUM)
        tier = baseline
        level = self._tier_to_level(tier)
        reasons.append(f"L1: Agent type '{agent_type.value}' baseline risk = {baseline.value}")

        # Escalate if guard found L2/L3 patterns but didn't block
        if guard.detected and guard.risk_level in (RiskLevel.L2, RiskLevel.L3):
            tier = RiskTier.HIGH
            level = guard.risk_level
            reasons.append(
                f"L1→L3: Risk escalated due to injection pattern ({guard.injection_type.value})"
            )

        # --- L2: Approval gate ---
        requires_approval = False
        if agent_type == AgentType.DEVICE_CONTROL:
            requires_approval = True
            reasons.append(
                "L2: Device control agent — all write tools (set_light, set_audio, "
                "schedule_device_action) require explicit human approval before execution"
            )
        elif agent_type == AgentType.ALGORITHM_OPTIMIZATION:
            requires_approval = True
            reasons.append(
                "L2: Algorithm optimization agent — proposals require human approval "
                "before publication (autoPublish=false, 5% canary guardrail)"
            )
        elif agent_type == AgentType.OPS_DIAGNOSIS:
            requires_approval = True
            reasons.append(
                "L2: Ops diagnosis agent — write-capable operations require approval"
            )

        # --- L3: Budget hard-limit verification ---
        if budget:
            budget_flags = self._check_budget(budget)
            if budget_flags:
                reasons.append(f"L3: Budget threshold flags: {'; '.join(budget_flags)}")
                if tier in (RiskTier.SAFE, RiskTier.LOW):
                    tier = RiskTier.MEDIUM
                    level = RiskLevel.L3
                    reasons.append("L3: Tier escalated to MEDIUM due to budget threshold exceedance")
            else:
                reasons.append("L3: Budget within safety thresholds")

        # --- L4: Audit & redaction (always on) ---
        reasons.append(
            "L4: Audit enabled — all tool calls logged with argument redaction "
            "(token/secret/transcript/prompt → [REDACTED]); tenant-scoped audit trail"
        )

        blocked = False
        return RiskAssessment(
            tier=tier, level=level, requires_approval=requires_approval,
            blocked=blocked, reasons=reasons, guard_result=guard if guard.detected else None,
        )

    def assess_tool_call(
        self,
        agent_type: AgentType,
        tool: str,
        arguments: dict[str, Any],
        approved: bool = False,
    ) -> RiskAssessment:
        """Assess risk for a specific tool call within a running graph."""
        reasons: list[str] = []

        # L1: Tool risk classification
        tool_tier = _TOOL_RISK.get(tool, RiskTier.MEDIUM)
        tier = tool_tier
        level = self._tier_to_level(tier)
        reasons.append(f"L1: Tool '{tool}' risk tier = {tool_tier.value}")

        # L2: Approval check
        requires_approval = tier in (RiskTier.HIGH, RiskTier.CRITICAL)
        blocked = False
        if requires_approval and not approved:
            blocked = True
            reasons.append("L2: Write tool blocked — approval not granted (approved=False)")

        # L3: Parameter boundary validation
        param_issues = self._validate_tool_params(tool, arguments)
        if param_issues:
            blocked = True
            tier = RiskTier.HIGH
            level = RiskLevel.L3
            reasons.append(f"L3: Parameter validation failed: {'; '.join(param_issues)}")

        # L4: Audit
        reasons.append("L4: Tool call will be audited with sensitive argument redaction")

        return RiskAssessment(
            tier=tier, level=level, requires_approval=requires_approval,
            blocked=blocked, reasons=reasons,
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _tier_to_level(tier: RiskTier) -> RiskLevel:
        return {
            RiskTier.SAFE: RiskLevel.L0,
            RiskTier.LOW: RiskLevel.L1,
            RiskTier.MEDIUM: RiskLevel.L2,
            RiskTier.HIGH: RiskLevel.L3,
            RiskTier.CRITICAL: RiskLevel.L4,
        }[tier]

    @staticmethod
    def _check_budget(budget: RunBudget) -> list[str]:
        flags: list[str] = []
        if budget.max_duration_seconds > _BUDGET_THRESHOLDS["max_duration_seconds"]:
            flags.append(
                f"max_duration_seconds={budget.max_duration_seconds} > "
                f"{_BUDGET_THRESHOLDS['max_duration_seconds']}s safety threshold"
            )
        if budget.max_tool_calls > _BUDGET_THRESHOLDS["max_tool_calls"]:
            flags.append(
                f"max_tool_calls={budget.max_tool_calls} > "
                f"{_BUDGET_THRESHOLDS['max_tool_calls']} safety threshold"
            )
        if budget.max_input_tokens > _BUDGET_THRESHOLDS["max_input_tokens"]:
            flags.append(
                f"max_input_tokens={budget.max_input_tokens} > "
                f"{_BUDGET_THRESHOLDS['max_input_tokens']} safety threshold"
            )
        if budget.max_output_tokens > _BUDGET_THRESHOLDS["max_output_tokens"]:
            flags.append(
                f"max_output_tokens={budget.max_output_tokens} > "
                f"{_BUDGET_THRESHOLDS['max_output_tokens']} safety threshold"
            )
        if budget.max_steps > _BUDGET_THRESHOLDS["max_steps"]:
            flags.append(
                f"max_steps={budget.max_steps} > "
                f"{_BUDGET_THRESHOLDS['max_steps']} safety threshold"
            )
        return flags

    @staticmethod
    def _validate_tool_params(tool: str, arguments: dict[str, Any]) -> list[str]:
        issues: list[str] = []
        if tool == "set_light":
            brightness = arguments.get("brightness")
            if brightness is not None:
                try:
                    if not (0 <= float(brightness) <= 100):
                        issues.append(f"brightness={brightness} out of bounds [0, 100]")
                except (TypeError, ValueError):
                    issues.append(f"brightness={brightness!r} is not a valid number")
            power = arguments.get("power")
            if power is not None and str(power).lower() not in {"on", "off", "true", "false", "0", "1"}:
                issues.append(f"power={power!r} is not a valid on/off value")

        if tool == "set_audio":
            volume = arguments.get("volume")
            if volume is not None:
                try:
                    if not (0 <= float(volume) <= 100):
                        issues.append(f"volume={volume} out of bounds [0, 100]")
                except (TypeError, ValueError):
                    issues.append(f"volume={volume!r} is not a valid number")

        if tool == "get_sleep_features":
            window_days = arguments.get("window_days", 7)
            try:
                if not (1 <= int(window_days) <= 28):
                    issues.append(f"window_days={window_days} out of bounds [1, 28]")
            except (TypeError, ValueError):
                issues.append(f"window_days={window_days!r} is not a valid integer")

        if tool == "search_knowledge":
            query = arguments.get("query")
            if not isinstance(query, str) or not query.strip():
                issues.append("query is empty or not a string")
            elif len(query) > 2000:
                issues.append(f"query length={len(query)} exceeds 2000 character limit")

        return issues


# ---------------------------------------------------------------------------
# Module-level singleton and convenience functions
# ---------------------------------------------------------------------------
_default_governor: RiskGovernor | None = None


def get_risk_governor() -> RiskGovernor:
    global _default_governor
    if _default_governor is None:
        _default_governor = RiskGovernor()
    return _default_governor


def assess_run_risk(
    agent_type: AgentType,
    input_data: dict[str, Any],
    budget: RunBudget | None = None,
) -> RiskAssessment:
    """Convenience: assess run risk with the default governor."""
    return get_risk_governor().assess_run(agent_type, input_data, budget)


def assess_tool_risk(
    agent_type: AgentType,
    tool: str,
    arguments: dict[str, Any],
    approved: bool = False,
) -> RiskAssessment:
    """Convenience: assess tool call risk with the default governor."""
    return get_risk_governor().assess_tool_call(agent_type, tool, arguments, approved)
