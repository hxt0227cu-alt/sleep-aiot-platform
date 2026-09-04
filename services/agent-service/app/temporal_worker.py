import asyncio
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from temporalio import activity, workflow
from temporalio.client import Client
from temporalio.common import RetryPolicy
from temporalio.exceptions import WorkflowAlreadyStartedError
from temporalio.worker import Worker

with workflow.unsafe.imports_passed_through():
    from .graph import execute_bounded_graph
    from .context_compaction import compact_run_output
    from .models import AgentRun, RunStatus
    from .store import create_state_store


def workflow_id(run_id: str) -> str:
    return f"sleep-agent-run-{run_id}"


@activity.defn
async def execute_graph_activity(
    run_payload: dict[str, Any], approved: bool
) -> dict[str, Any]:
    run = AgentRun.model_validate(run_payload)
    result = await execute_bounded_graph(run, approved=approved)
    state_store = create_state_store()
    result = compact_run_output(result, state_store)
    state_store.save(result)
    return result.model_dump(mode="json")


@activity.defn
async def cancel_run_activity(run_payload: dict[str, Any]) -> dict[str, Any]:
    run = AgentRun.model_validate(run_payload)
    run.status = RunStatus.CANCELLED
    run.updated_at = datetime.now(timezone.utc)
    create_state_store().save(run)
    return run.model_dump(mode="json")


@workflow.defn
class AgentRunWorkflow:
    def __init__(self) -> None:
        self._approved = False
        self._cancelled = False
        self._snapshot: dict[str, Any] = {}

    @workflow.signal
    async def approve(self) -> None:
        self._approved = True

    @workflow.signal
    async def cancel(self) -> None:
        self._cancelled = True

    @workflow.query
    def snapshot(self) -> dict[str, Any]:
        return self._snapshot

    @workflow.run
    async def run(self, run_payload: dict[str, Any]) -> dict[str, Any]:
        self._snapshot = run_payload
        result = await self._execute(run_payload, approved=False)
        self._snapshot = result

        if self._cancelled:
            self._snapshot = await self._cancel(result)
            return self._snapshot

        if result.get("status") == RunStatus.WAITING_APPROVAL.value:
            await workflow.wait_condition(lambda: self._approved or self._cancelled)
            if self._cancelled:
                self._snapshot = await self._cancel(result)
                return self._snapshot
            result = await self._execute(result, approved=True)
            self._snapshot = result
        return result

    async def _execute(self, payload: dict[str, Any], approved: bool) -> dict[str, Any]:
        budget = payload.get("budget") or {}
        timeout_seconds = min(float(budget.get("max_duration_seconds", 90)) + 15, 915)
        return await workflow.execute_activity(
            execute_graph_activity,
            args=[payload, approved],
            start_to_close_timeout=timedelta(seconds=timeout_seconds),
            retry_policy=RetryPolicy(
                initial_interval=timedelta(seconds=1),
                maximum_interval=timedelta(seconds=10),
                maximum_attempts=3,
            ),
        )

    async def _cancel(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await workflow.execute_activity(
            cancel_run_activity,
            payload,
            start_to_close_timeout=timedelta(seconds=15),
        )


class TemporalRuntime:
    def __init__(self, client: Client, worker: Worker) -> None:
        self.client = client
        self.worker = worker
        self.worker_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        self.worker_task = asyncio.create_task(self.worker.run())

    async def close(self) -> None:
        await self.worker.shutdown()
        if self.worker_task:
            await asyncio.gather(self.worker_task, return_exceptions=True)

    async def is_healthy(self) -> bool:
        return await self.client.service_client.check_health()

    async def start_run(self, run: AgentRun) -> None:
        try:
            await self.client.start_workflow(
                AgentRunWorkflow.run,
                run.model_dump(mode="json"),
                id=workflow_id(str(run.run_id)),
                task_queue=os.getenv("TEMPORAL_TASK_QUEUE", "sleep-agent-runs"),
            )
        except WorkflowAlreadyStartedError:
            return

    async def approve_run(self, run_id: str) -> None:
        await self.client.get_workflow_handle(workflow_id(run_id)).signal(
            AgentRunWorkflow.approve
        )

    async def cancel_run(self, run_id: str) -> None:
        await self.client.get_workflow_handle(workflow_id(run_id)).signal(
            AgentRunWorkflow.cancel
        )


async def create_temporal_runtime() -> TemporalRuntime:
    client = await Client.connect(
        os.getenv("TEMPORAL_ADDRESS", "127.0.0.1:7233"),
        namespace=os.getenv("TEMPORAL_NAMESPACE", "default"),
    )
    worker = Worker(
        client,
        task_queue=os.getenv("TEMPORAL_TASK_QUEUE", "sleep-agent-runs"),
        workflows=[AgentRunWorkflow],
        activities=[execute_graph_activity, cancel_run_activity],
    )
    return TemporalRuntime(client, worker)


async def main() -> None:
    runtime = await create_temporal_runtime()
    await runtime.worker.run()


if __name__ == "__main__":
    asyncio.run(main())
