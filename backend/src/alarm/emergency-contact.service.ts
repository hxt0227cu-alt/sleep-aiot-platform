import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import {
  AlarmNotificationService,
  AlarmNotification,
} from './alarm-notification.service';

export interface EmergencyContact {
  id: string;
  userId: string;
  name: string;
  phone: string;
  relationship?: string;
  priority: number;
  createdAt: Date;
}

export interface CreateContactDto {
  userId: string;
  name: string;
  phone: string;
  relationship?: string;
  priority?: number;
}

export interface UpdateContactDto {
  name?: string;
  phone?: string;
  relationship?: string;
  priority?: number;
}

export interface NotificationResult {
  contactId: string;
  contactName: string;
  success: boolean;
  error?: string;
  timestamp: Date;
}

@Injectable()
export class EmergencyContactService {
  private readonly logger = new Logger(EmergencyContactService.name);
  private readonly notificationHistory = new Map<
    string,
    NotificationResult[]
  >();
  private readonly MAX_HISTORY_SIZE = 50;

  constructor(
    private prisma: PrismaService,
    private notificationService: AlarmNotificationService,
  ) {}

  /**
   * 创建紧急联系人
   */
  async createContact(contactDto: CreateContactDto): Promise<EmergencyContact> {
    // 验证用户是否存在
    const user = await this.prisma.user.findUnique({
      where: { id: contactDto.userId },
    });

    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    // 检查手机号格式
    if (!this.validatePhoneNumber(contactDto.phone)) {
      throw new Error('手机号格式不正确');
    }

    // 如果没有指定优先级，设置为最高优先级
    let priority = contactDto.priority;
    if (priority === undefined) {
      const maxPriority = await this.getMaxPriority(contactDto.userId);
      priority = maxPriority + 1;
    }

    const contact = await this.prisma.emergencyContact.create({
      data: {
        userId: contactDto.userId,
        name: contactDto.name,
        phone: contactDto.phone,
        relationship: contactDto.relationship,
        priority,
      },
    });

    this.logger.log(
      `Emergency contact created: ${contact.id} for user ${contactDto.userId}`,
    );
    return this.mapToEmergencyContact(contact);
  }

  /**
   * 更新紧急联系人
   */
  async updateContact(
    contactId: string,
    userId: string,
    updateDto: UpdateContactDto,
  ): Promise<EmergencyContact> {
    // 验证联系人是否存在且属于该用户
    const existingContact = await this.prisma.emergencyContact.findFirst({
      where: { id: contactId, userId },
    });

    if (!existingContact) {
      throw new NotFoundException('紧急联系人不存在或无权限访问');
    }

    // 如果更新手机号，验证格式
    if (updateDto.phone && !this.validatePhoneNumber(updateDto.phone)) {
      throw new Error('手机号格式不正确');
    }

    const contact = await this.prisma.emergencyContact.update({
      where: { id: contactId },
      data: updateDto,
    });

    this.logger.log(`Emergency contact updated: ${contactId}`);
    return this.mapToEmergencyContact(contact);
  }

  /**
   * 删除紧急联系人
   */
  async deleteContact(contactId: string, userId: string): Promise<void> {
    // 验证联系人是否存在且属于该用户
    const existingContact = await this.prisma.emergencyContact.findFirst({
      where: { id: contactId, userId },
    });

    if (!existingContact) {
      throw new NotFoundException('紧急联系人不存在或无权限访问');
    }

    await this.prisma.emergencyContact.delete({
      where: { id: contactId },
    });

    this.logger.log(`Emergency contact deleted: ${contactId}`);
  }

  /**
   * 获取用户的所有紧急联系人
   */
  async getUserContacts(userId: string): Promise<EmergencyContact[]> {
    const contacts = await this.prisma.emergencyContact.findMany({
      where: { userId },
      orderBy: { priority: 'asc' },
    });

    return contacts.map((contact) => this.mapToEmergencyContact(contact));
  }

  /**
   * 获取紧急联系人详情
   */
  async getContactById(
    contactId: string,
    userId: string,
  ): Promise<EmergencyContact> {
    const contact = await this.prisma.emergencyContact.findFirst({
      where: { id: contactId, userId },
    });

    if (!contact) {
      throw new NotFoundException('紧急联系人不存在或无权限访问');
    }

    return this.mapToEmergencyContact(contact);
  }

  /**
   * 通知紧急联系人
   */
  async notifyEmergencyContacts(
    userId: string,
    notification: AlarmNotification,
    options: {
      maxContacts?: number;
      onlyCritical?: boolean;
    } = {},
  ): Promise<NotificationResult[]> {
    const { maxContacts = 3, onlyCritical = true } = options;

    // 只对严重报警通知紧急联系人
    if (onlyCritical && notification.level !== 'critical') {
      this.logger.debug(
        `Skipping emergency contact notification for non-critical alarm`,
      );
      return [];
    }

    // 获取用户的紧急联系人
    const contacts = await this.getUserContacts(userId);

    if (contacts.length === 0) {
      this.logger.warn(`No emergency contacts found for user ${userId}`);
      return [];
    }

    // 限制通知的联系人数量
    const contactsToNotify = contacts.slice(0, maxContacts);

    const results: NotificationResult[] = [];

    for (const contact of contactsToNotify) {
      try {
        await this.notificationService.sendEmergencyContactNotification(
          notification,
          contact,
        );

        const result: NotificationResult = {
          contactId: contact.id,
          contactName: contact.name,
          success: true,
          timestamp: new Date(),
        };

        results.push(result);
        this.addToNotificationHistory(userId, result);

        this.logger.log(
          `Emergency contact notification sent to ${contact.name} (${contact.phone})`,
        );
      } catch (error) {
        const result: NotificationResult = {
          contactId: contact.id,
          contactName: contact.name,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date(),
        };

        results.push(result);
        this.addToNotificationHistory(userId, result);

        this.logger.error(
          `Failed to send emergency contact notification to ${contact.name}:`,
          error,
        );
      }
    }

    return results;
  }

