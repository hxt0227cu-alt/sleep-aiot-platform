import argparse
import asyncio
import json
import math
import statistics
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, uuid5

import httpx


TERMINAL_STATUSES = {"succeeded", "failed", "cancelled"}
AGENT_TYPES = (
    "sleep_report",
    "sleep_improvement",
    "voice_companion",
    "algorithm_optimization",
)


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1))
    return round(ordered[index], 2)


def workload_payload(index: int) -> dict[str, Any]:
    agent_type = AGENT_TYPES[index % len(AGENT_TYPES)]
    device_id = f"load-device-{index % 10_000:05d}"
    inputs = {
        "sleep_report": {
            "device_id": device_id,
            "allowed_device_ids": [device_id],
            "user_segment": "employee" if index % 2 == 0 else "student",
        },
        "sleep_improvement": {
            "device_id": device_id,
            "allowed_device_ids": [device_id],
            "window_days": 28,
        },
        "voice_companion": {"transcript": "今晚压力有点大，想做一个简短的睡前放松。"},
        "algorithm_optimization": {"cohort_id": f"synthetic-cohort-{index % 20:02d}"},
    }
    return {
        "tenant_id": "11111111-1111-4111-8111-111111111111",
        "user_id": str(uuid5(NAMESPACE_URL, f"sleep-agent-load-user-{index}")),
        "agent_type": agent_type,
        "input": inputs[agent_type],
        "workflow_version": "qwen-load-v1",
    }


async def create_run(
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    base_url: str,
    index: int,
    ramp_seconds: float,
    request_count: int,
) -> dict[str, Any]:
    if ramp_seconds > 0:
        await asyncio.sleep(ramp_seconds * index / max(request_count, 1))
    payload = workload_payload(index)
    started = time.perf_counter()
    try:
        async with semaphore:
            response = await client.post(f"{base_url}/v1/runs", json=payload)
        elapsed_ms = (time.perf_counter() - started) * 1000
        body = response.json() if response.content else {}
        return {
            "httpStatus": response.status_code,
            "latencyMs": elapsed_ms,
            "startedMonotonic": started,
            "runId": body.get("run_id"),
            "status": body.get("status"),
            "agentType": payload["agent_type"],
            "error": body.get("detail") if response.status_code >= 400 else None,
        }
    except Exception as error:
        return {
            "httpStatus": 0,
            "latencyMs": (time.perf_counter() - started) * 1000,
            "startedMonotonic": started,
            "runId": None,
            "status": "network_error",
            "agentType": payload["agent_type"],
            "error": type(error).__name__,
        }


async def wait_for_terminal(
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    base_url: str,
    created: dict[str, Any],
    deadline: float,
    poll_interval: float,
) -> dict[str, Any]:
    while time.monotonic() < deadline:
        try:
            async with semaphore:
                response = await client.get(
                    f"{base_url}/v1/runs/{created['runId']}",
                    headers={"x-tenant-id": "11111111-1111-4111-8111-111111111111"},
                )
            if response.status_code == 200:
                body = response.json()
                if body.get("status") in TERMINAL_STATUSES:
                    model = (body.get("output") or {}).get("model") or {}
                    return {
                        **created,
                        "terminalStatus": body["status"],
                        "completionLatencyMs": (
                            time.perf_counter() - created["startedMonotonic"]
                        ) * 1000,
                        "modelProvider": model.get("provider"),
                        "modelOutcome": model.get("outcome"),
                        "promptTokens": int(model.get("promptTokens") or 0),
                        "completionTokens": int(model.get("completionTokens") or 0),
                        "terminalError": body.get("error"),
                    }
        except (httpx.HTTPError, ValueError):
            pass
        await asyncio.sleep(poll_interval)
    return {
        **created,
        "terminalStatus": "poll_timeout",
        "completionLatencyMs": (
            time.perf_counter() - created["startedMonotonic"]
        ) * 1000,
        "modelProvider": None,
        "modelOutcome": None,
        "promptTokens": 0,
        "completionTokens": 0,
        "terminalError": "terminal deadline exceeded",
    }


