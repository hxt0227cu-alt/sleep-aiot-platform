import json
from dataclasses import replace
from types import SimpleNamespace

import pytest

from app.model_gateway import BusinessAgentModelGateway, ModelConfig
from app.models import AgentType


class FakeCompletions:
    def __init__(self, content: str, *, error: Exception | None = None) -> None:
        self.content = content
        self.error = error
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=self.content))],
            usage=SimpleNamespace(prompt_tokens=120, completion_tokens=45),
        )


class FakeClient:
    def __init__(self, completions: FakeCompletions) -> None:
        self.chat = SimpleNamespace(completions=completions)


def config(*, failure_mode: str = "fallback") -> ModelConfig:
    return ModelConfig(
        provider="openai_compatible",
        api_key="test-key",
        base_url="https://example.invalid/v1",
        model="qwen3.6-flash",
        timeout_seconds=1,
        max_concurrency=2,
        max_output_tokens=800,
        failure_mode=failure_mode,
        circuit_breaker_failures=5,
        circuit_breaker_cooldown_seconds=30,
    )


@pytest.mark.asyncio
async def test_knowledge_model_cannot_change_grounded_answer_or_citations():
    completions = FakeCompletions(json.dumps({
        "answer": "Use the retrieved evidence.",
        "citations": [{"id": "model-invented", "text": "fabricated"}],
    }))
    gateway = BusinessAgentModelGateway(config(), FakeClient(completions))
    governed_citations = [{
        "id": "chunk-1",
        "title": "Sleep guide",
        "text": "Keep a stable wake time.",
        "scope": "global",
    }]
    fallback = {
        "contractVersion": "knowledge-answer.v1",
        "answer": "fallback",
        "citations": governed_citations,
        "retrievalStatus": "grounded",
    }

    result, metadata = await gateway.generate(
        AgentType.KNOWLEDGE_ANSWER,
        {"question": "How should I improve sleep regularity?"},
        [{"tool": "search_knowledge", "result": {"citations": governed_citations}}],
        fallback,
    )

    assert result["answer"] == "fallback"
    assert result["citations"] == governed_citations
    assert result["retrievalStatus"] == "grounded"
    assert metadata["outcome"] == "generated"


@pytest.mark.asyncio
async def test_report_uses_model_copy_but_preserves_governed_fields():
    completions = FakeCompletions(json.dumps({
        "summary": "整体节律较稳定，不必因为单晚波动担心。",
        "observations": ["平均睡眠约 7 小时"],
        "recommendations": ["今晚保持相近的上床时间。"],
        "qualityScore": 100,
        "disclaimer": "这是医疗诊断",
    }, ensure_ascii=False))
    gateway = BusinessAgentModelGateway(config(), FakeClient(completions))
    fallback = {
        "contractVersion": "sleep-report.v1",
        "qualityScore": 72,
        "summary": "fallback",
        "observations": [],
        "recommendations": ["fallback"],
        "tone": "calm_positive",
        "disclaimer": "内容仅用于睡眠健康管理，不构成医疗诊断。",
    }

    result, metadata = await gateway.generate(
        AgentType.SLEEP_REPORT,
        {"device_id": "private-device", "user_segment": "employee"},
        [{"tool": "get_sleep_features", "result": {"deviceId": "private-device", "sleepScore": 72}}],
        fallback,
    )

    assert result["summary"].startswith("整体节律")
    assert result["qualityScore"] == 72
    assert "不构成医疗诊断" in result["disclaimer"]
    assert metadata["provider"] == "openai_compatible"
    assert metadata["promptTokens"] == 120
    rendered_prompt = completions.calls[0]["messages"][1]["content"]
    assert "private-device" not in rendered_prompt


@pytest.mark.asyncio
async def test_improvement_requires_exact_three_phase_contract():
    completions = FakeCompletions(json.dumps({
        "phases": [
            {"days": "1-7", "goal": "稳定起床时间", "actions": ["每天固定时间起床"]},
            {"days": "8-14", "goal": "降低睡前刺激", "actions": ["睡前减少屏幕使用"]},
            {"days": "15-21", "goal": "巩固习惯", "actions": ["保留最有效的两个习惯"]},
        ]
    }, ensure_ascii=False))
    gateway = BusinessAgentModelGateway(config(), FakeClient(completions))
    fallback = {
        "contractVersion": "sleep-improvement.v1",
        "durationDays": 21,
        "baseline": {"windowDays": 28},
        "phases": [],
        "reviewCadenceDays": 7,
        "disclaimer": "计划用于生活方式改善，不替代医疗建议。",
    }

    result, _ = await gateway.generate(
        AgentType.SLEEP_IMPROVEMENT,
        {"window_days": 28},
        [{"tool": "get_sleep_features", "result": {"windowDays": 28}}],
        fallback,
    )

    assert [phase["days"] for phase in result["phases"]] == ["1-7", "8-14", "15-21"]
    assert result["durationDays"] == 21


