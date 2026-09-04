import argparse
import asyncio
import json
import math
import platform
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import httpx


def percentile(values: list[float], percentile_value: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, math.ceil(percentile_value * len(ordered)) - 1)
    return ordered[max(index, 0)]


async def run_request(
    client: httpx.AsyncClient,
    semaphore: asyncio.Semaphore,
    base_url: str,
    index: int,
) -> tuple[float, int, str]:
    payload = {
        "tenant_id": "11111111-1111-4111-8111-111111111111",
        "user_id": str(uuid4()),
        "agent_type": "sleep_analysis",
        "input": {"question": f"synthetic sleep trend request {index}"},
        "workflow_version": "v1",
    }
    async with semaphore:
        started = time.perf_counter()
        response = await client.post(f"{base_url}/v1/runs", json=payload)
        elapsed_ms = (time.perf_counter() - started) * 1000
        body = response.json() if response.content else {}
        status_value = body.get("status", "invalid")
        return elapsed_ms, response.status_code, status_value


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--requests", type=int, default=1000)
    parser.add_argument("--concurrency", type=int, default=100)
    parser.add_argument("--output")
    args = parser.parse_args()

    semaphore = asyncio.Semaphore(args.concurrency)
    timeout = httpx.Timeout(30)
    started = time.perf_counter()
    async with httpx.AsyncClient(timeout=timeout) as client:
        results = await asyncio.gather(
            *[
                run_request(client, semaphore, args.base_url, index)
                for index in range(args.requests)
            ],
            return_exceptions=True,
        )
    duration = time.perf_counter() - started

    successful = [
        result
        for result in results
        if not isinstance(result, BaseException)
        and result[1] == 202
        and result[2] in {"queued", "running", "succeeded"}
    ]
    latencies = [result[0] for result in successful]
    errors = args.requests - len(successful)
    report = {
        "classification": "local_in_memory_agent_admission",
        "syntheticTraffic": True,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "system": {
            "platform": platform.platform(),
            "python": platform.python_version(),
        },
        "workload": {
            "requests": args.requests,
            "concurrency": args.concurrency,
            "agentType": "sleep_analysis",
        },
        "results": {
            "successful": len(successful),
            "errors": errors,
            "errorRate": errors / args.requests,
            "durationSeconds": round(duration, 4),
            "throughputRps": round(len(successful) / duration, 2),
            "latencyMs": {
                "mean": round(statistics.mean(latencies), 2) if latencies else None,
                "p50": round(percentile(latencies, 0.50), 2) if latencies else None,
                "p95": round(percentile(latencies, 0.95), 2) if latencies else None,
                "p99": round(percentile(latencies, 0.99), 2) if latencies else None,
                "max": round(max(latencies), 2) if latencies else None,
            },
        },
        "limitations": [
            "Agent state and queue are process memory, not PostgreSQL or Temporal.",
            "Latency measures admission only, not workflow completion.",
            "No LLM, RAG, external tool, durable queue, or GPU latency is included.",
            "This result cannot be used as enterprise production capacity evidence.",
        ],
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    print(rendered)
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(rendered + "\n", encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main())
