from typing import Any

from .models import AgentType


BUSINESS_AGENT_TYPES = {
    AgentType.KNOWLEDGE_ANSWER,
    AgentType.SLEEP_REPORT,
    AgentType.SLEEP_IMPROVEMENT,
    AgentType.VOICE_COMPANION,
    AgentType.ALGORITHM_OPTIMIZATION,
}

PROHIBITED_RAW_FIELDS = {
    "raw_data",
    "rawData",
    "radar_samples",
    "heart_rate_series",
    "breathing_rate_series",
    "sleep_stage_series",
}


def _find_prohibited_fields(value: Any) -> set[str]:
    if isinstance(value, dict):
        found = PROHIBITED_RAW_FIELDS.intersection(value)
        for nested in value.values():
            found.update(_find_prohibited_fields(nested))
        return found
    if isinstance(value, list):
        found: set[str] = set()
        for nested in value:
            found.update(_find_prohibited_fields(nested))
        return found
    return set()


def validate_business_input(agent_type: AgentType, input_data: dict[str, Any]) -> None:
    if agent_type not in BUSINESS_AGENT_TYPES:
        return

    prohibited = sorted(_find_prohibited_fields(input_data))
    if prohibited:
        raise ValueError(
            f"raw health fields are not accepted: {', '.join(prohibited)}"
        )

    if agent_type in {AgentType.SLEEP_REPORT, AgentType.SLEEP_IMPROVEMENT}:
        device_id = input_data.get("device_id")
        if not isinstance(device_id, str) or not device_id.strip():
            raise ValueError("device_id is required")
        allowed = input_data.get("allowed_device_ids")
        if not isinstance(allowed, list) or device_id not in allowed:
            raise ValueError("device_id must be present in allowed_device_ids")

    if agent_type == AgentType.SLEEP_IMPROVEMENT:
        window_days = input_data.get("window_days", 28)
        if not isinstance(window_days, int) or not 14 <= window_days <= 28:
            raise ValueError("window_days must be between 14 and 28")

    if agent_type == AgentType.VOICE_COMPANION:
        transcript = input_data.get("transcript")
        if not isinstance(transcript, str) or not transcript.strip():
            raise ValueError("transcript is required")
        if len(transcript) > 2000:
            raise ValueError("transcript must not exceed 2000 characters")

    if agent_type == AgentType.ALGORITHM_OPTIMIZATION:
        cohort_id = input_data.get("cohort_id")
        if not isinstance(cohort_id, str) or not cohort_id.strip():
            raise ValueError("cohort_id is required")


def _tool_result(
    tool_results: list[dict[str, Any]], tool_name: str
) -> dict[str, Any]:
    for item in tool_results:
        if item["tool"] == tool_name:
            return item["result"]
    return {}


def _sleep_observations(features: dict[str, Any]) -> list[str]:
    observations: list[str] = []
    duration = features.get("averageDurationMinutes")
    deep_ratio = features.get("deepSleepRatio")
    awakenings = features.get("awakenings")
    if isinstance(duration, (int, float)):
        observations.append(f"近期平均睡眠约 {round(duration / 60, 1)} 小时")
    if isinstance(deep_ratio, (int, float)):
        observations.append(f"深睡占比约 {round(deep_ratio * 100)}%")
    if isinstance(awakenings, int):
        observations.append(f"平均夜间觉醒约 {awakenings} 次")
    return observations


def _sleep_report(
    input_data: dict[str, Any], tool_results: list[dict[str, Any]]
) -> dict[str, Any]:
    features = _tool_result(tool_results, "get_sleep_features")
    if features.get("degraded"):
        return {
            "contractVersion": "sleep-report.v1",
            "status": "insufficient_data",
            "title": "睡眠数据暂不可用",
            "summary": "暂时无法取得聚合睡眠指标，请稍后再试。",
            "observations": [],
            "recommendations": ["今晚先保持熟悉的作息，不需要因一次数据缺失而担心。"],
            "disclaimer": "内容仅用于睡眠健康管理，不构成医疗诊断。",
        }

    score = features.get("sleepScore")
    segment = input_data.get("user_segment", "general")
    segment_copy = {
        "employee": "工作节奏紧张时，稳定作息比追求单晚高分更重要。",
        "student": "学习期间也要给睡眠留出稳定、连续的时间。",
        "general": "关注一到两周趋势，比单晚波动更有参考价值。",
    }.get(segment, "关注一到两周趋势，比单晚波动更有参考价值。")
    return {
        "contractVersion": "sleep-report.v1",
        "status": "ready",
        "title": "昨夜睡眠简报",
        "qualityScore": score if isinstance(score, int) else None,
        "summary": segment_copy,
        "observations": _sleep_observations(features)[:3],
        "recommendations": [
            "今晚尽量在相近时间上床。",
            "睡前 30 分钟减少强光和高强度信息输入。",
        ],
        "tone": "calm_positive",
        "disclaimer": "内容仅用于睡眠健康管理，不构成医疗诊断。",
    }


