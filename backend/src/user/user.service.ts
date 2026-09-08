import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateContactDto } from './dto/update-contact.dto';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(userId: string) {
    const user = await this.getUserOrThrow(userId);
    return this.toProfileResponse(user);
  }

  async updateProfile(userId: string, updateDto: UpdateProfileDto) {
    await this.getUserOrThrow(userId);

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(updateDto.nickname !== undefined
          ? { nickname: updateDto.nickname }
          : {}),
        ...(updateDto.avatarUrl !== undefined
          ? { avatarUrl: updateDto.avatarUrl }
          : {}),
      },
      select: this.profileSelect,
    });

    return this.toProfileResponse(user);
  }

  async createContact(userId: string, createDto: CreateContactDto) {
    await this.getUserOrThrow(userId);

    const contact = await this.prisma.emergencyContact.create({
      data: {
        userId,
        name: createDto.name,
        phone: createDto.phone,
        relationship: createDto.relationship,
        priority: createDto.priority ?? 1,
      },
    });

    return this.toContactResponse(contact);
  }

  async getContacts(userId: string) {
    const contacts = await this.prisma.emergencyContact.findMany({
      where: { userId },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
    });

    return contacts.map((contact) => this.toContactResponse(contact));
  }

  async deleteContact(userId: string, contactId: string) {
    const contact = await this.findOwnedContact(userId, contactId);

    await this.prisma.emergencyContact.delete({
      where: { id: contact.id },
    });

    return { message: 'Contact deleted successfully' };
  }

  async updateContact(
    userId: string,
    contactId: string,
    updateDto: UpdateContactDto,
  ) {
    await this.findOwnedContact(userId, contactId);

    const updatedContact = await this.prisma.emergencyContact.update({
      where: { id: contactId },
      data: {
        ...(updateDto.name !== undefined ? { name: updateDto.name } : {}),
        ...(updateDto.phone !== undefined ? { phone: updateDto.phone } : {}),
        ...(updateDto.relationship !== undefined
          ? { relationship: updateDto.relationship }
          : {}),
        ...(updateDto.priority !== undefined
          ? { priority: updateDto.priority }
          : {}),
      },
    });

    return this.toContactResponse(updatedContact);
  }

  async getUserStats(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        userDevices: true,
        emergencyContacts: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      userId: user.id,
      deviceCount: user.userDevices.length,
      contactCount: user.emergencyContacts.length,
      createdAt: user.createdAt.getTime(),
      lastLoginAt: user.lastLoginAt?.getTime() || 0,
    };
  }

  async getUserSettings(userId: string) {
    await this.getUserOrThrow(userId);

    const settings = await this.prisma.userSetting.findMany({
      where: { userId },
    });

    const settingsObj = settings.reduce<Record<string, unknown>>(
      (acc, setting) => {
        acc[setting.settingKey] = setting.settingValue;
        return acc;
      },
      {},
    );

    return {
      userId,
      settings: settingsObj,
    };
  }

  async updateUserSettings(userId: string, settings: Record<string, unknown>) {
    await this.getUserOrThrow(userId);

    await Promise.all(
      Object.entries(settings).map(([key, value]) =>
        this.prisma.userSetting.upsert({
          where: { userId_settingKey: { userId, settingKey: key } },
          update: { settingValue: value as Prisma.InputJsonValue },
          create: {
            userId,
            settingKey: key,
            settingValue: value as Prisma.InputJsonValue,
          },
        }),
      ),
    );

    return {
      message: 'User settings updated successfully',
      userId,
      settings,
    };
  }

  private readonly profileSelect = {
    id: true,
    phone: true,
    nickname: true,
    avatarUrl: true,
    createdAt: true,
    lastLoginAt: true,
  } as const;

  private async getUserOrThrow(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: this.profileSelect,
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  private async findOwnedContact(userId: string, contactId: string) {
    const contact = await this.prisma.emergencyContact.findFirst({
      where: {
        id: contactId,
        userId,
      },
    });

    if (!contact) {
      throw new NotFoundException('Contact not found');
    }

    return contact;
  }

  private toProfileResponse(user: {
    id: string;
    phone: string;
    nickname: string | null;
    avatarUrl: string | null;
    createdAt: Date;
    lastLoginAt: Date | null;
  }) {
    return {
      userId: user.id,
      phone: user.phone,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt.getTime(),
      lastLoginAt: user.lastLoginAt?.getTime() || 0,
    };
  }

  private toContactResponse(contact: {
    id: string;
    name: string;
    phone: string;
    relationship: string | null;
    priority: number;
    createdAt: Date;
  }) {
    return {
      contactId: contact.id,
      name: contact.name,
      phone: contact.phone,
      relationship: contact.relationship,
      priority: contact.priority,
      createdAt: contact.createdAt.getTime(),
    };
  }
}
