from datetime import datetime, timezone
from enum import StrEnum
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, model_validator


class AgentType(StrEnum):
    SLEEP_ANALYSIS = "sleep_analysis"
    KNOWLEDGE_ANSWER = "knowledge_answer"
    DEVICE_CONTROL = "device_control"
    OPS_DIAGNOSIS = "ops_diagnosis"
    SLEEP_REPORT = "sleep_report"
    SLEEP_IMPROVEMENT = "sleep_improvement"
    VOICE_COMPANION = "voice_companion"
    ALGORITHM_OPTIMIZATION = "algorithm_optimization"


class RunStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    WAITING_APPROVAL = "waiting_approval"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class RunBudget(BaseModel):
    max_steps: int = Field(default=12, ge=1, le=100)
    max_duration_seconds: float = Field(default=90, gt=0, le=900)
    max_input_tokens: int = Field(default=12000, ge=128, le=1_000_000)
    max_output_tokens: int = Field(default=1200, ge=64, le=100_000)
    max_tool_calls: int = Field(default=8, ge=0, le=100)


class RuntimeContext(BaseModel):
    tenant_id: UUID
    user_id: UUID
    session_id: UUID | None = None
    trace_id: UUID = Field(default_factory=uuid4)
    correlation_id: str = Field(default="", max_length=160)
    context_version: str = Field(default="context.v1", max_length=80)


class CapabilitySnapshot(BaseModel):
    workflow_version: str = Field(max_length=80)
    prompt_version: str = Field(default="prompt.v1", max_length=80)
    policy_version: str = Field(default="policy.v1", max_length=80)
    toolset_version: str = Field(default="tools.v1", max_length=80)
    context_version: str = Field(default="context.v1", max_length=80)
    allowed_tools: list[str] = Field(default_factory=list)
    write_requires_approval: bool = True


class CreateRunRequest(BaseModel):
    run_id: UUID | None = None
    tenant_id: UUID
    user_id: UUID
    agent_type: AgentType
    input: dict[str, Any] = Field(default_factory=dict)
    workflow_version: str = Field(default="v1", max_length=80)
    priority: int = Field(default=50, ge=0, le=100)
    session_id: UUID | None = None
    budget: RunBudget = Field(default_factory=RunBudget)
    correlation_id: str | None = Field(default=None, min_length=1, max_length=160)


class AgentRun(BaseModel):
    run_id: UUID = Field(default_factory=uuid4)
    tenant_id: UUID
    user_id: UUID
    agent_type: AgentType
    workflow_version: str
    status: RunStatus = RunStatus.QUEUED
    input: dict[str, Any]
    session_id: UUID | None = None
    correlation_id: str | None = Field(default=None, min_length=1, max_length=160)
    runtime_context: RuntimeContext | None = None
    budget: RunBudget = Field(default_factory=RunBudget)
    capabilities: CapabilitySnapshot | None = None
    output: dict[str, Any] | None = None
    steps: list[str] = Field(default_factory=list)
    trace: list[dict[str, Any]] = Field(default_factory=list)
    error: str | None = None
    attempts: int = 0
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    @model_validator(mode="after")
    def populate_runtime_context(self) -> "AgentRun":
        if self.runtime_context is None:
            self.runtime_context = RuntimeContext(
                tenant_id=self.tenant_id,
                user_id=self.user_id,
                session_id=self.session_id,
                trace_id=self.run_id,
                correlation_id=self.correlation_id or str(self.run_id),
            )
        elif not self.runtime_context.correlation_id:
            self.runtime_context.correlation_id = self.correlation_id or str(self.run_id)
        return self


class TraceCapabilityVersions(BaseModel):
    workflow_version: str
    prompt_version: str
    policy_version: str
    toolset_version: str
    context_version: str


class TraceToolCall(BaseModel):
    at: datetime
    tool: str
    outcome: str
    source: str | None = None
    replayed: bool = False


class TraceModelUsage(BaseModel):
    provider: str
    model: str
    decision: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    fallback: bool = False


class AgentTraceView(BaseModel):
    run_id: UUID
    trace_id: UUID
    correlation_id: str
    tenant_id: UUID
    agent_type: AgentType
    status: RunStatus
    attempts: int
    duration_ms: int
    approval_required: bool
    evidence: str | None = None
    error_code: str | None = None
    privacy_mode: str = "metadata_only"
    capability_versions: TraceCapabilityVersions
    tool_calls: list[TraceToolCall] = Field(default_factory=list)
    model_usage: TraceModelUsage | None = None
    created_at: datetime
    updated_at: datetime


class PreferenceMemoryCreate(BaseModel):
    tenant_id: UUID
    user_id: UUID
    preference_key: str = Field(min_length=1, max_length=120, pattern=r"^[a-z0-9_.-]+$")
    value: dict[str, Any]
    source: str = Field(min_length=1, max_length=120)
    purpose: str = Field(min_length=1, max_length=240)
    consent_id: str = Field(min_length=1, max_length=160)
    expires_at: datetime


class PreferenceMemory(PreferenceMemoryCreate):
    memory_id: UUID = Field(default_factory=uuid4)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    deleted_at: datetime | None = None


class WorkspaceArtifactCreate(BaseModel):
    tenant_id: UUID
    user_id: UUID
    session_id: UUID
    artifact_key: str = Field(min_length=1, max_length=160, pattern=r"^[a-zA-Z0-9_.\/-]+$")
    artifact_type: str = Field(min_length=1, max_length=80)
    content: dict[str, Any]
    source: str = Field(min_length=1, max_length=120)
    purpose: str = Field(min_length=1, max_length=240)
    expires_at: datetime


class WorkspaceArtifact(WorkspaceArtifactCreate):
    artifact_id: UUID = Field(default_factory=uuid4)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    deleted_at: datetime | None = None
