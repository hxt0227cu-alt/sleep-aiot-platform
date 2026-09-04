from typing import Any

from .models import AgentType


READ_ONLY_TOOLS = {
    AgentType.SLEEP_ANALYSIS: {"get_sleep_features", "search_knowledge"},
    AgentType.KNOWLEDGE_ANSWER: {"search_knowledge"},
    AgentType.OPS_DIAGNOSIS: {"query_prometheus", "query_logs", "read_runbook"},
    AgentType.SLEEP_REPORT: {"get_sleep_features", "search_knowledge"},
    AgentType.SLEEP_IMPROVEMENT: {"get_sleep_features", "search_knowledge"},
    AgentType.VOICE_COMPANION: {"moderate_companion_input"},
    AgentType.ALGORITHM_OPTIMIZATION: {"get_intervention_effects"},
}

WRITE_TOOLS = {
    AgentType.DEVICE_CONTROL: {"set_light", "set_audio", "schedule_device_action"},
}


def allowed_tools(agent_type: AgentType, approved: bool = False) -> set[str]:
    tools = set(READ_ONLY_TOOLS.get(agent_type, set()))
    if approved:
        tools.update(WRITE_TOOLS.get(agent_type, set()))
    return tools


def validate_tool_call(agent_type: AgentType, tool: str, arguments: dict[str, Any], approved: bool = False) -> None:
    if tool not in allowed_tools(agent_type, approved):
        raise PermissionError(f"tool {tool!r} is not allowed for {agent_type}")
    if tool == "set_light":
        brightness = arguments.get("brightness")
        if brightness is not None and not 0 <= float(brightness) <= 100:
            raise ValueError("brightness must be between 0 and 100")
    if tool == "set_audio":
        volume = arguments.get("volume")
        if volume is not None and not 0 <= float(volume) <= 100:
            raise ValueError("volume must be between 0 and 100")
