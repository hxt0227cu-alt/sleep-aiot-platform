# E3 Alibaba Cloud staging proposal

Status: awaiting owner cost approval

Estimate date: 2026-08-10

This document is a budget proposal, not deployment authorization. No Alibaba
Cloud login, order, resource creation, image push, public IP allocation, or
Temporal Cloud namespace creation may occur until the owner explicitly approves
the current quote and spending ceiling.

## Evidence stages

E3 is split so the first paid exercise does not pretend to prove every managed
service and multi-zone property at once.

| Stage | Purpose | Exit evidence |
| --- | --- | --- |
| E3a, 8 hours | Application recovery on real ACK and RDS | two-node placement, cross-pod operations, pod deletion, one-node drain/replacement, workflow recovery, immutable digests, staging metrics |
| E3b, separate approval | Managed control-plane and data recovery | RDS backup restore/PITR, multi-zone scheduling/failover, Temporal Cloud interruption/recovery |
| E4, separate approval | Production canary | same digests under bounded real traffic, rollback and SLO evidence |

E3a uses only synthetic tenants and deterministic simulated devices. It does not
contain production health data and does not claim Temporal service HA, RDS PITR,
multi-zone HA, or hardware compatibility.

## Proposed E3a resources

Region and zone are selected only after viewing the live quote. Prefer one
mainland China region with two available worker-node zones and private endpoints
for all data services.

| Resource | Proposed quantity/specification | Billing driver |
| --- | --- | --- |
| ACK Pro managed cluster | 1 cluster, Kubernetes supported release | cluster management hours |
| ECS worker | 2 pay-as-you-go nodes, each 4 vCPU/8 GiB, 40 GiB ESSD system disk | instance and disk hours |
| VPC/security group/vSwitch | 1 VPC, 2 vSwitches, least-privilege rules | normally no direct charge |
| RDS PostgreSQL | PostgreSQL 17 standard edition, 1 HA instance, 2 vCPU/4 GiB minimum, 100 GiB ESSD, TimescaleDB + pgvector required, automated backup enabled | instance, storage, backup excess, traffic |
| ACR | 1 private staging namespace/repository; use Personal Edition if its live limits satisfy the test | edition, storage and traffic |
| SLB | 1 staging load balancer, HTTPS listener, 1 Mbps cap, removed after testing | instance/LCU, rules and traffic |
| EIP/NAT | at most 1 EIP and 1 NAT gateway only if private egress cannot reach model/Temporal endpoints | gateway hours, CU and traffic |
| Managed Prometheus/SLS | one ACK integration, short retention, budget alerts | samples, ingestion, storage and query |
| Supporting data pods | Single Redis and ClickHouse plus validation-only Temporal run inside ACK with `emptyDir` and disposable synthetic data | worker capacity only; no supporting-data HA claim |
| DNS/TLS | reuse an approved staging domain/certificate where possible | DNS/certificate charges if newly purchased |

The repository validation Temporal deployment is not production-grade. E3a can
prove application workflow recovery across Agent pods, but cannot prove the
Temporal service itself is highly available.

## Budget estimate and ceiling

Alibaba Cloud prices vary by region, family, availability and billing offer.
The ranges below are conservative planning numbers; the owner must approve the
actual checkout/calculator quote if it differs.

| Cost group | Estimated CNY/hour | Approx. CNY/730-hour month if left running |
| --- | ---: | ---: |
| ACK Pro management | 0.6-0.8 | 440-584 |
| Two 4 vCPU/8 GiB ECS nodes and disks | 1.2-2.8 | 876-2,044 |
| HA RDS PostgreSQL and 100 GiB storage | 1.0-2.5 | 730-1,825 |
| SLB, EIP/NAT, logs and monitoring at test traffic | 0.4-2.0 | 292-1,460 |
| ACR storage/traffic at three small images | 0-0.3 | 0-219 |
| **Estimated total** | **3.2-8.4** | **2,338-6,132** |

Expected E3a runtime is at most 8 hours. The verified baseline is 3.1974 CNY/h
before small SLB, ACR and logging charges; the approved projection is 45 CNY.
The interview-run operational ceiling is **50 CNY**. This is not a
provider-guaranteed hard stop because usage reporting can lag. Controls are:

