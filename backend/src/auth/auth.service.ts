import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CodeLoginDto } from './dto/code-login.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { WechatLoginDto } from './dto/wechat-login.dto';

type VerificationCodeType = 'register' | 'login' | 'reset_password';
type LoginMethod = 'register' | 'password' | 'code' | 'wechat' | 'refresh';

interface AuthClientInfo {
  ipAddress?: string;
  userAgent?: string;
  deviceId?: string;
  deviceName?: string;
}

interface SessionTokenPayload {
  sub: string;
  sid?: string;
  type?: 'access' | 'refresh';
}

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface LoginAuditInput {
  status: 'success' | 'failed';
  loginMethod: LoginMethod;
  userId?: string;
  phone?: string;
  sessionId?: string;
  failureReason?: string;
  clientInfo?: AuthClientInfo;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly verificationCodeTtlSeconds = 300;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {}

  async register(registerDto: RegisterDto, clientInfo: AuthClientInfo = {}) {
    const { phone, password, nickname, wechatOpenid, code } = registerDto;

    const existingUser = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true },
    });

    if (existingUser) {
      await this.recordLoginAudit({
        status: 'failed',
        loginMethod: 'register',
        phone,
        failureReason: 'phone_already_registered',
        clientInfo,
      });
      throw new ConflictException('User already exists');
    }

    if (!code) {
      throw new BadRequestException('Verification code is required');
    }

    await this.verifyVerificationCode(phone, 'register', code);

    const lastLoginAt = new Date();
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await this.prisma.user.create({
      data: {
        phone,
        password: hashedPassword,
        nickname: nickname?.trim() || this.buildDefaultNickname(phone),
        wechatOpenid,
        lastLoginAt,
      },
      select: this.authUserSelect,
    });

    const tokens = await this.createSession(user.id, 'register', clientInfo, {
      hasWechatOpenid: Boolean(wechatOpenid),
    });

    await this.recordLoginAudit({
      status: 'success',
      loginMethod: 'register',
      userId: user.id,
      phone: user.phone,
      sessionId: this.decodeSessionId(tokens.refreshToken),
      clientInfo,
    });

    return {
      user,
      ...tokens,
    };
  }

  async login(loginDto: LoginDto, clientInfo: AuthClientInfo = {}) {
    const { phone, password } = loginDto;
    const user = await this.prisma.user.findUnique({
      where: { phone },
    });

    if (!user) {
      await this.recordLoginAudit({
        status: 'failed',
        loginMethod: 'password',
        phone,
        failureReason: 'user_not_found',
        clientInfo,
      });
      throw new UnauthorizedException('Invalid phone number or password');
    }

    await this.ensureUserCanLogin(
      user.id,
      user.status,
      phone,
      'password',
      clientInfo,
    );

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      await this.recordLoginAudit({
        status: 'failed',
        loginMethod: 'password',
        userId: user.id,
        phone,
        failureReason: 'invalid_password',
        clientInfo,
      });
      throw new UnauthorizedException('Invalid phone number or password');
    }

    const lastLoginAt = new Date();
    const authUser = await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt },
      select: this.authUserSelect,
    });

    const tokens = await this.createSession(user.id, 'password', clientInfo);
    await this.recordLoginAudit({
      status: 'success',
      loginMethod: 'password',
      userId: user.id,
      phone: authUser.phone,
      sessionId: this.decodeSessionId(tokens.refreshToken),
      clientInfo,
    });

    return {
      user: authUser,
      ...tokens,
    };
  }

  async codeLogin(codeLoginDto: CodeLoginDto, clientInfo: AuthClientInfo = {}) {
    const { phone, code } = codeLoginDto;
    await this.verifyVerificationCode(phone, 'login', code);

    let user = await this.prisma.user.findUnique({
      where: { phone },
    });
    const autoRegistered = !user;

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          phone,
          password: await bcrypt.hash(randomBytes(24).toString('hex'), 10),
          nickname: this.buildDefaultNickname(phone),
          lastLoginAt: new Date(),
        },
      });
    }

    await this.ensureUserCanLogin(
      user.id,
      user.status,
      phone,
      'code',
      clientInfo,
    );

    const lastLoginAt = new Date();
    const authUser = await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt },
      select: this.authUserSelect,
    });

    const tokens = await this.createSession(user.id, 'code', clientInfo, {
      autoRegistered,
    });
    await this.recordLoginAudit({
      status: 'success',
      loginMethod: 'code',
      userId: user.id,
      phone: authUser.phone,
      sessionId: this.decodeSessionId(tokens.refreshToken),
      clientInfo,
    });

    return {
      user: authUser,
      ...tokens,
    };
  }

  async wechatLogin(
    wechatLoginDto: WechatLoginDto,
    clientInfo: AuthClientInfo = {},
  ) {
    const appId = this.configService.get<string>('WECHAT_APP_ID');
    const appSecret = this.configService.get<string>('WECHAT_APP_SECRET');

    if (!appId || !appSecret) {
      throw new UnauthorizedException('WeChat login is not configured');
    }

    let openid: string;
    try {
      openid = await this.fetchWechatOpenid(
        appId,
        appSecret,
        wechatLoginDto.code,
      );
    } catch (error) {
      await this.recordLoginAudit({
        status: 'failed',
        loginMethod: 'wechat',
        failureReason: 'wechat_exchange_failed',
        clientInfo,
      });
      throw error;
    }

    const user = await this.prisma.user.findFirst({
      where: { wechatOpenid: openid },
    });

    if (!user) {
      await this.recordLoginAudit({
        status: 'failed',
        loginMethod: 'wechat',
        failureReason: 'wechat_account_not_bound',
        clientInfo,
        metadata: { openid },
      });
      throw new UnauthorizedException(
        'This WeChat account is not bound to an existing user',
      );
    }

    await this.ensureUserCanLogin(
      user.id,
      user.status,
      user.phone,
      'wechat',
      clientInfo,
    );

    const lastLoginAt = new Date();
    const authUser = await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt },
      select: this.authUserSelect,
    });

    const tokens = await this.createSession(user.id, 'wechat', clientInfo, {
      openid,
    });
    await this.recordLoginAudit({
      status: 'success',
      loginMethod: 'wechat',
      userId: user.id,
      phone: authUser.phone,
      sessionId: this.decodeSessionId(tokens.refreshToken),
      clientInfo,
      metadata: { openid },
    });

    return {
      user: authUser,
      ...tokens,
    };
  }

  async refreshToken(refreshToken: string, clientInfo: AuthClientInfo = {}) {
    const payload = this.verifyRefreshToken(refreshToken);
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        phone: true,
        status: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    await this.ensureUserCanLogin(
      user.id,
      user.status,
      user.phone,
      'refresh',
      clientInfo,
    );

    if (!payload.sid) {
      return this.refreshLegacyToken(
        user.id,
        user.phone,
        refreshToken,
        clientInfo,
      );
    }

    const session = await this.prisma.authSession.findFirst({
      where: {
        id: payload.sid,
        userId: user.id,
      },
    });

    if (!session) {
      await this.recordLoginAudit({
        status: 'failed',
        loginMethod: 'refresh',
        userId: user.id,
        phone: user.phone,
        sessionId: payload.sid,
        failureReason: 'session_not_found',
        clientInfo,
      });
      throw new UnauthorizedException('Refresh token is invalid');
    }

    if (
      !session.isActive ||
      session.revokedAt ||
      session.expiresAt <= new Date()
    ) {
      await this.revokeSession(session.id, 'expired_or_revoked');
      await this.recordLoginAudit({
        status: 'failed',
        loginMethod: 'refresh',
        userId: user.id,
        phone: user.phone,
        sessionId: session.id,
        failureReason: 'session_revoked',
        clientInfo,
      });
      throw new UnauthorizedException('Refresh token is invalid');
    }

    if (session.refreshTokenHash !== this.hashToken(refreshToken)) {
      await this.revokeSession(session.id, 'refresh_token_mismatch');
      await this.recordLoginAudit({
        status: 'failed',
        loginMethod: 'refresh',
        userId: user.id,
        phone: user.phone,
        sessionId: session.id,
        failureReason: 'refresh_token_mismatch',
        clientInfo,
      });
      throw new UnauthorizedException('Refresh token is invalid');
    }

    const tokens = await this.rotateSessionTokens(
      user.id,
      session.id,
      clientInfo,
      session.metadata ? session.metadata : undefined,
    );

    await this.recordLoginAudit({
      status: 'success',
      loginMethod: 'refresh',
      userId: user.id,
      phone: user.phone,
      sessionId: session.id,
      clientInfo,
    });

    return tokens;
  }

  async logout(context: {
    accessToken?: string;
    refreshToken?: string;
    userId?: string;
    sessionId?: string;
  }) {
    let { accessToken, refreshToken, userId, sessionId } = context;

    if (refreshToken) {
      try {
        const payload = this.verifyRefreshToken(refreshToken);
        userId = userId || payload.sub;
        sessionId = sessionId || payload.sid;
      } catch (error) {
        this.logger.warn('Ignoring invalid refresh token during logout');
      }
    }

    if (accessToken) {
      try {
        const payload = this.jwtService.verify<SessionTokenPayload>(
          accessToken,
          {
            secret: this.configService.getOrThrow<string>('JWT_SECRET'),
          },
        );
        userId = userId || payload.sub;
        sessionId = sessionId || payload.sid;
      } catch (error) {
        this.logger.warn('Ignoring invalid access token during logout');
      }
    }

    if (sessionId) {
      await this.revokeSession(sessionId, 'logout');
    } else if (userId) {
      await this.revokeAllSessionsForUser(userId, 'logout');
    }

    if (userId) {
      await this.redisService.del(`refresh_token:${userId}`);
    }
    if (sessionId) {
      await this.redisService.del(`refresh_token_session:${sessionId}`);
    }

    return { message: 'Logout successful' };
  }

  async sendVerificationCode(
    phone: string,
    type: VerificationCodeType,
    clientInfo: AuthClientInfo = {},
  ) {
    const code = this.generateVerificationCode();
    const expiresAt = new Date(
      Date.now() + this.verificationCodeTtlSeconds * 1000,
    );

    await this.prisma.verificationCode.updateMany({
      where: {
        phone,
        type,
        status: 'pending',
      },
      data: {
        status: 'superseded',
        invalidatedAt: new Date(),
      },
    });

    await this.prisma.verificationCode.create({
      data: {
        phone,
        type,
        codeHash: this.hashVerificationCode(phone, type, code),
        expiresAt,
        metadata: this.toJsonValue(
          this.compactRecord({
            ipAddress: clientInfo.ipAddress,
            userAgent: clientInfo.userAgent,
            deviceId: clientInfo.deviceId,
            deviceName: clientInfo.deviceName,
          }),
        ),
      },
    });

    await this.redisService.set(
      this.buildVerificationCodeKey(phone, type),
      code,
      this.verificationCodeTtlSeconds,
    );

    return {
      message: 'Verification code sent',
      expiresIn: this.verificationCodeTtlSeconds,
      code: process.env.NODE_ENV === 'production' ? undefined : code,
    };
  }

  async resetPassword(
    phone: string,
    code: string,
    newPassword: string,
    clientInfo: AuthClientInfo = {},
  ) {
    await this.verifyVerificationCode(phone, 'reset_password', code);

    const existingUser = await this.prisma.user.findUnique({
      where: { phone },
      select: {
        id: true,
        phone: true,
        nickname: true,
      },
    });

    if (!existingUser) {
      throw new NotFoundException('User not found');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    const user = await this.prisma.user.update({
      where: { id: existingUser.id },
      data: { password: hashedPassword },
      select: {
        id: true,
        phone: true,
        nickname: true,
      },
    });

    await this.revokeAllSessionsForUser(existingUser.id, 'password_reset');
    await this.redisService.del(`refresh_token:${existingUser.id}`);

    await this.recordLoginAudit({
      status: 'success',
      loginMethod: 'password',
      userId: existingUser.id,
      phone,
      clientInfo,
      metadata: { action: 'password_reset' },
    });

    return {
      message: 'Password reset successful',
      user,
    };
  }

  async getCurrentUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: this.authUserSelect,
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return user;
  }

  private readonly authUserSelect = {
    id: true,
    phone: true,
    nickname: true,
    avatarUrl: true,
    createdAt: true,
    lastLoginAt: true,
  } as const;

  private async ensureUserCanLogin(
    userId: string,
    status: string,
    phone: string,
    loginMethod: LoginMethod,
    clientInfo: AuthClientInfo,
  ) {
    if (status === 'active') {
      return;
    }

    await this.recordLoginAudit({
      status: 'failed',
      loginMethod,
      userId,
      phone,
      failureReason: `user_status_${status}`,
      clientInfo,
    });

    throw new UnauthorizedException('User account is not active');
  }

  private async createSession(
    userId: string,
    loginMethod: Exclude<LoginMethod, 'refresh'>,
    clientInfo: AuthClientInfo,
    metadata?: Prisma.InputJsonValue,
  ): Promise<AuthTokens> {
    await this.ensureDefaultTenant(userId);
    const refreshTtlSeconds = this.getRefreshTokenTtlSeconds();
    const expiresAt = new Date(Date.now() + refreshTtlSeconds * 1000);

    const session = await this.prisma.authSession.create({
      data: {
        userId,
        refreshTokenHash: this.hashToken(randomBytes(32).toString('hex')),
        loginMethod,
        sessionType: 'app',
        ipAddress: clientInfo.ipAddress,
        userAgent: clientInfo.userAgent,
        deviceId: clientInfo.deviceId,
        deviceName: clientInfo.deviceName,
        expiresAt,
        metadata,
      },
      select: {
        id: true,
      },
    });

    return this.rotateSessionTokens(userId, session.id, clientInfo, metadata);
  }

  private async rotateSessionTokens(
    userId: string,
    sessionId: string,
    clientInfo: AuthClientInfo,
    metadata?: Prisma.InputJsonValue,
  ): Promise<AuthTokens> {
    const refreshTtlSeconds = this.getRefreshTokenTtlSeconds();
    const expiresIn = this.getAccessTokenTtlSeconds();
    const membership = await this.prisma.tenantMember.findFirst({
      where: { userId, status: 'active' },
      select: { tenantId: true, role: true },
      orderBy: { createdAt: 'asc' },
    });
    const refreshToken = this.jwtService.sign(
      {
        sub: userId,
        sid: sessionId,
        type: 'refresh',
        tenantId: membership?.tenantId,
        role: membership?.role,
      },
      {
        secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: (this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') ||
          '30d') as any,
      },
    );

    const accessToken = this.jwtService.sign(
      {
        sub: userId,
        sid: sessionId,
        type: 'access',
        tenantId: membership?.tenantId,
        role: membership?.role,
      },
      {
        secret: this.configService.getOrThrow<string>('JWT_SECRET'),
        expiresIn: (this.configService.get<string>('JWT_EXPIRES_IN') ||
          '2h') as any,
      },
    );

    const now = new Date();
    const expiresAt = new Date(Date.now() + refreshTtlSeconds * 1000);

    await this.prisma.authSession.update({
      where: { id: sessionId },
      data: {
        refreshTokenHash: this.hashToken(refreshToken),
        lastUsedAt: now,
        expiresAt,
        isActive: true,
        revokedAt: null,
        revokedReason: null,
        ipAddress: clientInfo.ipAddress,
        userAgent: clientInfo.userAgent,
        deviceId: clientInfo.deviceId,
        deviceName: clientInfo.deviceName,
        metadata,
      },
    });

    await this.redisService.set(
      `refresh_token:${userId}`,
      refreshToken,
      refreshTtlSeconds,
    );
    await this.redisService.set(
      `refresh_token_session:${sessionId}`,
      refreshToken,
      refreshTtlSeconds,
    );

    return {
      accessToken,
      refreshToken,
      expiresIn,
    };
  }

  private async ensureDefaultTenant(userId: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        userId,
      );
      const existing = await tx.tenantMember.findFirst({
        where: { userId, status: 'active' },
        select: { id: true },
      });
      if (existing) {
        return;
      }

      await tx.tenant.create({
        data: {
          name: '默认家庭',
          members: {
            create: {
              userId,
              role: 'owner',
            },
          },
          quota: { create: {} },
        },
      });
    });
  }

  private async refreshLegacyToken(
    userId: string,
    phone: string,
    refreshToken: string,
    clientInfo: AuthClientInfo,
  ) {
    const legacyToken = await this.redisService.get(`refresh_token:${userId}`);
    if (!legacyToken || legacyToken !== refreshToken) {
      await this.recordLoginAudit({
        status: 'failed',
        loginMethod: 'refresh',
        userId,
        phone,
        failureReason: 'legacy_refresh_token_mismatch',
        clientInfo,
      });
      throw new UnauthorizedException('Refresh token is invalid');
    }

    const tokens = await this.createSession(userId, 'password', clientInfo, {
      migratedFromLegacyRefreshToken: true,
    });

    await this.recordLoginAudit({
      status: 'success',
      loginMethod: 'refresh',
      userId,
      phone,
      sessionId: this.decodeSessionId(tokens.refreshToken),
      clientInfo,
      metadata: { migratedFromLegacyRefreshToken: true },
    });

    return tokens;
  }

  private async verifyVerificationCode(
    phone: string,
    type: VerificationCodeType,
    code: string,
  ) {
    const now = new Date();
    const verificationCode = await this.prisma.verificationCode.findFirst({
      where: {
        phone,
        type,
        status: 'pending',
      },
      orderBy: {
        sentAt: 'desc',
      },
    });

    if (verificationCode) {
      if (verificationCode.expiresAt <= now) {
        await this.prisma.verificationCode.update({
          where: { id: verificationCode.id },
          data: {
            status: 'expired',
            invalidatedAt: now,
          },
        });
        throw new UnauthorizedException(
          'Verification code is invalid or expired',
        );
      }

      if (
        verificationCode.codeHash ===
        this.hashVerificationCode(phone, type, code)
      ) {
        await this.prisma.verificationCode.update({
          where: { id: verificationCode.id },
          data: {
            status: 'consumed',
            consumedAt: now,
          },
        });
        await this.redisService.del(this.buildVerificationCodeKey(phone, type));
        return;
      }

      const nextAttemptCount = verificationCode.attemptCount + 1;
      await this.prisma.verificationCode.update({
        where: { id: verificationCode.id },
        data: {
          attemptCount: nextAttemptCount,
          ...(nextAttemptCount >= verificationCode.maxAttempts
            ? {
                status: 'locked',
                invalidatedAt: now,
              }
            : {}),
        },
      });

      throw new UnauthorizedException(
        'Verification code is invalid or expired',
      );
    }

    const legacyCode = await this.redisService.get(
      this.buildVerificationCodeKey(phone, type),
    );
    if (legacyCode && legacyCode === code) {
      await this.redisService.del(this.buildVerificationCodeKey(phone, type));
      return;
    }

    throw new UnauthorizedException('Verification code is invalid or expired');
  }

  private async revokeSession(sessionId: string, reason: string) {
    await this.prisma.authSession.updateMany({
      where: {
        id: sessionId,
        isActive: true,
      },
      data: {
        isActive: false,
        revokedAt: new Date(),
        revokedReason: reason,
      },
    });
  }

  private async revokeAllSessionsForUser(userId: string, reason: string) {
    const activeSessions = await this.prisma.authSession.findMany({
      where: {
        userId,
        isActive: true,
      },
      select: {
        id: true,
      },
    });

    await this.prisma.authSession.updateMany({
      where: {
        userId,
        isActive: true,
      },
      data: {
        isActive: false,
        revokedAt: new Date(),
        revokedReason: reason,
      },
    });

    if (activeSessions.length > 0) {
      await this.redisService.del(
        ...activeSessions.map(
          (session) => `refresh_token_session:${session.id}`,
        ),
      );
    }
  }

  private async recordLoginAudit(input: LoginAuditInput) {
    try {
      await this.prisma.loginAudit.create({
        data: {
          userId: input.userId,
          phone: input.phone,
          sessionId: input.sessionId,
          loginMethod: input.loginMethod,
          status: input.status,
          ipAddress: input.clientInfo?.ipAddress,
          userAgent: input.clientInfo?.userAgent,
          failureReason: input.failureReason,
          metadata: this.toJsonValue(input.metadata),
        },
      });
    } catch (error) {
      this.logger.warn(`Failed to record login audit: ${String(error)}`);
    }
  }

  private async fetchWechatOpenid(
    appId: string,
    appSecret: string,
    code: string,
  ): Promise<string> {
    const response = await fetch(
      `https://api.weixin.qq.com/sns/jscode2session?appid=${appId}&secret=${appSecret}&js_code=${code}&grant_type=authorization_code`,
    );

    const data = (await response.json()) as {
      errcode?: number;
      errmsg?: string;
      openid?: string;
    };

    if (!response.ok || data.errcode || !data.openid) {
      throw new UnauthorizedException(data.errmsg || 'WeChat login failed');
    }

    return data.openid;
  }

  private verifyRefreshToken(refreshToken: string): SessionTokenPayload {
    try {
      return this.jwtService.verify<SessionTokenPayload>(refreshToken, {
        secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch (error) {
      throw new UnauthorizedException('Refresh token is invalid');
    }
  }

  private decodeSessionId(token: string): string | undefined {
    const payload = this.jwtService.decode(token);
    return payload?.sid;
  }

  private generateVerificationCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private buildDefaultNickname(phone: string): string {
    return `user${phone.slice(-4)}`;
  }

  private compactRecord(record: Record<string, unknown>) {
    return Object.fromEntries(
      Object.entries(record).filter(([, value]) => value !== undefined),
    );
  }

  private toJsonValue(record?: Record<string, unknown>) {
    if (!record) {
      return undefined;
    }

    return record as Prisma.InputJsonValue;
  }

  private buildVerificationCodeKey(phone: string, type: VerificationCodeType) {
    return `verify_code:${type}:${phone}`;
  }

  private hashVerificationCode(
    phone: string,
    type: VerificationCodeType,
    code: string,
  ) {
    return createHash('sha256')
      .update(`${phone}:${type}:${code}:${this.getTokenHashSecret()}`)
      .digest('hex');
  }

  private hashToken(token: string) {
    return createHash('sha256')
      .update(`${token}:${this.getTokenHashSecret()}`)
      .digest('hex');
  }

  private getTokenHashSecret() {
    return this.configService.getOrThrow<string>('JWT_SECRET');
  }

  private getAccessTokenTtlSeconds() {
    return this.parseExpiresInToSeconds(
      this.configService.get<string>('JWT_EXPIRES_IN') || '2h',
      7200,
    );
  }

  private getRefreshTokenTtlSeconds() {
    return this.parseExpiresInToSeconds(
      this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') || '30d',
      30 * 24 * 60 * 60,
    );
  }

  private parseExpiresInToSeconds(value: string | number, fallback: number) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value !== 'string') {
      return fallback;
    }

    const normalized = value.trim();
    if (/^\d+$/.test(normalized)) {
      return Number(normalized);
    }

    const match = normalized.match(/^(\d+)([smhd])$/i);
    if (!match) {
      return fallback;
    }

    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const multipliers: Record<string, number> = {
      s: 1,
      m: 60,
      h: 60 * 60,
      d: 24 * 60 * 60,
    };

    return amount * (multipliers[unit] || 1);
  }
}