@pytest.mark.asyncio
async def test_crisis_companion_bypasses_external_model():
    completions = FakeCompletions('{"reply":"unsafe replacement"}')
    gateway = BusinessAgentModelGateway(config(), FakeClient(completions))
    fallback = {
        "contractVersion": "voice-companion.v1",
        "riskLevel": "crisis",
        "reply": "请立即联系身边可信任的人和当地急救服务。",
        "requiresImmediateSupport": True,
    }

    result, metadata = await gateway.generate(
        AgentType.VOICE_COMPANION,
        {"transcript": "我不想活了"},
        [{"tool": "moderate_companion_input", "result": {"riskLevel": "crisis"}}],
        fallback,
    )

    assert result == fallback
    assert metadata["outcome"] == "safety_bypass"
    assert completions.calls == []


@pytest.mark.asyncio
async def test_algorithm_model_cannot_remove_approval_or_exceed_bounds():
    completions = FakeCompletions(json.dumps({
        "hypothesis": "小幅减慢衰减可能改善连续性",
        "rationale": "需要灰度实验验证。",
        "recommendedDecayPercentPer2Min": 99,
        "primaryMetric": "unapproved_metric",
        "rollbackWhen": "退出率上升时回滚",
        "requiresHumanApproval": False,
    }, ensure_ascii=False))
    gateway = BusinessAgentModelGateway(config(), FakeClient(completions))
    fallback = {
        "contractVersion": "algorithm-optimization.v1",
        "recommendations": [{
            "hypothesis": "fallback",
            "change": {"whiteNoiseDecayPercentPer2Min": {"from": 5, "to": 4}},
            "primaryMetric": "sleep_continuity_delta",
            "guardrails": ["manual_approval", "5_percent_canary", "no_raw_health_export"],
            "rollbackWhen": "fallback",
        }],
        "requiresHumanApproval": True,
        "autoPublish": False,
    }

    result, _ = await gateway.generate(
        AgentType.ALGORITHM_OPTIMIZATION,
        {"cohort_id": "private-cohort"},
        [{"tool": "get_intervention_effects", "result": {"cohort": "private-cohort", "sampleSize": 500}}],
        fallback,
    )

    recommendation = result["recommendations"][0]
    assert result["requiresHumanApproval"] is True
    assert result["autoPublish"] is False
    assert recommendation["change"]["whiteNoiseDecayPercentPer2Min"]["to"] == 4
    assert recommendation["primaryMetric"] == "sleep_continuity_delta"
    assert "private-cohort" not in completions.calls[0]["messages"][1]["content"]


@pytest.mark.asyncio
async def test_provider_failure_uses_deterministic_fallback_without_error_details():
    completions = FakeCompletions("", error=TimeoutError("secret provider detail"))
    gateway = BusinessAgentModelGateway(config(), FakeClient(completions))
    fallback = {"contractVersion": "sleep-report.v1", "summary": "fallback"}

    result, metadata = await gateway.generate(
        AgentType.SLEEP_REPORT, {}, [], fallback
    )

    assert result == fallback
    assert metadata == {
        "provider": "deterministic_fallback",
        "model": "qwen3.6-flash",
        "outcome": "TimeoutError",
    }
    assert "secret" not in json.dumps(metadata)


@pytest.mark.asyncio
async def test_knowledge_provider_failure_preserves_only_retrieved_facts():
    completions = FakeCompletions("", error=TimeoutError("provider timeout"))
    gateway = BusinessAgentModelGateway(config(), FakeClient(completions))
    citation = {
        "id": "chunk-1",
        "title": "Sleep guide",
        "text": "Keep a stable wake time.",
        "scope": "global",
    }
    fallback = {
        "contractVersion": "knowledge-answer.v1",
        "status": "ready",
        "answer": citation["text"],
        "citations": [citation],
        "grounded": True,
    }

    result, metadata = await gateway.generate(
        AgentType.KNOWLEDGE_ANSWER,
        {"question": "How should I improve sleep regularity?"},
        [{"tool": "search_knowledge", "result": {"citations": [citation]}}],
        fallback,
    )

    assert result == fallback
    assert metadata["provider"] == "deterministic_fallback"


@pytest.mark.asyncio
async def test_unsafe_model_output_is_rejected_and_replaced_with_fallback():
    completions = FakeCompletions(json.dumps({
        "summary": "你患有失眠症，应调整药物剂量。",
        "observations": ["模型臆测"],
        "recommendations": ["不安全建议"],
    }, ensure_ascii=False))
    gateway = BusinessAgentModelGateway(config(), FakeClient(completions))
    fallback = {"contractVersion": "sleep-report.v1", "summary": "安全降级内容"}

    result, metadata = await gateway.generate(
        AgentType.SLEEP_REPORT, {}, [], fallback
    )

    assert result == fallback
    assert metadata["provider"] == "deterministic_fallback"
    assert metadata["outcome"] == "ValueError"


@pytest.mark.asyncio
async def test_circuit_breaker_stops_repeated_provider_calls():
    completions = FakeCompletions("", error=TimeoutError("provider timeout"))
    breaker_config = replace(config(), circuit_breaker_failures=1)
    gateway = BusinessAgentModelGateway(breaker_config, FakeClient(completions))
    fallback = {"contractVersion": "sleep-report.v1", "summary": "fallback"}

    _, first_metadata = await gateway.generate(
        AgentType.SLEEP_REPORT, {}, [], fallback
    )
    _, second_metadata = await gateway.generate(
        AgentType.SLEEP_REPORT, {}, [], fallback
    )

    assert first_metadata["outcome"] == "TimeoutError"
    assert second_metadata["outcome"] == "circuit_open"
    assert len(completions.calls) == 1