async def execute(args: argparse.Namespace) -> dict[str, Any]:
    limits = httpx.Limits(
        max_connections=max(args.admission_concurrency, args.poll_concurrency),
        max_keepalive_connections=max(args.admission_concurrency, args.poll_concurrency),
    )
    timeout = httpx.Timeout(args.http_timeout)
    admission_semaphore = asyncio.Semaphore(args.admission_concurrency)
    poll_semaphore = asyncio.Semaphore(args.poll_concurrency)
    test_started = time.perf_counter()
    async with httpx.AsyncClient(timeout=timeout, limits=limits) as client:
        created = await asyncio.gather(*[
            create_run(
                client,
                admission_semaphore,
                args.base_url,
                index,
                args.ramp_seconds,
                args.requests,
            )
            for index in range(args.requests)
        ])
        accepted = [item for item in created if item["httpStatus"] == 202 and item["runId"]]
        deadline = time.monotonic() + args.completion_timeout
        completed = await asyncio.gather(*[
            wait_for_terminal(
                client,
                poll_semaphore,
                args.base_url,
                item,
                deadline,
                args.poll_interval,
            )
            for item in accepted
        ])
    duration = time.perf_counter() - test_started
    admission_latencies = [item["latencyMs"] for item in created]
    completion_latencies = [item["completionLatencyMs"] for item in completed]
    status_counts = Counter(str(item["httpStatus"]) for item in created)
    terminal_counts = Counter(item["terminalStatus"] for item in completed)
    model_outcomes = Counter(item["modelOutcome"] or "none" for item in completed)
    return {
        "classification": "billable_external_model_synthetic_load",
        "syntheticTraffic": True,
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "workload": {
            "requests": args.requests,
            "admissionConcurrency": args.admission_concurrency,
            "pollConcurrency": args.poll_concurrency,
            "rampSeconds": args.ramp_seconds,
            "agentMix": list(AGENT_TYPES),
        },
        "results": {
            "accepted": len(accepted),
            "httpStatusCounts": dict(status_counts),
            "terminalStatusCounts": dict(terminal_counts),
            "modelOutcomeCounts": dict(model_outcomes),
            "durationSeconds": round(duration, 2),
            "admissionThroughputRps": round(len(accepted) / duration, 2) if duration else None,
            "admissionLatencyMs": {
                "p50": percentile(admission_latencies, 0.50),
                "p95": percentile(admission_latencies, 0.95),
                "p99": percentile(admission_latencies, 0.99),
            },
            "completionLatencyMs": {
                "mean": round(statistics.mean(completion_latencies), 2) if completion_latencies else None,
                "p50": percentile(completion_latencies, 0.50),
                "p95": percentile(completion_latencies, 0.95),
                "p99": percentile(completion_latencies, 0.99),
            },
            "tokens": {
                "prompt": sum(item["promptTokens"] for item in completed),
                "completion": sum(item["completionTokens"] for item in completed),
            },
        },
        "limitations": [
            "Traffic is synthetic and does not prove production availability or real-user quality.",
            "Provider quota, network path, service replicas, and configuration must be recorded with the result.",
            "A 10,000-task run is distinct from 10,000 simultaneous provider requests.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run a billable four-Agent load against the Agent Service."
    )
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--requests", type=int, default=100)
    parser.add_argument("--admission-concurrency", type=int, default=100)
    parser.add_argument("--poll-concurrency", type=int, default=200)
    parser.add_argument("--ramp-seconds", type=float, default=30)
    parser.add_argument("--completion-timeout", type=float, default=300)
    parser.add_argument("--poll-interval", type=float, default=0.5)
    parser.add_argument("--http-timeout", type=float, default=30)
    parser.add_argument("--output")
    parser.add_argument(
        "--allow-billable",
        action="store_true",
        help="Required acknowledgement that the target may call a paid external model.",
    )
    args = parser.parse_args()
    if not args.allow_billable:
        parser.error("--allow-billable is required because this test can incur model charges")
    for name in ("requests", "admission_concurrency", "poll_concurrency"):
        if getattr(args, name) < 1:
            parser.error(f"--{name.replace('_', '-')} must be at least 1")
    report = asyncio.run(execute(args))
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(rendered + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