- owner approval of the live hourly quote before creation;
- resource-count and SKU allowlist matching this document;
- 25 CNY, 35 CNY and 45 CNY budget alerts;
- a 35 CNY optional-test stop and 45 CNY immediate teardown threshold;
- an 8-hour automatic teardown target;
- immediate refusal if the projected 8-hour total exceeds 50 CNY;
- a final zero-resource inventory and next-day billing review.

Temporal Cloud is excluded from the CNY estimate. If E3b uses Temporal Cloud,
it requires separate approval with a **USD 50 maximum test budget** and a fresh
quote. Managed ClickHouse, managed Redis/Tair, multi-zone RDS testing and E4 are
also excluded from E3a and require their own approved delta.

## Validation window

| Time | Activity |
| --- | --- |
| T-1 day, no spend | approve quote, region, SKUs, identities, test IDs, evidence template and rollback |
| T+0 to 1.5 h | provision, push immutable images, apply secrets and migration job |
| T+1.5 to 5 h | smoke, cross-pod, queued/running/approval cancellation and pod deletion tests |
| T+5 to 6.5 h | node drain/replacement, workflow recovery, rollback and evidence export |
| T+6.5 to 8 h | destroy resources, verify inventory and preserve redacted evidence |

One owner and one operator must be present for the paid window. If provisioning
is not healthy by T+2 hours, stop and tear down instead of extending the window.

## Billable operations requiring approval

The following actions may start or increase charges and are prohibited before
explicit approval:

- create or keep an ACK Pro cluster;
- create, start, resize or add ECS worker nodes or disks;
- create or retain an RDS instance, storage, backups or restored/PITR instances;
- allocate an SLB, EIP, NAT gateway, public bandwidth or cross-zone traffic;
- create a paid ACR edition, store images beyond free quota, or transfer images;
- enable paid Prometheus/SLS ingestion, retention, alerts or queries;
- purchase DNS names or certificates;
- create a Temporal Cloud namespace or generate chargeable actions/storage;
- create managed Redis/Tair or ClickHouse instances;
- retain snapshots, backup copies, log stores, disks or public IPs after compute
  teardown.

Building images locally, rendering manifests, running local containers, and
reading public pricing documentation do not create cloud charges.

## Teardown order

1. Stop test submissions and export redacted Kubernetes, Temporal, database and
   monitoring evidence.
2. Delete the application namespace, load balancer Services and ingress; verify
   the cloud SLB is released.
3. Remove worker pools/nodes and the ACK cluster.
4. Delete EIP, NAT gateway and unattached disks/snapshots created for the test.
5. Delete the RDS instance, temporary restore instances and backups not required
   by the approved evidence policy; verify any recycle-bin retention and cost.
6. Delete staging ACR images/repositories if retention is not approved.
7. Delete Prometheus/SLS projects, dashboards and alert resources created for
   the exercise after evidence export.
8. Delete Temporal Cloud namespace/API keys if E3b was separately approved.
9. List all resources by test tags, confirm none remain billable, and review the
   bill again after provider metering has settled.

Teardown scripts must target an explicit staging resource group/tag and refuse
an empty, wildcard, production or unverified target.

## Approval boundary

Approval of this repository commit does not approve spend. Before cloud work,
the operator must present the selected region/SKUs, live hourly estimate,
8-hour projection, current account balance/budget alert configuration, and any
deviation from this resource list. The owner must then explicitly authorize the
paid E3a run.

## Remaining gate execution order

1. Merge this local migration baseline only after CI is green; this clears the
   database bootstrap/adoption prerequisite, not any cloud gate.
2. Obtain explicit owner approval for the selected E3a live quote and 50 CNY
   ceiling. Stop here without that approval.
3. Provision E3a, push the three immutable image digests, run the database
   migration job, and capture the clean Git SHA/resource inventory.
4. Prove two-node placement and cross-replica create/query/approve/cancel, then
   queued/running/waiting-approval pod deletion and cancellation safety.
5. Exercise PostgreSQL/Temporal network interruption, rolling deployment and
   node drain/replacement while recording budget continuity and non-idempotent
   tool execution counts.
6. Review E3a evidence. Fix application defects locally and repeat only the
   failed scenarios under a newly approved paid window.
7. Submit a separate E3b quote for RDS restore/PITR, multi-zone placement and
   Temporal Cloud. Execute those only after separate approval.
8. Start E4 production canary planning only after E3a and E3b claims are green.
   Real hardware remains a separate HIL milestone under ADR-005.
