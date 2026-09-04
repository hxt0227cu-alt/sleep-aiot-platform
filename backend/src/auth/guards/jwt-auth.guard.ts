import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { PrismaService } from '../../database/prisma.service';

interface AccessTokenPayload {
  sub: string;
  sid?: string;
  tenantId?: string;
  role?: string;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      Request & {
        user?: {
          id: string;
          sessionId?: string;
          tenantId?: string;
          role?: string;
        };
      }
    >();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('Authentication token is required');
    }

    try {
      const payload = this.jwtService.verify<AccessTokenPayload>(token, {
        secret: this.configService.getOrThrow<string>('JWT_SECRET'),
      });

      if (payload.sid) {
        const session = await this.prisma.authSession.findFirst({
          where: {
            id: payload.sid,
            userId: payload.sub,
          },
          select: {
            isActive: true,
            revokedAt: true,
            expiresAt: true,
          },
        });

        if (
          !session ||
          !session.isActive ||
          session.revokedAt ||
          session.expiresAt <= new Date()
        ) {
          throw new UnauthorizedException(
            'Authentication session is no longer active',
          );
        }
      }

      request.user = {
        id: payload.sub,
        sessionId: payload.sid,
        tenantId: payload.tenantId,
        role: payload.role,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw new UnauthorizedException('Authentication token is invalid');
    }

    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
