# Agent and RAG Evaluation Report (8-Dimensional)

**Dataset version:** evaluation-v1
**Evidence type:** simulated
**Total cases:** 84
**Task success rate:** 100.0%

## Eight Dimensions

| # | Dimension | Result |
|---|---|---|
| 1 | Answer correctness | 100.0% |
| 2 | Citation accuracy | 100.0% |
| 3 | Proper refusal rate | 100.0% |
| 4 | Tool selection accuracy | 100.0% |
| 5 | Unauthorized call rate | 0.0000% |
| 6 | Health compliance rate | 71.4% |
| 7 | Latency (p50 / p95) | 2.59ms / 3.8ms |
| 8 | Cost (avg tokens/run) | 237.6 tokens |

## Latency Detail

- p50: 2.59ms
- p95: 3.8ms
- avg: 3.12ms

## Cost Detail

- Total input tokens: 1456
- Total output tokens: 18500
- Total tokens: 19956
- Avg tokens per run: 237.6

## Limitations

- This is a deterministic regression baseline. No external LLM is called,
  so semantic answer quality, model-level injection resistance, and real
  token costs are estimated or out of scope.
- Knowledge retrieval uses a small embedded evaluation corpus rather than
  PostgreSQL/pgvector.
- Device results are explicitly marked `simulated-device`; no physical
  device was used.
- Token costs are rough estimates based on character count, not actual
  tokenizer output.
