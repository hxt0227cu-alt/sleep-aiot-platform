"""
Input Guard: Prompt Injection detection and risk classification.

Detects direct and indirect prompt injection attempts across user input
and retrieved knowledge context, classifies the risk level (L0-L4),
and returns a structured guard result for the runtime to enforce.

Detection layers:
- Direct instruction override ("ignore previous instructions", etc.)
- Role/system prompt override ("you are now...", "<|system|>", etc.)
- Tool hijack (forcing execution of write tools like set_light)
- Data exfiltration (leaking system prompt, secrets, tokens)
- Indirect injection markers in retrieved knowledge content
"""

import re
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class InjectionType(StrEnum):
    NONE = "none"
    DIRECT_INSTRUCTION = "direct_instruction"
    ROLE_OVERRIDE = "role_override"
    TOOL_HIJACK = "tool_hijack"
    DATA_EXFILTRATION = "data_exfiltration"
    INDIRECT_KNOWLEDGE = "indirect_knowledge"


class RiskLevel(StrEnum):
    """Risk levels aligned with the L0-L4 governance system."""
    L0 = "L0"  # Normal input, no action needed
    L1 = "L1"  # Suspicious, log and monitor
    L2 = "L2"  # Likely injection, write tools require approval
    L3 = "L3"  # Clear injection, block execution
    L4 = "L4"  # Severe (data exfil / system prompt leak), block + alert


# ---------------------------------------------------------------------------
# Direct injection patterns (Chinese + English)
# Each tuple: (regex, injection_type)
# ---------------------------------------------------------------------------
_DIRECT_PATTERNS: list[tuple[str, InjectionType]] = [
    # --- Direct instruction override ---
    (r"忽略(所有|全部|以上|之前|前面|先前|上述|这些|所有的|一切).{0,12}(指令|规则|要求|指示|限制|约束|prompt|system|系统提示)", InjectionType.DIRECT_INSTRUCTION),
    (r"忽略(规则|限制|约束|指令|要求|系统提示)", InjectionType.DIRECT_INSTRUCTION),
    (r"无视(所有|以上|之前|这些|规则|限制|指令).{0,8}(指令|规则|要求)?", InjectionType.DIRECT_INSTRUCTION),
    (r"不要(遵守|管|理会|遵循).{0,8}(之前|以上|上述|这些|所有).{0,6}(指令|规则|限制)", InjectionType.DIRECT_INSTRUCTION),
    (r"打破(规则|限制|约束)", InjectionType.DIRECT_INSTRUCTION),
    (r"解除(所有|全部)?(限制|约束|规则)", InjectionType.DIRECT_INSTRUCTION),
    (r"ignore\s+(all\s+)?(previous|above|prior|preceding)\s+(instructions?|rules?|prompts?|directives?)", InjectionType.DIRECT_INSTRUCTION),
    (r"disregard\s+(all\s+)?(previous|above|prior)\s+(instructions?|rules?)", InjectionType.DIRECT_INSTRUCTION),
    (r"forget\s+(all\s+)?(previous|above)\s+(instructions?|rules?)", InjectionType.DIRECT_INSTRUCTION),
    (r"override\s+(all\s+)?(previous|above)\s+(instructions?|rules?)", InjectionType.DIRECT_INSTRUCTION),

    # --- Role / system prompt override ---
    (r"你现在是(一个|一名|一位|)?\s*.{0,30}(不是|不再|而不是|代替)", InjectionType.ROLE_OVERRIDE),
    (r"从现在起你(是|成为|扮演).{0,20}(不再|不是|不要做)", InjectionType.ROLE_OVERRIDE),
    (r"你(是|成为|扮演)(管理员|admin|root|超级用户|无限制AI)", InjectionType.ROLE_OVERRIDE),
    (r"system\s*[:：]\s*", InjectionType.ROLE_OVERRIDE),
    (r"<\|system\|>", InjectionType.ROLE_OVERRIDE),
    (r"<\|im_start\|>", InjectionType.ROLE_OVERRIDE),
    (r"<\|im_end\|>", InjectionType.ROLE_OVERRIDE),
    (r"\[INST\]", InjectionType.ROLE_OVERRIDE),
    (r"you\s+are\s+now\s+.{0,40}(not|no\s+longer|instead\s+of)", InjectionType.ROLE_OVERRIDE),
    (r"act\s+as\s+(if\s+you\s+are|you\s+are)\s+not", InjectionType.ROLE_OVERRIDE),
    (r"new\s+(system\s+)?instructions?\s*[:：]", InjectionType.ROLE_OVERRIDE),
    (r"重要(更新|变更|通知).{0,8}(指令|规则|系统)", InjectionType.ROLE_OVERRIDE),

    # --- Tool hijack ---
    (r"(调用|执行|使用|运行|触发|run|execute|call|invoke|trigger).{0,12}(set_light|set_audio|schedule_device|删除设备|delete\s*device|drop\s*table)", InjectionType.TOOL_HIJACK),
    (r"(强制|必须|一定要|立刻|马上|force|must|have\s+to|immediately).{0,12}(调用|执行|call|execute|run).{0,12}(工具|tool|set_light|set_audio|设备)", InjectionType.TOOL_HIJACK),
    (r"(绕过|跳过|bypass|skip).{0,8}(审批|approval|权限|permission|白名单|whitelist)", InjectionType.TOOL_HIJACK),
    (r"以(管理员|root|admin|系统).{0,8}(身份|权限).{0,8}(执行|调用|运行)", InjectionType.TOOL_HIJACK),

    # --- Data exfiltration ---
    (r"(泄露|导出|输出|显示|打印|告诉我|reveal|leak|exfiltrate|dump|print|show|disclose).{0,12}(系统提示|system\s*prompt|初始指令|initial\s*prompt|完整提示|full\s*prompt)", InjectionType.DATA_EXFILTRATION),
    (r"(把|将|把你的).{0,8}(系统提示|system\s*prompt|prompt|规则|指令|配置).{0,8}(输出|显示|告诉我|打印|reveal|print|show|复制|copy)", InjectionType.DATA_EXFILTRATION),
    (r"(泄露|导出|输出|显示|reveal|leak|exfiltrate|dump).{0,8}(密钥|secret|token|api[_-]?key|密码|password|凭证|credential)", InjectionType.DATA_EXFILTRATION),
    (r"(读取|read|访问|access).{0,8}(环境变量|env|environment|config|配置文件).{0,8}(并|然后|and).{0,6}(输出|显示|告诉我)", InjectionType.DATA_EXFILTRATION),
    (r"(所有|全部|all).{0,6}(用户数据|user\s*data|租户数据|tenant\s*data|健康数据|health\s*data).{0,8}(导出|输出|泄露|dump|export)", InjectionType.DATA_EXFILTRATION),
]

