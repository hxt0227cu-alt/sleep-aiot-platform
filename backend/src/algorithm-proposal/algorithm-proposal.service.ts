import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { TenantService } from '../tenant/tenant.service';

type JsonRecord = Record<string, unknown>;
type ProposalAction =
  'SUBMIT' | 'APPROVE' | 'REJECT' | 'START_CANARY' | 'PROMOTE' | 'ROLLBACK';

const allowedPrimaryMetrics = new Set([
  'sleep_continuity_delta',
  'sleep_onset_latency_delta',
  'wake_after_sleep_onset_delta',
]);

const parameterRanges: Record<string, { min: number; max: number }> = {
  whiteNoiseDecayPercentPer2Min: { min: 1, max: 10 },
  lightDecayPercentPer2Min: { min: 1, max: 20 },
  wakeWindowMinutes: { min: 5, max: 30 },
};

const asRecord = (value: unknown): JsonRecord =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};

@Injectable()
export class AlgorithmProposalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantService,
  ) {}

  private async operator(userId: string, tenantId?: string) {
    const membership = await this.tenants.getMembership(userId, tenantId);
    await this.tenants.requireRole(userId, membership.tenantId, [
      'owner',
      'admin',
    ]);
    return membership;
  }

  async createFromRun(
    userId: string,
    runId: string,
    tenantId?: string,
    requestId?: string,
  ) {
    const membership = await this.operator(userId, tenantId);
    const run = await this.prisma.agentRun.findFirst({
      where: { id: runId, tenantId: membership.tenantId },
    });
    if (!run) throw new NotFoundException('Algorithm Agent run not found');
    if (run.agentType !== 'algorithm_optimization') {
      throw new BadRequestException(
        'Only Algorithm Agent runs can create proposals',
      );
    }
    if (run.status !== 'succeeded') {
      throw new ConflictException(
        'Algorithm Agent run must succeed before proposal creation',
      );
    }

    const output = asRecord(run.output);
    const result = asRecord(output.businessResult);
    const toolResults = Array.isArray(output.toolResults)
      ? output.toolResults
      : [];
    const interventionEvidence = toolResults
      .map((item) => asRecord(item))
      .find((item) => item.tool === 'get_intervention_effects');
    const interventionResult = asRecord(interventionEvidence?.result);
    const recommendations = Array.isArray(result.recommendations)
      ? result.recommendations
      : [];
    const recommendation = asRecord(recommendations[0]);
    const parameterDiff = asRecord(recommendation.change);
    const cohort = result.cohort;
    const sampleSize = result.sampleSize;
    const primaryMetric = recommendation.primaryMetric;
    const hypothesis = recommendation.hypothesis;
    const rollbackCondition = recommendation.rollbackWhen;
    const evidenceRef = result.evidence ?? output.evidence;
    const contractVersion =
      typeof result.contractVersion === 'string'
        ? result.contractVersion
        : 'algorithm-optimization.v1';

    this.validateCandidate({
      cohort,
      sampleSize,
      primaryMetric,
      hypothesis,
      rollbackCondition,
      evidenceRef,
      parameterDiff,
      containsRawHealthData: interventionResult.containsRawHealthData,
    });

    try {
      return await this.prisma.$transaction(async (tx) => {
        const proposal = await tx.algorithmProposal.create({
          data: {
            tenantId: membership.tenantId,
            agentRunId: run.id,
            proposerId: userId,
            status: 'DRAFT',
            workflowVersion: run.workflowVersion,
            policyVersion: contractVersion,
            cohortCriteria: {
              cohortId: String(cohort),
              dataClass: 'aggregate_only',
            },
            parameterDiff: parameterDiff as Prisma.InputJsonObject,
            hypothesis: String(hypothesis),
            rationale: `Based on ${String(evidenceRef)} aggregate evidence from ${Number(sampleSize)} samples.`,
            primaryMetric: String(primaryMetric),
            guardrailMetrics: [
              'opt_out_rate',
              'wake_after_sleep_onset_delta',
              'model_error_rate',
            ],
            sampleSize: Number(sampleSize),
            evidenceRef: String(evidenceRef),
            canaryPercentage: 5,
            rollbackCondition: String(rollbackCondition),
            expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
          },
        });
        await tx.algorithmProposalAction.create({
          data: {
            proposalId: proposal.id,
            tenantId: proposal.tenantId,
            actorId: userId,
            action: 'CREATE',
            toStatus: 'DRAFT',
            version: proposal.version,
            metadata: {
              validator: 'algorithm-policy.v1',
              checks: [
                'aggregate_only',
                'sample_threshold',
                'parameter_compatibility',
                'allowed_metric',
                'fixed_canary_budget',
              ],
            },
          },
        });
        await tx.auditEvent.create({
          data: {
            tenantId: proposal.tenantId,
            userId,
            requestId,
            action: 'algorithm.proposal.create',
            resourceType: 'algorithm_proposal',
            resourceId: proposal.id,
            outcome: 'success',
            metadata: { runId, policyVersion: proposal.policyVersion },
          },
        });
        return proposal;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'A proposal already exists for this Agent run',
        );
      }
      throw error;
    }
  }

  async list(userId: string, tenantId?: string, status?: string) {
    const membership = await this.operator(userId, tenantId);
    return this.prisma.algorithmProposal.findMany({
      where: {
        tenantId: membership.tenantId,
        ...(status ? { status: status.toUpperCase() } : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
  }

  async get(userId: string, proposalId: string, tenantId?: string) {
    const membership = await this.operator(userId, tenantId);
    const proposal = await this.prisma.algorithmProposal.findFirst({
      where: { id: proposalId, tenantId: membership.tenantId },
      include: { actions: { orderBy: { createdAt: 'asc' } } },
    });
    if (!proposal) throw new NotFoundException('Algorithm proposal not found');
    return proposal;
  }

  submit(
    userId: string,
    id: string,
    version: number,
    tenantId?: string,
    reason?: string,
  ) {
    return this.transition(
      userId,
      id,
      version,
      ['DRAFT'],
      'PENDING_REVIEW',
      'SUBMIT',
      tenantId,
      reason,
    );
  }

  approve(
    userId: string,
    id: string,
    version: number,
    tenantId?: string,
    reason?: string,
  ) {
    return this.transition(
      userId,
      id,
      version,
      ['PENDING_REVIEW'],
      'APPROVED',
      'APPROVE',
      tenantId,
      reason,
      true,
    );
  }

  reject(
    userId: string,
    id: string,
    version: number,
    tenantId?: string,
    reason?: string,
  ) {
    return this.transition(
      userId,
      id,
      version,
      ['PENDING_REVIEW'],
      'REJECTED',
      'REJECT',
      tenantId,
      reason,
    );
  }

  startCanary(
    userId: string,
    id: string,
    version: number,
    tenantId?: string,
    reason?: string,
  ) {
    return this.transition(
      userId,
      id,
      version,
      ['APPROVED'],
      'CANARY',
      'START_CANARY',
      tenantId,
      reason,
    );
  }

  promote(
    userId: string,
    id: string,
    version: number,
    tenantId?: string,
    reason?: string,
  ) {
    return this.transition(
      userId,
      id,
      version,
      ['CANARY'],
      'ACTIVE',
      'PROMOTE',
      tenantId,
      reason,
    );
  }

  rollback(
    userId: string,
    id: string,
    version: number,
    tenantId?: string,
    reason?: string,
  ) {
    return this.transition(
      userId,
      id,
      version,
      ['CANARY', 'ACTIVE'],
      'ROLLED_BACK',
      'ROLLBACK',
      tenantId,
      reason,
    );
  }

  private validateCandidate(
    candidate: JsonRecord & { parameterDiff: JsonRecord },
  ) {
    if (typeof candidate.cohort !== 'string' || !candidate.cohort.trim()) {
      throw new BadRequestException('Candidate cohort is missing');
    }
    if (
      !Number.isInteger(candidate.sampleSize) ||
      Number(candidate.sampleSize) < 100
    ) {
      throw new BadRequestException(
        'Candidate sample size must be at least 100',
      );
    }
    if (
      typeof candidate.primaryMetric !== 'string' ||
      !allowedPrimaryMetrics.has(candidate.primaryMetric)
    ) {
      throw new BadRequestException('Candidate primary metric is not allowed');
    }
    if (
      typeof candidate.hypothesis !== 'string' ||
      !candidate.hypothesis.trim()
    ) {
      throw new BadRequestException('Candidate hypothesis is missing');
    }
    if (
      typeof candidate.rollbackCondition !== 'string' ||
      !candidate.rollbackCondition.trim()
    ) {
      throw new BadRequestException('Candidate rollback condition is missing');
    }
    if (
      typeof candidate.evidenceRef !== 'string' ||
      !candidate.evidenceRef.trim()
    ) {
      throw new BadRequestException('Candidate evidence reference is missing');
    }
    if (candidate.containsRawHealthData !== false) {
      throw new BadRequestException(
        'Candidate evidence must be aggregate-only',
      );
    }
    const entries = Object.entries(candidate.parameterDiff);
    if (entries.length === 0)
      throw new BadRequestException('Candidate parameter diff is empty');
    if (entries.length > 3) {
      throw new BadRequestException(
        'Candidate exceeds the three-parameter release budget',
      );
    }
    for (const [parameter, rawChange] of entries) {
      const range = parameterRanges[parameter];
      const change = asRecord(rawChange);
      const from = change.from;
      const to = change.to;
      if (!range || typeof from !== 'number' || typeof to !== 'number') {
        throw new BadRequestException(
          `Candidate parameter ${parameter} is not allowed`,
        );
      }
      if (to < range.min || to > range.max || from === to) {
        throw new BadRequestException(
          `Candidate parameter ${parameter} is outside policy range`,
        );
      }
    }
  }

  private async transition(
    userId: string,
    proposalId: string,
    expectedVersion: number,
    fromStatuses: string[],
    toStatus: string,
    action: ProposalAction,
    tenantId?: string,
    reason?: string,
    separateReviewer = false,
  ) {
    const membership = await this.operator(userId, tenantId);
    const current = await this.prisma.algorithmProposal.findFirst({
      where: { id: proposalId, tenantId: membership.tenantId },
    });
    if (!current) throw new NotFoundException('Algorithm proposal not found');
    if (separateReviewer && current.proposerId === userId) {
      throw new ForbiddenException(
        'Proposal creator cannot approve their own proposal',
      );
    }
    if (!fromStatuses.includes(current.status)) {
      throw new ConflictException(
        `Invalid proposal transition: ${current.status} -> ${toStatus}`,
      );
    }

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.algorithmProposal.updateMany({
        where: {
          id: proposalId,
          tenantId: membership.tenantId,
          status: { in: fromStatuses },
          version: expectedVersion,
        },
        data: {
          status: toStatus,
          version: { increment: 1 },
          ...(action === 'SUBMIT' ? { submittedAt: now } : {}),
          ...(action === 'APPROVE' || action === 'REJECT'
            ? { reviewerId: userId, reviewedAt: now }
            : {}),
          ...(action === 'START_CANARY' ? { canaryStartedAt: now } : {}),
          ...(action === 'PROMOTE' ? { activatedAt: now } : {}),
          ...(action === 'ROLLBACK' ? { rolledBackAt: now } : {}),
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException(
          'Proposal changed; refresh before retrying',
        );
      }
      const version = expectedVersion + 1;
      await tx.algorithmProposalAction.create({
        data: {
          proposalId,
          tenantId: membership.tenantId,
          actorId: userId,
          action,
          fromStatus: current.status,
          toStatus,
          version,
          reason,
          metadata:
            action === 'START_CANARY' ? { canaryPercentage: 5 } : undefined,
        },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: membership.tenantId,
          userId,
          action: `algorithm.proposal.${action.toLowerCase()}`,
          resourceType: 'algorithm_proposal',
          resourceId: proposalId,
          outcome: 'success',
          metadata: { fromStatus: current.status, toStatus, version },
        },
      });
      return tx.algorithmProposal.findUniqueOrThrow({
        where: { id: proposalId },
      });
    });
  }
}
