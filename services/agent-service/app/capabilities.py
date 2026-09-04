from .models import AgentRun, CapabilitySnapshot
from .policy import READ_ONLY_TOOLS, WRITE_TOOLS


POLICY_VERSION = "policy.v2"
TOOLSET_VERSION = "tools.v2"
PROMPT_VERSION = "prompt.v1"


def snapshot_capabilities(run: AgentRun) -> CapabilitySnapshot:
    tools = READ_ONLY_TOOLS.get(run.agent_type, set()) | WRITE_TOOLS.get(
        run.agent_type, set()
    )
    context_version = (
        run.runtime_context.context_version
        if run.runtime_context is not None
        else "context.v1"
    )
    return CapabilitySnapshot(
        workflow_version=run.workflow_version,
        prompt_version=PROMPT_VERSION,
        policy_version=POLICY_VERSION,
        toolset_version=TOOLSET_VERSION,
        context_version=context_version,
        allowed_tools=sorted(tools),
        write_requires_approval=bool(WRITE_TOOLS.get(run.agent_type)),
    )
