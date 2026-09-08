import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';

export type TenantRole =
  'owner' | 'admin' | 'member' | 'viewer' | 'service_account';

@Injectable()
export class TenantService {
  constructor(private readonly prisma: PrismaService) {}

  async getMembership(userId: string, tenantId?: string) {
    const membership = await this.prisma.tenantMember.findFirst({
      where: {
        userId,
        status: 'active',
        ...(tenantId ? { tenantId } : {}),
      },
      include: { tenant: true },
      orderBy: { createdAt: 'asc' },
    });

    if (!membership) {
      throw new ForbiddenException('User has no active tenant membership');
    }

    return membership;
  }

  async createDefaultTenant(userId: string, name?: string) {
    return this.prisma.tenant.create({
      data: {
        name: name?.trim() || '默认家庭',
        members: {
          create: {
            userId,
            role: 'owner',
          },
        },
        quota: { create: {} },
      },
      include: { members: true, quota: true },
    });
  }

  async requireRole(userId: string, tenantId: string, roles: TenantRole[]) {
    const membership = await this.getMembership(userId, tenantId);
    if (!roles.includes(membership.role as TenantRole)) {
      throw new ForbiddenException(
        'Tenant role is not allowed for this action',
      );
    }
    return membership;
  }

  async assertDeviceAccess(
    userId: string,
    deviceId: string,
    tenantId?: string,
  ) {
    const membership = await this.getMembership(userId, tenantId);
    const device = await this.prisma.device.findFirst({
      where: {
        id: deviceId,
        ...(membership.tenantId ? { tenantId: membership.tenantId } : {}),
        userDevices: { some: { userId } },
      },
      select: { id: true, tenantId: true },
    });

    if (!device) {
      throw new NotFoundException('Device is not accessible in this tenant');
    }

    return { membership, device };
  }

  async audit(params: {
    tenantId?: string;
    userId?: string;
    requestId?: string;
    traceId?: string;
    action: string;
    resourceType?: string;
    resourceId?: string;
    outcome: 'success' | 'denied' | 'failure';
    metadata?: Record<string, unknown>;
  }) {
    return this.prisma.auditEvent.create({
      data: {
        tenantId: params.tenantId,
        userId: params.userId,
        requestId: params.requestId,
        traceId: params.traceId,
        action: params.action,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        outcome: params.outcome,
        metadata: params.metadata as Prisma.InputJsonObject | undefined,
      },
    });
  }
}
