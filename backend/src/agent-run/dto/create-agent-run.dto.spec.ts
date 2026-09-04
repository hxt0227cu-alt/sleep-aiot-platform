import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateAgentRunDto } from './create-agent-run.dto';

describe('CreateAgentRunDto', () => {
  const businessAgentTypes = [
    'sleep_report',
    'sleep_improvement',
    'voice_companion',
    'algorithm_optimization',
  ];

  it.each(businessAgentTypes)(
    'accepts the %s business agent type',
    async (agentType) => {
      const dto = plainToInstance(CreateAgentRunDto, {
        agentType,
        input: {},
        workflowVersion: 'business-v1',
      });

      await expect(validate(dto)).resolves.toHaveLength(0);
    },
  );

  it('rejects an unknown agent type', async () => {
    const dto = plainToInstance(CreateAgentRunDto, {
      agentType: 'unrestricted_agent',
      input: {},
    });

    const errors = await validate(dto);

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: 'agentType' }),
      ]),
    );
  });
});
