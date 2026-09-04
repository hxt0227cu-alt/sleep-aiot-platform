import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { CodeLoginDto } from './dto/code-login.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { WechatLoginDto } from './dto/wechat-login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

type VerificationCodeType = 'register' | 'login' | 'reset_password';

@ApiTags('Authentication')
@Controller('auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @ApiOperation({ summary: 'Register a user' })
  @ApiResponse({ status: 201, description: 'Registration succeeded' })
  @ApiResponse({ status: 400, description: 'Invalid request parameters' })
  @ApiResponse({ status: 409, description: 'User already exists' })
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async register(
    @Body(new ValidationPipe({ transform: true })) registerDto: RegisterDto,
    @Req() req: Request,
  ) {
    this.logger.log(
      `User registration attempt for phone: ${registerDto.phone}`,
    );
    return this.authService.register(registerDto, this.getClientInfo(req));
  }

  @Post('login')
  @ApiOperation({ summary: 'Login with password' })
  @ApiResponse({ status: 200, description: 'Login succeeded' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async login(
    @Body(new ValidationPipe({ transform: true })) loginDto: LoginDto,
    @Req() req: Request,
  ) {
    this.logger.log(`Password login attempt for phone: ${loginDto.phone}`);
    return this.authService.login(loginDto, this.getClientInfo(req));
  }

  @Post('code-login')
  @ApiOperation({ summary: 'Login with verification code' })
  @ApiResponse({ status: 200, description: 'Login succeeded' })
  @ApiResponse({ status: 401, description: 'Invalid verification code' })
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async codeLogin(
    @Body(new ValidationPipe({ transform: true })) codeLoginDto: CodeLoginDto,
    @Req() req: Request,
  ) {
    this.logger.log(`Code login attempt for phone: ${codeLoginDto.phone}`);
    return this.authService.codeLogin(codeLoginDto, this.getClientInfo(req));
  }

  @Post('wechat-login')
  @ApiOperation({ summary: 'Login with WeChat' })
  @ApiResponse({ status: 200, description: 'Login succeeded' })
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async wechatLogin(
    @Body(new ValidationPipe({ transform: true }))
    wechatLoginDto: WechatLoginDto,
    @Req() req: Request,
  ) {
    this.logger.log('WeChat login attempt');
    return this.authService.wechatLogin(
      wechatLoginDto,
      this.getClientInfo(req),
    );
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, description: 'Refresh succeeded' })
  @HttpCode(HttpStatus.OK)
  async refreshToken(
    @Body(new ValidationPipe({ transform: true, skipMissingProperties: true }))
    refreshDto: Partial<RefreshDto>,
    @Req() req: Request,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    const refreshToken =
      refreshDto.refreshToken ||
      this.extractBearerToken(req.headers.authorization);

    if (!refreshToken) {
      throw new BadRequestException('Refresh token is required');
    }

    this.logger.debug('Token refresh attempt');
    return this.authService.refreshToken(refreshToken, this.getClientInfo(req));
  }

  @Post('logout')
  @ApiOperation({ summary: 'Logout user' })
  @ApiResponse({ status: 200, description: 'Logout succeeded' })
  @HttpCode(HttpStatus.OK)
  async logout(
    @Body() body: { refreshToken?: string } = {},
    @Req() req: Request,
  ) {
    const accessToken = this.extractBearerToken(req.headers.authorization);
    this.logger.log('Logout request received');

    return this.authService.logout({
      accessToken,
      refreshToken: body.refreshToken,
    });
  }

  @Post('send-code')
  @ApiOperation({ summary: 'Send verification code' })
  @ApiResponse({ status: 200, description: 'Code sent' })
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async sendVerificationCode(
    @Body()
    body: { phone: string; type: VerificationCodeType },
    @Req() req: Request,
  ) {
    this.assertPhone(body.phone);
    this.assertVerificationCodeType(body.type);

    this.logger.log(
      `Sending verification code to phone: ${body.phone} for type: ${body.type}`,
    );

    return this.authService.sendVerificationCode(
      body.phone,
      body.type,
      this.getClientInfo(req),
    );
  }

  @Post('reset-password')
  @ApiOperation({ summary: 'Reset password' })
  @ApiResponse({ status: 200, description: 'Password reset succeeded' })
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async resetPassword(
    @Body() body: { phone: string; code: string; newPassword: string },
    @Req() req: Request,
  ) {
    this.assertPhone(body.phone);
    this.assertVerificationCode(body.code);

    if (
      !body.newPassword ||
      body.newPassword.length < 6 ||
      body.newPassword.length > 20
    ) {
      throw new BadRequestException(
        'Password must be between 6 and 20 characters',
      );
    }

    this.logger.log(`Password reset attempt for phone: ${body.phone}`);
    return this.authService.resetPassword(
      body.phone,
      body.code,
      body.newPassword,
      this.getClientInfo(req),
    );
  }

  @Get('me')
  @ApiOperation({ summary: 'Get current user' })
  @ApiResponse({ status: 200, description: 'Fetch succeeded' })
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async getCurrentUser(@CurrentUser() user: { id: string }) {
    return this.authService.getCurrentUser(user.id);
  }

  private getClientInfo(req: Request) {
    const forwardedFor = req.headers['x-forwarded-for'];
    const ipAddress = Array.isArray(forwardedFor)
      ? forwardedFor[0]
      : forwardedFor?.split(',')[0]?.trim() || req.ip;

    return {
      ipAddress,
      userAgent: this.readHeaderValue(req.headers['user-agent']),
      deviceId: this.readHeaderValue(req.headers['x-device-id']),
      deviceName: this.readHeaderValue(req.headers['x-device-name']),
    };
  }

  private extractBearerToken(authorization?: string) {
    const [type, token] = authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }

  private assertPhone(phone?: string) {
    if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
      throw new BadRequestException('Invalid phone number format');
    }
  }

  private assertVerificationCode(code?: string) {
    if (!code || !/^\d{6}$/.test(code)) {
      throw new BadRequestException('Invalid verification code format');
    }
  }

  private assertVerificationCodeType(type?: string) {
    const validTypes: VerificationCodeType[] = [
      'register',
      'login',
      'reset_password',
    ];
    if (!type || !validTypes.includes(type as VerificationCodeType)) {
      throw new BadRequestException('Invalid verification code type');
    }
  }

  private readHeaderValue(value?: string | string[]) {
    if (Array.isArray(value)) {
      return value[0];
    }

    return value;
  }
}
