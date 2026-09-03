import { parseAgentStatisticsQuery } from 'librechat-data-provider';
import type { IAgentMetricDaily } from '@librechat/data-schemas';
import { getAgentStatistics } from './statistics';

const range = parseAgentStatisticsQuery(
  { from: '2026-08-30', to: '2026-09-01' },
  new Date('2026-09-02T12:00:00.000Z'),
);

function row(values: Partial<IAgentMetricDaily>): IAgentMetricDaily {
  return values as IAgentMetricDaily;
}

describe('getAgentStatistics', () => {
  it('zero-fills days and derives the allowlisted range summary', async () => {
    const getAgentMetricDailyRange = jest.fn().mockResolvedValue([
      row({
        bucket: new Date('2026-08-30T00:00:00.000Z'),
        conversations: 2,
        successfulResponses: 3,
        failedResponses: 1,
        interruptedResponses: 1,
        thumbsUp: 2,
        thumbsDown: 1,
        feedbackTags: { accurate_reliable: 2 },
        inputTokens: 10,
        cacheReadTokens: 2,
        cacheWriteTokens: 3,
        outputTokens: 5,
        uniqueUsers: 4,
        costCredits: 1_500_000,
        costUnavailable: false,
        recentFailures: [
          {
            occurredAt: new Date('2026-08-30T10:30:00.000Z'),
            source: 'tool',
            message: 'MCP server did not respond',
          },
        ],
        lastUsedAt: new Date('2026-08-30T11:00:00.000Z'),
      }),
      row({
        bucket: new Date('2026-09-01T00:00:00.000Z'),
        conversations: 1,
        successfulResponses: 1,
        failedResponses: 0,
        interruptedResponses: 0,
        thumbsUp: 0,
        thumbsDown: 0,
        feedbackTags: {},
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 2,
        uniqueUsers: 2,
        costCredits: 500_000,
        costUnavailable: false,
        recentFailures: [],
        lastUsedAt: new Date('2026-09-01T09:00:00.000Z'),
      }),
    ]);

    const result = await getAgentStatistics(
      {
        enabled: true,
        agent: { id: 'agent-1', tenantId: 'tenant-1', statistics_enabled: true },
        agentId: 'agent-1',
        tenantId: 'tenant-1',
        range,
      },
      { getAgentMetricDailyRange },
    );

    expect(getAgentMetricDailyRange).toHaveBeenCalledWith({
      agentId: 'agent-1',
      tenantId: 'tenant-1',
      fromUtcInclusive: new Date('2026-08-30T00:00:00.000Z'),
      toUtcExclusive: new Date('2026-09-02T00:00:00.000Z'),
    });
    expect(result?.daily).toHaveLength(3);
    expect(result?.daily[1]).toMatchObject({
      date: '2026-08-31',
      responses: 0,
      totalTokens: 0,
      uniqueUsers: 0,
      costAvailable: true,
      costUSD: 0,
    });
    expect(result?.summary).toMatchObject({
      conversations: 3,
      responses: 6,
      successRate: 0.8,
      ratedResponses: 3,
      ratingCoverage: 0.5,
      feedbackTags: { accurate_reliable: 2 },
      totalTokens: 23,
      costAvailable: true,
      costUSD: 2,
      averageDailyUniqueUsers: 2,
      lastUsedAt: '2026-09-01T09:00:00.000Z',
    });
    expect(result?.recentFailures).toEqual([
      {
        occurredAt: '2026-08-30T10:30:00.000Z',
        source: 'tool',
        message: 'MCP server did not respond',
      },
    ]);
  });

  it('makes range cost unavailable when any stored day is unavailable', async () => {
    const getAgentMetricDailyRange = jest.fn().mockResolvedValue([
      row({
        bucket: new Date('2026-09-01T00:00:00.000Z'),
        costUnavailable: true,
        costCredits: 100,
      }),
    ]);
    const result = await getAgentStatistics(
      {
        enabled: true,
        agent: { id: 'agent-1', statistics_enabled: true },
        agentId: 'agent-1',
        range,
      },
      { getAgentMetricDailyRange },
    );
    expect(result?.summary).toMatchObject({ costAvailable: false, costUSD: null });
    expect(result?.daily[2]).toMatchObject({ costAvailable: false, costUSD: null });
  });

  it.each([
    { enabled: false, agent: { id: 'agent-1', statistics_enabled: true } },
    { enabled: true, agent: { id: 'agent-1', statistics_enabled: false } },
    {
      enabled: true,
      agent: { id: 'agent-1', tenantId: 'other', statistics_enabled: true },
      tenantId: 'tenant-1',
    },
  ])('does not read metric storage when a feature gate fails', async (values) => {
    const getAgentMetricDailyRange = jest.fn();
    await expect(
      getAgentStatistics({ ...values, agentId: 'agent-1', range }, { getAgentMetricDailyRange }),
    ).resolves.toBeNull();
    expect(getAgentMetricDailyRange).not.toHaveBeenCalled();
  });
});
