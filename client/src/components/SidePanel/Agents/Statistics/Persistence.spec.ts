/**
 * @jest-environment jsdom
 */
import { defaultAgentFormValues } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import { composeAgentUpdatePayload } from '../AgentPanel';

describe('agent statistics persistence', () => {
  it('includes the collection switch in the agent payload', () => {
    const form: AgentForm = {
      ...defaultAgentFormValues,
      agent: undefined,
      provider: 'openai',
      model_parameters: {
        temperature: 1,
        maxContextTokens: null,
        max_context_tokens: null,
        max_output_tokens: null,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
      },
      statistics_enabled: true,
    };

    const { payload } = composeAgentUpdatePayload(form, 'agent_123');

    expect(payload.statistics_enabled).toBe(true);
  });
});