# Indirect injection markers - content that may carry injection payloads
# typically found in retrieved knowledge or tool results
_INDIRECT_MARKERS: list[str] = [
    r"begin\s+injection",
    r"end\s+injection",
    r"injected\s+content",
    r"---\s*system\s*---",
    r"\[IGNORE\s+PREVIOUS\]",
    r"\[SYSTEM\s+OVERRIDE\]",
    r"<!--\s*system\s*-->",
    r"```\s*system",
]


@dataclass
class GuardResult:
    """Result of input guard evaluation."""
    risk_level: RiskLevel
    injection_type: InjectionType
    detected: bool
    matched_patterns: list[str] = field(default_factory=list)
    blocked: bool = False
    reason: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "riskLevel": self.risk_level.value,
            "injectionType": self.injection_type.value,
            "detected": self.detected,
            "matchedPatterns": self.matched_patterns,
            "blocked": self.blocked,
            "reason": self.reason,
        }


class InputGuard:
    """
    Prompt Injection detector with L0-L4 risk classification.

    Usage:
        guard = InputGuard()
        result = guard.evaluate(input_data, agent_type="device_control")
        if result.blocked:
            raise HTTPException(403, detail=result.reason)
    """

    def __init__(self) -> None:
        self._compiled_direct = [
            (re.compile(pattern, re.IGNORECASE), injection_type)
            for pattern, injection_type in _DIRECT_PATTERNS
        ]
        self._compiled_indirect = [
            re.compile(pattern, re.IGNORECASE)
            for pattern in _INDIRECT_MARKERS
        ]

    def evaluate(self, input_data: dict[str, Any], agent_type: str = "") -> GuardResult:
        """
        Evaluate input for prompt injection and classify risk.

        Args:
            input_data: The agent run input dict.
            agent_type: Agent type string (e.g. "device_control").
                        Device control agents get escalated risk for
                        instruction overrides because write tools are involved.
        """
        text = self._extract_text(input_data)
        matched: list[str] = []
        injection_types: set[InjectionType] = set()

        # Direct injection scan
        for pattern, injection_type in self._compiled_direct:
            if pattern.search(text):
                matched.append(pattern.pattern)
                injection_types.add(injection_type)

        # Indirect injection marker scan
        for pattern in self._compiled_indirect:
            if pattern.search(text):
                matched.append(pattern.pattern)
                injection_types.add(InjectionType.INDIRECT_KNOWLEDGE)

        if not matched:
            return GuardResult(
                risk_level=RiskLevel.L0,
                injection_type=InjectionType.NONE,
                detected=False,
                reason="No injection patterns detected",
            )

        # --- Risk classification by injection type ---

        # L4: Data exfiltration = hard block + alert
        if InjectionType.DATA_EXFILTRATION in injection_types:
            return GuardResult(
                risk_level=RiskLevel.L4,
                injection_type=InjectionType.DATA_EXFILTRATION,
                detected=True,
                matched_patterns=matched,
                blocked=True,
                reason="Data exfiltration attempt detected (system prompt / secrets / bulk data). Run blocked and security alert triggered.",
            )

        # L3: Tool hijack = block write execution
        if InjectionType.TOOL_HIJACK in injection_types:
            return GuardResult(
                risk_level=RiskLevel.L3,
                injection_type=InjectionType.TOOL_HIJACK,
                detected=True,
                matched_patterns=matched,
                blocked=True,
                reason="Tool hijack attempt detected (forced write tool / approval bypass / privilege escalation). Write execution blocked.",
            )

        # L2/L3: Direct instruction or role override
        if InjectionType.DIRECT_INSTRUCTION in injection_types or InjectionType.ROLE_OVERRIDE in injection_types:
            primary = (
                InjectionType.DIRECT_INSTRUCTION
                if InjectionType.DIRECT_INSTRUCTION in injection_types
                else InjectionType.ROLE_OVERRIDE
            )
            # Device control agents: escalate to L3 because write tools are in play
            if agent_type == "device_control":
                return GuardResult(
                    risk_level=RiskLevel.L3,
                    injection_type=primary,
                    detected=True,
                    matched_patterns=matched,
                    blocked=True,
                    reason=f"Instruction override ({primary.value}) detected on device-control agent. Run blocked to prevent unauthorized device writes.",
                )
            return GuardResult(
                risk_level=RiskLevel.L2,
                injection_type=primary,
                detected=True,
                matched_patterns=matched,
                blocked=False,
                reason=f"Instruction override ({primary.value}) detected. Read-only tools permitted; all write tools require explicit human approval.",
            )

        # L1: Indirect knowledge injection = monitor only
        if InjectionType.INDIRECT_KNOWLEDGE in injection_types:
            return GuardResult(
                risk_level=RiskLevel.L1,
                injection_type=InjectionType.INDIRECT_KNOWLEDGE,
                detected=True,
                matched_patterns=matched,
                blocked=False,
                reason="Indirect injection marker detected in retrieved content. Knowledge treated as untrusted data; monitoring enabled.",
            )

        # Fallback: L1 monitoring
        return GuardResult(
            risk_level=RiskLevel.L1,
            injection_type=InjectionType.NONE,
            detected=True,
            matched_patterns=matched,
            blocked=False,
            reason="Suspicious patterns detected. Monitoring enabled.",
        )

    def evaluate_text(self, text: str, agent_type: str = "") -> GuardResult:
        """Evaluate raw text string for injection."""
        return self.evaluate({"question": text, "transcript": text}, agent_type)

    def evaluate_knowledge_chunk(self, text: str) -> GuardResult:
        """
        Evaluate a retrieved knowledge chunk for indirect injection.
        Used by the RAG pipeline before content enters the model context.
        """
        matched: list[str] = []
        for pattern in self._compiled_indirect:
            if pattern.search(text):
                matched.append(pattern.pattern)
        # Also scan for direct patterns embedded in knowledge
        for pattern, injection_type in self._compiled_direct:
            if pattern.search(text):
                matched.append(pattern.pattern)

        if not matched:
            return GuardResult(
                risk_level=RiskLevel.L0,
                injection_type=InjectionType.NONE,
                detected=False,
                reason="Knowledge chunk clean",
            )
        return GuardResult(
            risk_level=RiskLevel.L1,
            injection_type=InjectionType.INDIRECT_KNOWLEDGE,
            detected=True,
            matched_patterns=matched,
            blocked=False,
            reason="Indirect injection marker found in knowledge chunk. Content flagged as untrusted and will not be executed as instructions.",
        )

    @staticmethod
    def _extract_text(input_data: dict[str, Any]) -> str:
        """Recursively extract all string content from input for scanning."""
        parts: list[str] = []

        def _walk(value: Any) -> None:
            if isinstance(value, str):
                parts.append(value)
            elif isinstance(value, dict):
                for v in value.values():
                    _walk(v)
            elif isinstance(value, list):
                for item in value:
                    _walk(item)

        _walk(input_data)
        return " ".join(parts)


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------
_default_guard: InputGuard | None = None


def get_input_guard() -> InputGuard:
    global _default_guard
    if _default_guard is None:
        _default_guard = InputGuard()
    return _default_guard


def guard_input(input_data: dict[str, Any], agent_type: str = "") -> GuardResult:
    """Convenience: evaluate input with the default guard singleton."""
    return get_input_guard().evaluate(input_data, agent_type)


def guard_knowledge_chunk(text: str) -> GuardResult:
    """Convenience: evaluate a knowledge chunk with the default guard."""
    return get_input_guard().evaluate_knowledge_chunk(text)
