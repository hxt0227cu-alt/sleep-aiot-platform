import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { TenantService } from '../tenant/tenant.service';
import { AlgorithmProposalService } from './algorithm-proposal.service';

const firstArgument = <T>(mock: jest.Mock<unknown, unknown[]>): T => {
  const call = mock.mock.calls.at(0);
  if (!call) throw new Error('Expected mock to have been called');
  return call[0] as T;
};

const runOutput = (sampleSize = 240) => ({
  toolResults: [
    {
      tool: 'get_intervention_effects',
      result: { containsRawHealthData: false },
    },
  ],
  businessResult: {
    contractVersion: 'algorithm-optimization.v1',
    cohort: 'employee-opt-in',
    sampleSize,
    evidence: 'aggregate-window-2026-08-01',
    recommendations: [
      {
        hypothesis: 'A slower decay may improve sleep continuity.',
        change: { whiteNoiseDecayPercentPer2Min: { from: 5, to: 4 } },
        primaryMetric: 'sleep_continuity_delta',
        rollbackWhen: 'Rollback when the guardrail degrades for two windows.',
      },
    ],
  },
});

describe('AlgorithmProposalService', () => {
  const proposal = {
    id: 'proposal-1',
    tenantId: 'tenant-1',
    agentRunId: 'run-1',
    proposerId: 'proposer-1',
    reviewerId: null,
    status: 'DRAFT',
    version: 1,
    workflowVersion: 'business-v1',
    policyVersion: 'algorithm-optimization.v1',
  };
  type TransactionCallback = (tx: PrismaMock) => Promise<unknown>;
  type PrismaMock = {
    agentRun: { findFirst: jest.Mock<Promise<unknown>, [unknown]> };
    algorithmProposal: {
      create: jest.Mock<Promise<unknown>, [unknown]>;
      findFirst: jest.Mock<Promise<unknown>, [unknown]>;
      findMany: jest.Mock<Promise<unknown>, [unknown]>;
      updateMany: jest.Mock<Promise<unknown>, [unknown]>;
      findUniqueOrThrow: jest.Mock<Promise<unknown>, [unknown]>;
    };
    algorithmProposalAction: {
      create: jest.Mock<Promise<unknown>, [unknown]>;
    };
    auditEvent: { create: jest.Mock<Promise<unknown>, [unknown]> };
    $transaction: jest.Mock<Promise<unknown>, [TransactionCallback]>;
  };
  type TenantMock = {
    getMembership: jest.Mock<Promise<unknown>, [string, string?]>;
    requireRole: jest.Mock<Promise<unknown>, [string, string, string[]]>;
  };
  let prisma: PrismaMock;
  let tenants: TenantMock;
  let service: AlgorithmProposalService;

  beforeEach(() => {
    prisma = {
      agentRun: { findFirst: jest.fn<Promise<unknown>, [unknown]>() },
      algorithmProposal: {
        create: jest
          .fn<Promise<unknown>, [unknown]>()
          .mockResolvedValue(proposal),
        findFirst: jest.fn<Promise<unknown>, [unknown]>(),
        findMany: jest.fn<Promise<unknown>, [unknown]>(),
        updateMany: jest.fn<Promise<unknown>, [unknown]>(),
        findUniqueOrThrow: jest.fn<Promise<unknown>, [unknown]>(),
      },
      algorithmProposalAction: {
        create: jest.fn<Promise<unknown>, [unknown]>(),
      },
      auditEvent: { create: jest.fn<Promise<unknown>, [unknown]>() },
      $transaction: jest.fn((callback: TransactionCallback) =>
        callback(prisma),
      ),
    };
    tenants = {
      getMembership: jest
        .fn<Promise<unknown>, [string, string?]>()
        .mockResolvedValue({ tenantId: 'tenant-1', role: 'admin' }),
      requireRole: jest
        .fn<Promise<unknown>, [string, string, string[]]>()
        .mockResolvedValue({ tenantId: 'tenant-1', role: 'admin' }),
    };
    service = new AlgorithmProposalService(
      prisma as unknown as PrismaService,
      tenants as unknown as TenantService,
    );
  });

  it('creates a validated draft from a succeeded Algorithm Agent run', async () => {
    prisma.agentRun.findFirst.mockResolvedValue({
      id: 'run-1',
      tenantId: 'tenant-1',
      agentType: 'algorithm_optimization',
      status: 'succeeded',
      workflowVersion: 'business-v1',
      output: runOutput(),
    });

    await expect(service.createFromRun('proposer-1', 'run-1')).resolves.toEqual(
      proposal,
    );
    expect(tenants.requireRole).toHaveBeenCalledWith('proposer-1', 'tenant-1', [
      'owner',
      'admin',
    ]);
    const createInput = firstArgument<{
      data: { status: string; canaryPercentage: number };
    }>(prisma.algorithmProposal.create);
    expect(createInput.data).toMatchObject({
      status: 'DRAFT',
      canaryPercentage: 5,
    });
    const actionInput = firstArgument<{
      data: { action: string };
    }>(prisma.algorithmProposalAction.create);
    expect(actionInput.data.action).toBe('CREATE');
  });

  it('rejects a proposal candidate below the deterministic sample threshold', async () => {
    prisma.agentRun.findFirst.mockResolvedValue({
      id: 'run-1',
      tenantId: 'tenant-1',
      agentType: 'algorithm_optimization',
      status: 'succeeded',
      workflowVersion: 'business-v1',
      output: runOutput(99),
    });

    await expect(
      service.createFromRun('proposer-1', 'run-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.algorithmProposal.create).not.toHaveBeenCalled();
  });

  it('rejects evidence that is not explicitly aggregate-only', async () => {
    const output = runOutput();
    output.toolResults[0].result.containsRawHealthData = true;
    prisma.agentRun.findFirst.mockResolvedValue({
      id: 'run-1',
      tenantId: 'tenant-1',
      agentType: 'algorithm_optimization',
      status: 'succeeded',
      workflowVersion: 'business-v1',
      output,
    });

    await expect(
      service.createFromRun('proposer-1', 'run-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('prevents the proposal creator from approving their own proposal', async () => {
    prisma.algorithmProposal.findFirst.mockResolvedValue({
      ...proposal,
      status: 'PENDING_REVIEW',
    });

    await expect(
      service.approve('proposer-1', proposal.id, 1),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('starts the fixed five percent canary with an immutable action', async () => {
    prisma.algorithmProposal.findFirst.mockResolvedValue({
      ...proposal,
      status: 'APPROVED',
      version: 3,
    });
    prisma.algorithmProposal.updateMany.mockResolvedValue({ count: 1 });
    prisma.algorithmProposal.findUniqueOrThrow.mockResolvedValue({
      ...proposal,
      status: 'CANARY',
      version: 4,
    });

    await expect(
      service.startCanary('operator-2', proposal.id, 3),
    ).resolves.toEqual(
      expect.objectContaining({ status: 'CANARY', version: 4 }),
    );
    const canaryAction = firstArgument<{
      data: { action: string; metadata: { canaryPercentage: number } };
    }>(prisma.algorithmProposalAction.create);
    expect(canaryAction.data).toMatchObject({
      action: 'START_CANARY',
      metadata: { canaryPercentage: 5 },
    });
  });

  it('rejects stale versions instead of applying duplicate release actions', async () => {
    prisma.algorithmProposal.findFirst.mockResolvedValue({
      ...proposal,
      status: 'CANARY',
      version: 4,
    });
    prisma.algorithmProposal.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.promote('operator-2', proposal.id, 3),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.algorithmProposalAction.create).not.toHaveBeenCalled();
  });
});
