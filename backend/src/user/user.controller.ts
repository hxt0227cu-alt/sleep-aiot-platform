import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Put,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UserService } from './user.service';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
@UseGuards(JwtAuthGuard)
export class UserController {
  private readonly logger = new Logger(UserController.name);

  constructor(private readonly userService: UserService) {}

  @Get('profile')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Fetch succeeded' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async getProfile(@CurrentUser() user: { id: string }) {
    this.logger.debug(`Fetching profile for user ${user.id}`);
    return this.userService.getProfile(user.id);
  }

  @Put('profile')
  @ApiOperation({ summary: 'Update current user profile' })
  @ApiResponse({ status: 200, description: 'Update succeeded' })
  @ApiResponse({ status: 400, description: 'Invalid request parameters' })
  @HttpCode(HttpStatus.OK)
  async updateProfile(
    @CurrentUser() user: { id: string },
    @Body(new ValidationPipe({ transform: true })) updateDto: UpdateProfileDto,
  ) {
    this.logger.log(`User ${user.id} updating profile`);
    return this.userService.updateProfile(user.id, updateDto);
  }

  @Post('contacts')
  @ApiOperation({ summary: 'Create emergency contact' })
  @ApiResponse({ status: 201, description: 'Create succeeded' })
  @ApiResponse({ status: 400, description: 'Invalid request parameters' })
  @HttpCode(HttpStatus.CREATED)
  async createContact(
    @CurrentUser() user: { id: string },
    @Body(new ValidationPipe({ transform: true })) createDto: CreateContactDto,
  ) {
    this.logger.log(
      `User ${user.id} creating emergency contact ${createDto.name}`,
    );
    return this.userService.createContact(user.id, createDto);
  }

  @Get('contacts')
  @ApiOperation({ summary: 'Get emergency contacts' })
  @ApiResponse({ status: 200, description: 'Fetch succeeded' })
  async getContacts(@CurrentUser() user: { id: string }) {
    this.logger.debug(`Fetching contacts for user ${user.id}`);
    return this.userService.getContacts(user.id);
  }

  @Delete('contacts/:contactId')
  @ApiOperation({ summary: 'Delete emergency contact' })
  @ApiParam({ name: 'contactId', description: 'Emergency contact ID' })
  @ApiResponse({ status: 200, description: 'Delete succeeded' })
  @ApiResponse({ status: 404, description: 'Contact not found' })
  async deleteContact(
    @CurrentUser() user: { id: string },
    @Param('contactId') contactId: string,
  ) {
    this.logger.log(`User ${user.id} deleting contact ${contactId}`);
    return this.userService.deleteContact(user.id, contactId);
  }

  @Put('contacts/:contactId')
  @ApiOperation({ summary: 'Update emergency contact' })
  @ApiParam({ name: 'contactId', description: 'Emergency contact ID' })
  @ApiResponse({ status: 200, description: 'Update succeeded' })
  @ApiResponse({ status: 400, description: 'Invalid request parameters' })
  @ApiResponse({ status: 404, description: 'Contact not found' })
  @HttpCode(HttpStatus.OK)
  async updateContact(
    @CurrentUser() user: { id: string },
    @Param('contactId') contactId: string,
    @Body(new ValidationPipe({ transform: true, skipMissingProperties: true }))
    updateDto: UpdateContactDto,
  ) {
    this.logger.log(`User ${user.id} updating contact ${contactId}`);
    return this.userService.updateContact(user.id, contactId, updateDto);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get user statistics' })
  @ApiResponse({ status: 200, description: 'Fetch succeeded' })
  async getUserStats(@CurrentUser() user: { id: string }) {
    this.logger.debug(`Fetching stats for user ${user.id}`);
    return this.userService.getUserStats(user.id);
  }

  @Get('settings')
  @ApiOperation({ summary: 'Get user settings' })
  @ApiResponse({ status: 200, description: 'Fetch succeeded' })
  async getUserSettings(@CurrentUser() user: { id: string }) {
    this.logger.debug(`Fetching settings for user ${user.id}`);
    return this.userService.getUserSettings(user.id);
  }

  @Put('settings')
  @ApiOperation({ summary: 'Update user settings' })
  @ApiResponse({ status: 200, description: 'Update succeeded' })
  @ApiResponse({ status: 400, description: 'Invalid request parameters' })
  @HttpCode(HttpStatus.OK)
  async updateUserSettings(
    @CurrentUser() user: { id: string },
    @Body() settings: Record<string, unknown>,
  ) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new BadRequestException('Settings must be an object');
    }

    const settingKeys = Object.keys(settings);
    if (settingKeys.length === 0) {
      throw new BadRequestException('Settings cannot be empty');
    }

    if (settingKeys.length > 20) {
      throw new BadRequestException('Maximum 20 settings allowed per request');
    }

    const invalidKeys = settingKeys.filter(
      (key) => !/^[a-zA-Z0-9_]+$/.test(key),
    );
    if (invalidKeys.length > 0) {
      throw new BadRequestException(
        `Invalid setting keys: ${invalidKeys.join(', ')}`,
      );
    }

    this.logger.log(`User ${user.id} updating settings`);
    return this.userService.updateUserSettings(user.id, settings);
  }
}