def _sleep_improvement(
    input_data: dict[str, Any], tool_results: list[dict[str, Any]]
) -> dict[str, Any]:
    features = _tool_result(tool_results, "get_sleep_features")
    if features.get("degraded"):
        return {
            "contractVersion": "sleep-improvement.v1",
            "status": "insufficient_data",
            "message": "需要至少 2 周可用的聚合睡眠数据后再生成计划。",
            "phases": [],
            "disclaimer": "计划用于生活方式改善，不替代医疗建议。",
        }

    return {
        "contractVersion": "sleep-improvement.v1",
        "status": "ready",
        "durationDays": 21,
        "baseline": {
            "windowDays": features.get("windowDays", input_data.get("window_days", 28)),
            "observations": _sleep_observations(features),
        },
        "phases": [
            {
                "days": "1-7",
                "goal": "稳定节律",
                "actions": ["固定起床时间，周末波动不超过 60 分钟", "记录睡前咖啡因和屏幕使用"],
            },
            {
                "days": "8-14",
                "goal": "降低睡前唤醒水平",
                "actions": ["睡前 30 分钟切换为低刺激活动", "完成一次 5 分钟呼吸或身体扫描"],
            },
            {
                "days": "15-21",
                "goal": "巩固有效习惯",
                "actions": ["保留效果最明显的两项习惯", "比较周均趋势，不追逐单晚分数"],
            },
        ],
        "reviewCadenceDays": 7,
        "disclaimer": "计划用于生活方式改善，不替代医疗建议。",
    }


def _voice_companion(tool_results: list[dict[str, Any]]) -> dict[str, Any]:
    moderation = _tool_result(tool_results, "moderate_companion_input")
    risk_level = moderation.get("riskLevel", "normal")
    if risk_level == "crisis":
        reply = (
            "我很在意你现在的安全。请先联系身边可信任的人陪着你，并立即联系当地急救或危机干预服务。"
        )
        fallback = "safety-contact-support-v1"
    elif risk_level == "blocked":
        reply = "这个话题我不能继续展开。我们可以换成安全的呼吸放松或睡前安定练习。"
        fallback = "breathing-4-6-v1"
    else:
        reply = "今晚辛苦了。先不用解决所有事情，跟着缓慢呼吸，把注意力放回身体和当下。"
        fallback = "body-scan-5min-v1"
    return {
        "contractVersion": "voice-companion.v1",
        "status": "ready",
        "riskLevel": risk_level,
        "reply": reply,
        "offlineFallbackId": fallback,
        "requiresImmediateSupport": risk_level == "crisis",
    }


def _algorithm_optimization(tool_results: list[dict[str, Any]]) -> dict[str, Any]:
    effects = _tool_result(tool_results, "get_intervention_effects")
    return {
        "contractVersion": "algorithm-optimization.v1",
        "status": "candidate",
        "cohort": effects.get("cohort"),
        "sampleSize": effects.get("sampleSize"),
        "recommendations": [
            {
                "hypothesis": "对白噪音衰减速度做小幅分组实验可能改善入睡后的连续性",
                "change": {"whiteNoiseDecayPercentPer2Min": {"from": 5, "to": 4}},
                "primaryMetric": "sleep_continuity_delta",
                "guardrails": ["manual_approval", "5_percent_canary", "no_raw_health_export"],
                "rollbackWhen": "连续两个观察窗口效果下降或退出率上升超过 2%",
            }
        ],
        "requiresHumanApproval": True,
        "autoPublish": False,
        "evidence": effects.get("source", "simulated-aggregate"),
    }


def _knowledge_answer(tool_results: list[dict[str, Any]]) -> dict[str, Any]:
    retrieval = _tool_result(tool_results, "search_knowledge")
    citations = retrieval.get("citations") or []
    if retrieval.get("degraded") or not citations:
        return {
            "contractVersion": "knowledge-answer.v1",
            "status": "insufficient_evidence",
            "answer": "当前没有可用的知识证据，暂不生成推断性答案。",
            "citations": [],
            "grounded": False,
        }
    first = citations[0]
    return {
        "contractVersion": "knowledge-answer.v1",
        "status": "ready",
        "answer": str(first.get("text") or "")[:500],
        "citations": [
            {
                key: citation.get(key)
                for key in ("id", "title", "path", "section", "similarity")
                if citation.get(key) is not None
            }
            for citation in citations
        ],
        "grounded": True,
    }


def build_business_result(
    agent_type: AgentType,
    input_data: dict[str, Any],
    tool_results: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if agent_type == AgentType.KNOWLEDGE_ANSWER:
        return _knowledge_answer(tool_results)
    if agent_type == AgentType.SLEEP_REPORT:
        return _sleep_report(input_data, tool_results)
    if agent_type == AgentType.SLEEP_IMPROVEMENT:
        return _sleep_improvement(input_data, tool_results)
    if agent_type == AgentType.VOICE_COMPANION:
        return _voice_companion(tool_results)
    if agent_type == AgentType.ALGORITHM_OPTIMIZATION:
        return _algorithm_optimization(tool_results)
    return None