  /**
   * 批量创建紧急联系人
   */
  async batchCreateContacts(
    userId: string,
    contacts: Omit<CreateContactDto, 'userId'>[],
  ): Promise<EmergencyContact[]> {
    const createPromises = contacts.map((contact) =>
      this.createContact({ ...contact, userId }),
    );

    return Promise.all(createPromises);
  }

  /**
   * 更新联系人优先级
   */
  async updateContactPriority(
    contactId: string,
    userId: string,
    newPriority: number,
  ): Promise<EmergencyContact> {
    // 验证联系人是否存在且属于该用户
    const existingContact = await this.prisma.emergencyContact.findFirst({
      where: { id: contactId, userId },
    });

    if (!existingContact) {
      throw new NotFoundException('紧急联系人不存在或无权限访问');
    }

    // 更新联系人优先级
    const contact = await this.prisma.emergencyContact.update({
      where: { id: contactId },
      data: { priority: newPriority },
    });

    this.logger.log(
      `Emergency contact priority updated: ${contactId} to ${newPriority}`,
    );
    return this.mapToEmergencyContact(contact);
  }

  /**
   * 重新排序联系人优先级
   */
  async reorderContacts(
    userId: string,
    contactIds: string[],
  ): Promise<EmergencyContact[]> {
    // 验证所有联系人都属于该用户
    const contacts = await this.prisma.emergencyContact.findMany({
      where: { userId, id: { in: contactIds } },
    });

    if (contacts.length !== contactIds.length) {
      throw new NotFoundException('部分紧急联系人不存在或无权限访问');
    }

    // 更新优先级
    const updatePromises = contactIds.map((contactId, index) =>
      this.prisma.emergencyContact.update({
        where: { id: contactId },
        data: { priority: index + 1 },
      }),
    );

    const updatedContacts = await Promise.all(updatePromises);

    this.logger.log(`Emergency contacts reordered for user ${userId}`);
    return updatedContacts.map((contact) =>
      this.mapToEmergencyContact(contact),
    );
  }

  /**
   * 获取通知历史
   */
  getNotificationHistory(userId: string): NotificationResult[] {
    return this.notificationHistory.get(userId) || [];
  }

  /**
   * 清除通知历史
   */
  clearNotificationHistory(userId: string): void {
    this.notificationHistory.delete(userId);
  }

  /**
   * 验证手机号格式
   */
  private validatePhoneNumber(phone: string): boolean {
    // 中国手机号正则表达式
    const phoneRegex = /^1[3-9]\d{9}$/;
    return phoneRegex.test(phone);
  }

  /**
   * 获取用户联系人的最大优先级
   */
  private async getMaxPriority(userId: string): Promise<number> {
    const contacts = await this.prisma.emergencyContact.findMany({
      where: { userId },
      select: { priority: true },
      orderBy: { priority: 'desc' },
      take: 1,
    });

    return contacts.length > 0 ? contacts[0].priority : 0;
  }

  /**
   * 添加到通知历史
   */
  private addToNotificationHistory(
    userId: string,
    result: NotificationResult,
  ): void {
    const history = this.notificationHistory.get(userId) || [];
    history.push(result);

    // 限制历史记录大小
    if (history.length > this.MAX_HISTORY_SIZE) {
      history.shift();
    }

    this.notificationHistory.set(userId, history);
  }

  /**
   * 映射到紧急联系人对象
   */
  private mapToEmergencyContact(contact: any): EmergencyContact {
    return {
      id: contact.id,
      userId: contact.userId,
      name: contact.name,
      phone: contact.phone,
      relationship: contact.relationship,
      priority: contact.priority,
      createdAt: contact.createdAt,
    };
  }

  /**
   * 检查用户是否有紧急联系人
   */
  async hasEmergencyContacts(userId: string): Promise<boolean> {
    const count = await this.prisma.emergencyContact.count({
      where: { userId },
    });

    return count > 0;
  }

  /**
   * 获取紧急联系人统计信息
   */
  async getContactStatistics(userId: string): Promise<{
    totalContacts: number;
    contactsByRelationship: Record<string, number>;
    highestPriorityContact?: EmergencyContact;
  }> {
    const contacts = await this.getUserContacts(userId);

    const contactsByRelationship: Record<string, number> = {};

    for (const contact of contacts) {
      const relationship = contact.relationship || 'unknown';
      contactsByRelationship[relationship] =
        (contactsByRelationship[relationship] || 0) + 1;
    }

    return {
      totalContacts: contacts.length,
      contactsByRelationship,
      highestPriorityContact: contacts.length > 0 ? contacts[0] : undefined,
    };
  }
}
