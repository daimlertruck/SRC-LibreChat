import { z } from 'zod';
import type { Agent, AgentCreateParams, AgentUpdateParams } from '../types/assistants';
import { agentsEndpointSchema } from '../config';
import {
  AGENT_STATISTICS_DEFAULT_DAYS,
  agentStatisticsQuerySchema,
  parseAgentStatisticsQuery,
} from './statistics';

const NOW = new Date('2026-09-01T15:30:00.000Z');

describe('agent statistics contracts', () => {
  it('defaults to the last 30 UTC calendar days', () => {
    expect(parseAgentStatisticsQuery({}, NOW)).toEqual({
      from: '2026-08-03',
      to: '2026-09-01',
      days: AGENT_STATISTICS_DEFAULT_DAYS,
      fromUtcInclusive: new Date('2026-08-03T00:00:00.000Z'),
      toUtcExclusive: new Date('2026-09-02T00:00:00.000Z'),
    });
  });

  it.each([
    [{ range: '7d' }, '2026-08-26', '2026-09-01', 7],
    [{ date: '2026-08-15' }, '2026-08-15', '2026-08-15', 1],
    [{ from: '2026-08-01', to: '2026-08-31' }, '2026-08-01', '2026-08-31', 31],
  ])('accepts valid query %p', (query, from, to, days) => {
    expect(parseAgentStatisticsQuery(query, NOW)).toMatchObject({ from, to, days });
  });

  it.each([
    { date: '2026-02-30' },
    { date: '2026-09-02' },
    { date: '2026-06-03' },
    { from: '2026-08-02' },
    { from: '2026-08-20', to: '2026-08-10' },
    { from: '2026-06-03', to: '2026-09-01' },
    { range: '7d', date: '2026-09-01' },
    { range: '14d' },
    { unexpected: 'value' },
  ])('rejects invalid query %p', (query) => {
    expect(() => parseAgentStatisticsQuery(query, NOW)).toThrow(z.ZodError);
  });

  it('keeps the deployment feature disabled by default', () => {
    expect(agentsEndpointSchema.parse(undefined).statistics).toBe(false);
    expect(agentsEndpointSchema.parse({ statistics: true }).statistics).toBe(true);
  });

  it('carries the per-agent opt-in through shared contracts', () => {
    const agent = { statistics_enabled: true } as Agent;
    const create = { statistics_enabled: agent.statistics_enabled } as AgentCreateParams;
    const update = { statistics_enabled: false } as AgentUpdateParams;
    expect(create.statistics_enabled).toBe(true);
    expect(update.statistics_enabled).toBe(false);
    expect(agentStatisticsQuerySchema.safeParse({}).success).toBe(true);
  });

  it('rejects invalid calendar dates through the exported schema', () => {
    expect(agentStatisticsQuerySchema.safeParse({ date: '2026-02-30' }).success).toBe(false);
  });
});
