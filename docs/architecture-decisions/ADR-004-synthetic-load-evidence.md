# ADR-004: Use reproducible synthetic traffic as capacity evidence

Status: Accepted

## Decision

Use deterministic synthetic users/devices with recorded seeds, workload distributions, ramp, steady state, spikes, hot tenants, reconnect storms, and failure injection. Report measured concurrency and throughput, not converted claims about real production users.

Each result must include source revision, environment, raw output, monitoring evidence, and at least three repetitions. A benchmark that omits these fields is not considered reproducible evidence.

