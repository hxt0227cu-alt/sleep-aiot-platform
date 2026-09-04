from uuid import uuid4

import pytest

from app.graph import execute_bounded_graph
from app.models import AgentRun, AgentType
from app.policy import allowed_tools


def make_run(agent_type: AgentType, input_data: dict) -> AgentRun:
    return AgentRun(
        tenant_id=uuid4(),
        user_id=uuid4(),
        agent_type=agent_type,
        workflow_version="business-v1",
        input=input_data,
    )


@pytest.mark.asyncio
async def test_sleep_report_returns_calm_non_diagnostic_contract():
    run = make_run(
        AgentType.SLEEP_REPORT,
        {
            "device_id": "sim-report",
            "allowed_device_ids": ["sim-report"],
            "user_segment": "employee",
        },
    )
    result = await execute_bounded_graph(run)

    report = result.output["businessResult"]
    assert result.status == "succeeded"
    assert report["contractVersion"] == "sleep-report.v1"
    assert report["tone"] == "calm_positive"
    assert 1 <= len(report["recommendations"]) <= 2
    assert "不构成医疗诊断" in report["disclaimer"]


@pytest.mark.asyncio
async def test_sleep_improvement_returns_21_day_three_phase_plan():
    run = make_run(
        AgentType.SLEEP_IMPROVEMENT,
        {
            "device_id": "sim-plan",
            "allowed_device_ids": ["sim-plan"],
            "window_days": 21,
        },
    )
    result = await execute_bounded_graph(run)

    plan = result.output["businessResult"]
    assert result.status == "succeeded"
    assert plan["contractVersion"] == "sleep-improvement.v1"
    assert plan["durationDays"] == 21
    assert [phase["days"] for phase in plan["phases"]] == ["1-7", "8-14", "15-21"]
    assert result.output["toolResults"][0]["result"]["windowDays"] == 21


@pytest.mark.asyncio
async def test_voice_companion_escalates_crisis_and_redacts_transcript():
    run = make_run(
        AgentType.VOICE_COMPANION,
        {"transcript": "我不想活了，也不知道该怎么办"},
    )
    result = await execute_bounded_graph(run)

    companion = result.output["businessResult"]
    assert result.status == "succeeded"
    assert companion["riskLevel"] == "crisis"
    assert companion["requiresImmediateSupport"] is True
    assert "medicalDiagnosis" not in companion
    assert result.output["safety"] == {
        "contentDomain": "sleep_wellness",
        "medicalUseProhibited": True,
    }
    assert run.trace[0]["arguments"]["transcript"] == "[REDACTED]"


@pytest.mark.asyncio
async def test_algorithm_agent_is_read_only_and_requires_human_approval():
    run = make_run(
        AgentType.ALGORITHM_OPTIMIZATION,
        {"cohort_id": "employee-opt-in-a"},
    )
    result = await execute_bounded_graph(run)

    proposal = result.output["businessResult"]
    assert result.status == "succeeded"
    assert proposal["requiresHumanApproval"] is True
    assert proposal["autoPublish"] is False
    assert "set_light" not in allowed_tools(AgentType.ALGORITHM_OPTIMIZATION)
    assert result.output["allowedTools"] == ["get_intervention_effects"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "agent_type,input_data",
    [
        (
            AgentType.SLEEP_REPORT,
            {
                "device_id": "sim-1",
                "allowed_device_ids": ["sim-1"],
                "heart_rate_series": [60, 61, 62],
            },
        ),
        (
            AgentType.ALGORITHM_OPTIMIZATION,
            {"cohort_id": "cohort-a", "radar_samples": [1, 2, 3]},
        ),
    ],
)
async def test_business_agents_reject_raw_health_fields(agent_type, input_data):
    result = await execute_bounded_graph(make_run(agent_type, input_data))
    assert result.status == "failed"
    assert "raw health fields are not accepted" in result.error


@pytest.mark.asyncio
async def test_improvement_agent_rejects_invalid_feature_window():
    result = await execute_bounded_graph(
        make_run(
            AgentType.SLEEP_IMPROVEMENT,
            {
                "device_id": "sim-1",
                "allowed_device_ids": ["sim-1"],
                "window_days": 7,
            },
        )
    )
    assert result.status == "failed"
    assert result.error == "window_days must be between 14 and 28"
