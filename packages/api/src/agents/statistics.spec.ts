import fs from 'fs';
import path from 'path';
import {
  createAgentStatisticsContext,
  projectAgentFeedback,
  recordAgentInvocation,
  recordAgentResponse,
} from './statistics';
import type { AgentStatisticsMethods } from './statistics';
import type { AgentStatisticsContext } from './statistics';

const CALLERS = [
  { caller: 'persisted AgentClient root chat', covered: true, interactiveUser: true },
  { caller: 'detached recorder from covered parent', covered: true, interactiveUser: false },
  { caller: 'Responses API store:true', covered: true, interactiveUser: true },
  { caller: 'scheduled or service persisted root flow', covered: true, interactiveUser: false },
  { caller: 'Responses API store:false', covered: false, interactiveUser: false },
  { caller: 'OpenAI-compatible stateless completion', covered: false, interactiveUser: false },
  { caller: 'subagent or handoff child dashboard subject', covered: false, interactiveUser: false },
] as const;

const CALLER_INVENTORY = {
  'api/server/controllers/agents/client.js': 6,
  'api/server/controllers/agents/openai.js': 1,
  'api/server/controllers/agents/responses.js': 2,
  'api/server/middleware/abortMiddleware.js': 1,
  'packages/api/src/agents/usage.ts': 2,
} as const;

const USAGE_CONTEXT_INVENTORY = [
  ['api/server/controllers/agents/client.js', 'agentStatistics: this.agentStatisticsContext', 2],
  ['api/server/controllers/agents/responses.js', 'agentStatistics: statisticsContext', 2],
  ['api/server/middleware/abortMiddleware.js', 'agentStatistics: statisticsContext', 1],
  ['packages/api/src/agents/usage.ts', 'agentStatistics: billing.agentStatistics', 1],
  ['api/server/controllers/agents/openai.js', 'agentStatistics:', 0],
] as const;

function productionFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(file);
    if (!/\.[jt]s$/.test(entry.name) || /\.(spec|test)\.[jt]s$/.test(entry.name)) return [];
    return [file];
  });
}

