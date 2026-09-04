import { AssistantService } from './assistant.service';

describe('AssistantService', () => {
  const prisma = {
    scheduledDeviceAction: {
      create: jest.fn(),
    },
  } as any;

  const sleepService = {
    getReport: jest.fn(),
  } as any;

  const deviceService = {
    sendCommand: jest.fn(),
  } as any;

  const llmProvider = {
    generateStructuredJson: jest.fn(),
    planDeviceControl: jest.fn(),
  } as any;

  const promptBuilder = {
    buildSleepReportExplanationPrompts: jest.fn(),
    buildDeviceControlPrompts: jest.fn(),
  } as any;

  const responseGuard = {
    validateSleepExplanation: jest.fn(),
    validateToolCall: jest.fn(),
  } as any;

  const deviceControlMapper = {
    mapToolCall: jest.fn(),
  } as any;

  const knowledgeService = {
    answerQuestion: jest.fn(),
  } as any;

  const service = new AssistantService(
    prisma,
    sleepService,
    deviceService,
    llmProvider,
    promptBuilder,
    responseGuard,
    deviceControlMapper,
    knowledgeService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates delayed shutdown tasks for scheduled actions', async () => {
    promptBuilder.buildDeviceControlPrompts.mockReturnValue({
      systemPrompt: 'system',
      userPrompt: 'user',
    });
    llmProvider.planDeviceControl.mockResolvedValue({
      name: 'set_sleep_mode',
      arguments: { brightness: 30, duration_minutes: 30 },
      rawToolCallId: 'tool_1',
    });
    responseGuard.validateToolCall.mockImplementation((value: any) => value);
    deviceControlMapper.mapToolCall.mockReturnValue({
      summary: ['设置助眠灯'],
      immediateCommands: [
        {
          command: 'light_control',
          params: { power: true, brightness: 30 },
          timeout: 8000,
          summary: '立刻调暗灯光',
        },
      ],
      scheduledActions: [
        {
          actionType: 'light_shutdown',
          command: 'light_control',
          params: { power: false },
          executeAt: new Date('2026-05-29T22:30:00.000Z'),
          delayMinutes: 30,
          summary: '30 分钟后关闭灯光',
        },
      ],
    });
    deviceService.sendCommand.mockResolvedValue({ status: 'success' });
    prisma.scheduledDeviceAction.create.mockResolvedValue({
      id: 'schedule_1',
      actionType: 'light_shutdown',
      command: 'light_control',
      params: { power: false },
      executeAt: new Date('2026-05-29T22:30:00.000Z'),
      status: 'pending',
    });

    const result = await service.controlDevice('user_1', {
      deviceId: 'lamp_001',
      text: '把灯光调暗一点，30 分钟后关闭',
      source: 'text',
    });

    expect(deviceService.sendCommand).toHaveBeenCalledWith(
      'lamp_001',
      'user_1',
      expect.objectContaining({
        command: 'light_control',
      }),
    );
    expect(prisma.scheduledDeviceAction.create).toHaveBeenCalledTimes(1);
    expect(result.scheduledActions).toHaveLength(1);
  });
});
