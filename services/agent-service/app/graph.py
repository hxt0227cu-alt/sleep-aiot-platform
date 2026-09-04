import asyncio
import json
from datetime import datetime, timezone
from typing import Any, TypedDict

from langgraph.graph import END, StateGraph
from .models import AgentRun, AgentType, RunStatus
from .business_agents import build_business_result, validate_business_input
from .model_gateway import get_model_gateway
from .policy import allowed_tools
from .tools import execute_tool, planned_tools
from .capabilities import snapshot_capabilities


class GraphState(TypedDict):
    agent_type: str
    workflow_version: str
    steps: list[str]
    status: str
    output: dict[str, Any] | None
    approved: bool
    run: AgentRun


def route_node(state: GraphState) -> GraphState:
    return {**state, "steps": [*state["steps"], "route"], "status": "running"}


def policy_node(state: GraphState) -> GraphState:
    agent_type = AgentType(state["agent_type"])
    if agent_type == AgentType.DEVICE_CONTROL and not state["approved"]:
        return {
            **state,
            "steps": [*state["steps"], "approval_required"],
            "status": "waiting_approval",
        }
    suffix = "read_only_policy" if agent_type == AgentType.OPS_DIAGNOSIS else "context_builder"
    return {**state, "steps": [*state["steps"], suffix]}


async def finalize_node(state: GraphState) -> GraphState:
    agent_type = AgentType(state["agent_type"])
    run = state["run"]
    validate_business_input(agent_type, run.input)
    calls = planned_tools(run)
    if len(calls) > run.budget.max_tool_calls:
        raise RuntimeError("run budget exceeded: tool calls")
    results = []
    for tool, arguments in calls:
        results.append({"tool": tool, "result": execute_tool(run, tool, arguments, approved=state["approved"])})
    evidence = "software"
    if any(result["result"].get("degraded") for result in results):
        evidence = "degraded"
    elif any(result["result"].get("source", "").startswith("simulated") for result in results):
        evidence = "simulated"
    output = {
        "message": "Agent run completed with governed tool execution.",
        "allowedTools": sorted(
            allowed_tools(agent_type, approved=state["approved"])
        ),
        "workflowVersion": state["workflow_version"],
        "toolResults": results,
        "traceId": run.runtime_context.correlation_id if run.runtime_context else str(run.run_id),
        "evidence": evidence,
        "capabilityVersions": {
            "promptVersion": run.capabilities.prompt_version,
            "policyVersion": run.capabilities.policy_version,
            "toolsetVersion": run.capabilities.toolset_version,
            "contextVersion": run.capabilities.context_version,
        },
    }
    business_result = build_business_result(agent_type, run.input, results)
    if business_result is not None:
        business_result, model_metadata = await get_model_gateway().generate(
            agent_type,
            run.input,
            results,
            business_result,
            max_output_tokens=run.budget.max_output_tokens,
        )
        output["businessResult"] = business_result
        output["model"] = model_metadata
        prompt_tokens = int(model_metadata.get("promptTokens", 0) or 0)
        completion_tokens = int(model_metadata.get("completionTokens", 0) or 0)
        if prompt_tokens > run.budget.max_input_tokens:
            raise RuntimeError("run budget exceeded: input tokens")
        if completion_tokens > run.budget.max_output_tokens:
            raise RuntimeError("run budget exceeded: output tokens")
        if agent_type == AgentType.VOICE_COMPANION:
            output["safety"] = {
                "contentDomain": "sleep_wellness",
                "medicalUseProhibited": True,
            }
    return {
        **state,
        "steps": [*state["steps"], "response_validation"],
        "status": "succeeded",
        "output": output,
    }


def next_after_policy(state: GraphState) -> str:
    return END if state["status"] == "waiting_approval" else "finalize"


builder = StateGraph(GraphState)
builder.add_node("route", route_node)
builder.add_node("policy", policy_node)
builder.add_node("finalize", finalize_node)
builder.set_entry_point("route")
builder.add_edge("route", "policy")
builder.add_conditional_edges("policy", next_after_policy, {"finalize": "finalize", END: END})
builder.add_edge("finalize", END)
agent_graph = builder.compile()


async def execute_bounded_graph(run: AgentRun, approved: bool = False) -> AgentRun:
    run.attempts += 1
    if run.capabilities is None:
        run.capabilities = snapshot_capabilities(run)
    try:
        estimated_input_tokens = max(
            1, len(json.dumps(run.input, ensure_ascii=False)) // 4
        )
        if estimated_input_tokens > run.budget.max_input_tokens:
            raise RuntimeError("run budget exceeded: estimated input tokens")
        result = await asyncio.wait_for(
            agent_graph.ainvoke({
                "agent_type": run.agent_type.value,
                "workflow_version": run.workflow_version,
                "steps": [],
                "status": RunStatus.QUEUED.value,
                "output": None,
                "approved": approved,
                "run": run,
            }),
            timeout=run.budget.max_duration_seconds,
        )
        if len(result["steps"]) > run.budget.max_steps:
            raise RuntimeError("run budget exceeded: steps")
        run.steps = result["steps"]
        run.status = RunStatus(result["status"])
        run.output = result["output"]
        run.error = None
    except TimeoutError:
        run.status = RunStatus.FAILED
        run.error = "run budget exceeded: duration"
        run.steps = [*run.steps, "budget_exceeded"]
    except Exception as error:
        run.status = RunStatus.FAILED
        run.error = str(error)
        suffix = "budget_exceeded" if "run budget exceeded" in str(error) else "terminal_failure"
        run.steps = [*run.steps, suffix]
    run.updated_at = datetime.now(timezone.utc)
    return run