function usageCallCount(file: string): number {
  const source = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  return source.match(/recordCollectedUsage\s*\(/g)?.length ?? 0;
}

describe('agent statistics Phase 0 contracts', () => {
  it.each(CALLERS)('$caller has an explicit coverage decision', (entry) => {
    expect(typeof entry.covered).toBe('boolean');
    expect(entry.interactiveUser && !entry.covered).toBe(false);
  });

  it('defines the server-authorized runtime context', () => {
    const context: AgentStatisticsContext = {
      agentId: 'agent-1',
      tenantId: 'tenant-1',
      bucket: '2026-09-01',
      occurredAt: Date.parse('2026-09-01T10:00:00.000Z'),
      interactiveUserId: 'user-1',
    };
    expect(context.agentId).toBe('agent-1');
  });

  it('inventories every production recordCollectedUsage occurrence', () => {
    const roots = ['api/server', 'packages/api/src'];
    const actual = Object.fromEntries(
      roots
        .flatMap(productionFiles)
        .map((file) => path.relative(process.cwd(), file).replaceAll('\\', '/'))
        .map((file) => [file, usageCallCount(file)] as const)
        .filter(([, count]) => count > 0),
    );
    expect(actual).toEqual(CALLER_INVENTORY);
  });

  it.each(USAGE_CONTEXT_INVENTORY)(
    '%s has the expected root statistics context coverage',
    (file, marker, expected) => {
      const source = fs.readFileSync(file, 'utf8');
      expect(source.split(marker)).toHaveLength(expected + 1);
    },
  );
});

function methods(): jest.Mocked<AgentStatisticsMethods> {
  return {
    incrementAgentMetricDaily: jest.fn().mockResolvedValue(undefined),
    decrementAgentMetricDaily: jest.fn().mockResolvedValue(true),
    upsertAgentUserDaily: jest.fn().mockResolvedValue({ inserted: true }),
    transitionAgentMetricState: jest.fn().mockResolvedValue(null),
  };
}

const occurredAt = new Date('2026-08-31T15:20:00.000Z');

describe('agent statistics projection', () => {
  test('requires both feature gates and creates an immutable UTC context', () => {
    expect(
      createAgentStatisticsContext({
        endpoint: { statistics: true },
        agent: { id: 'agent-1', statistics_enabled: false },
      }),
    ).toBeNull();
    const context = createAgentStatisticsContext({
      endpoint: { statistics: true },
      agent: { id: 'agent-1', statistics_enabled: true },
      tenantId: 'tenant-1',
      interactiveUserId: 'user-1',
      occurredAt,
    });
    expect(context).toEqual({
      agentId: 'agent-1',
      tenantId: 'tenant-1',
      interactiveUserId: 'user-1',
      bucket: '2026-08-31T00:00:00.000Z',
      occurredAt: occurredAt.getTime(),
    });
    expect(Object.isFrozen(context)).toBe(true);
  });

  test('increments unique users only for a newly inserted marker', async () => {
    const db = methods();
    db.upsertAgentUserDaily.mockResolvedValue({ inserted: false });
    const context = createAgentStatisticsContext({
      endpoint: { statistics: true },
      agent: { id: 'agent-1', statistics_enabled: true },
      interactiveUserId: 'user-1',
      occurredAt,
    });
    await recordAgentInvocation(context, db);
    expect(db.incrementAgentMetricDaily).toHaveBeenCalledWith(
      expect.objectContaining({ uniqueUsers: undefined, lastUsedAt: occurredAt }),
    );
  });

  test('advances last-used time for a service invocation without a user marker', async () => {
    const db = methods();
    const context = createAgentStatisticsContext({
      endpoint: { statistics: true },
      agent: { id: 'agent-1', statistics_enabled: true },
      occurredAt,
    });
    await recordAgentInvocation(context, db);
    expect(db.upsertAgentUserDaily).not.toHaveBeenCalled();
    expect(db.incrementAgentMetricDaily).toHaveBeenCalledWith(
      expect.objectContaining({ uniqueUsers: undefined, lastUsedAt: occurredAt }),
    );
  });

  test('corrects a changed terminal status and ignores a retry', async () => {
    const db = methods();
    const context = createAgentStatisticsContext({
      endpoint: { statistics: true },
      agent: { id: 'agent-1', statistics_enabled: true },
      interactiveUserId: 'user-1',
      occurredAt,
    });
    db.transitionAgentMetricState.mockResolvedValueOnce({
      previous: { statisticsAgentId: 'agent-1', bucket: new Date('2026-08-31'), status: 'failed' },
      current: {
        statisticsAgentId: 'agent-1',
        bucket: new Date('2026-08-31'),
        status: 'successful',
      },
    });
    await recordAgentResponse(
      {
        context,
        userId: 'user-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
        status: 'successful',
      },
      db,
    );
    expect(db.decrementAgentMetricDaily).toHaveBeenCalledWith(
      expect.objectContaining({ counter: 'failedResponses' }),
    );
    expect(db.incrementAgentMetricDaily).toHaveBeenCalledWith(
      expect.objectContaining({ successfulResponses: 1 }),
    );

    db.transitionAgentMetricState.mockResolvedValueOnce({
      previous: {
        statisticsAgentId: 'agent-1',
        bucket: new Date('2026-08-31'),
        status: 'successful',
      },
      current: {
        statisticsAgentId: 'agent-1',
        bucket: new Date('2026-08-31'),
        status: 'successful',
      },
    });
    await recordAgentResponse(
      {
        context,
        userId: 'user-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
        status: 'successful',
      },
      db,
    );
    expect(db.incrementAgentMetricDaily).toHaveBeenCalledTimes(1);
  });

  test('projects exact feedback rating and category corrections', async () => {
    const db = methods();
    await projectAgentFeedback(
      {
        enabled: true,
        previous: { rating: 'thumbsDown', tag: 'inaccurate' },
        current: { rating: 'thumbsUp', tag: 'accurate_reliable' },
        metricState: {
          statisticsAgentId: 'agent-1',
          bucket: new Date('2026-08-31'),
          status: 'successful',
        },
      },
      db,
    );
    expect(db.decrementAgentMetricDaily).toHaveBeenCalledTimes(2);
    expect(db.incrementAgentMetricDaily).toHaveBeenCalledWith(
      expect.objectContaining({
        thumbsUp: 1,
        feedbackTags: { accurate_reliable: 1 },
      }),
    );
  });

  test('isolates projection failures', async () => {
    const db = methods();
    const logger = { error: jest.fn() };
    db.upsertAgentUserDaily.mockRejectedValue(new Error('unavailable'));
    const context = createAgentStatisticsContext({
      endpoint: { statistics: true },
      agent: { id: 'agent-1', statistics_enabled: true },
      interactiveUserId: 'user-1',
      occurredAt,
    });
    await expect(recordAgentInvocation(context, db, logger)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
