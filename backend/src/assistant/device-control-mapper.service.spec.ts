import { DeviceControlMapperService } from './device-control-mapper.service';

describe('DeviceControlMapperService', () => {
  const service = new DeviceControlMapperService();

  it('maps set_sleep_mode into immediate commands and delayed shutdown actions', () => {
    const plan = service.mapToolCall({
      name: 'set_sleep_mode',
      arguments: {
        brightness: 30,
        sound: 'white_noise',
        volume: 65,
        duration_minutes: 30,
      },
    });

    expect(plan.immediateCommands).toHaveLength(2);
    expect(plan.immediateCommands[0].command).toBe('light_control');
    expect(plan.immediateCommands[1].command).toBe('audio_control');
    expect(plan.immediateCommands[1].params.sound).toBe('rain');
    expect(plan.scheduledActions).toHaveLength(2);
    expect(plan.scheduledActions[0].command).toBe('light_control');
    expect(plan.scheduledActions[1].command).toBe('audio_control');
  });
});
