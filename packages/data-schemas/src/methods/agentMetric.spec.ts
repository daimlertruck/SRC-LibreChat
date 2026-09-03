import mongoose from 'mongoose';
import { FEEDBACK_TAGS } from 'librechat-data-provider';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { IAgent, IAgentMetricDaily, IAgentUserDaily, IMessage } from '~/types';
import { createAgentMetricMethods } from './agentMetric';
import { createMessageMethods } from './message';
import { createAgentMethods } from './agent';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let Daily: mongoose.Model<IAgentMetricDaily>;
let Marker: mongoose.Model<IAgentUserDaily>;
let Message: mongoose.Model<IMessage>;
let Agent: mongoose.Model<IAgent>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  createModels(mongoose);
  await mongoose.connect(mongoServer.getUri());
  Daily = mongoose.models.AgentMetricDaily as mongoose.Model<IAgentMetricDaily>;
  Marker = mongoose.models.AgentUserDaily as mongoose.Model<IAgentUserDaily>;
  Message = mongoose.models.Message as mongoose.Model<IMessage>;
  Agent = mongoose.models.Agent as mongoose.Model<IAgent>;
  await Promise.all([Daily.syncIndexes(), Marker.syncIndexes()]);
}, 30_000);

afterEach(async () => {
  await Promise.all([
    Daily.deleteMany({}),
    Marker.deleteMany({}),
    Message.deleteMany({}),
    Agent.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('agent metric storage foundation', () => {
  const methods = () => createAgentMetricMethods(mongoose);
  const bucket = new Date('2026-09-01T00:00:00.000Z');

  it('defines the unique and TTL indexes', () => {
    expect(Daily.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { tenantId: 1, agentId: 1, bucket: 1 },
          { unique: true, background: true },
        ],
        [{ bucket: 1 }, { expireAfterSeconds: 10_368_000, background: true }],
      ]),
    );
    expect(Marker.schema.indexes()).toEqual(
      expect.arrayContaining([
        [
          { tenantId: 1, agentId: 1, bucket: 1, userId: 1 },
          { unique: true, background: true },
        ],
        [{ userId: 1 }, { background: true }],
        [{ expiresAt: 1 }, { expireAfterSeconds: 0, background: true }],
      ]),
    );
  });

  it('atomically increments a daily bucket and bounds failures', async () => {
    const { incrementAgentMetricDaily } = methods();
    for (let index = 0; index < 25; index += 1) {
      await incrementAgentMetricDaily({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        bucket,
        successfulResponses: 1,
        feedbackTags: { accurate_reliable: 1 },
        failure: {
          occurredAt: new Date(bucket.getTime() + index * 1000),
          source: index % 2 === 0 ? 'tool' : 'llm',
          message: `Failure ${index}`,
        },
        lastUsedAt: new Date(bucket.getTime() + index * 1000),
      });
    }
    const row = await Daily.findOne({ tenantId: 'tenant-1', agentId: 'agent-1', bucket }).lean();
    expect(row).toMatchObject({
      successfulResponses: 25,
      feedbackTags: { accurate_reliable: 25 },
      costCredits: 0,
      costUnavailable: false,
    });
    expect(row?.recentFailures).toHaveLength(20);
    expect(row?.recentFailures[0]).toMatchObject({
      occurredAt: new Date(bucket.getTime() + 24_000),
      source: 'tool',
      message: 'Failure 24',
    });
    await expect(
      incrementAgentMetricDaily({
        agentId: 'agent-1',
        bucket,
        failure: { occurredAt: bucket, source: 'agent', message: 'x'.repeat(501) },
      }),
    ).rejects.toThrow('Invalid failure message');
  });

  it('accepts fractional committed-cost credits while keeping token counters integral', async () => {
    const { incrementAgentMetricDaily } = methods();
    await incrementAgentMetricDaily({
      agentId: 'agent-cost',
      bucket,
      inputTokens: 1,
      costCredits: 0.25,
    });
    const stored = await Daily.findOne({ agentId: 'agent-cost', bucket }).lean();
    expect(stored?.costCredits).toBe(0.25);
    await expect(
      incrementAgentMetricDaily({
        agentId: 'agent-cost',
        bucket,
        inputTokens: 0.25,
      }),
    ).rejects.toThrow('Invalid inputTokens');
  });

  it('does not lose concurrent first increments without a tenant', async () => {
    const { incrementAgentMetricDaily } = methods();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        incrementAgentMetricDaily({
          agentId: 'agent-1',
          bucket,
          successfulResponses: 1,
        }),
      ),
    );
    const row = await Daily.findOne({ tenantId: { $exists: false }, agentId: 'agent-1', bucket });
    expect(row?.successfulResponses).toBe(20);
  });

  it('deduplicates concurrent daily users and keeps first-interaction expiry', async () => {
    const { upsertAgentUserDaily } = methods();
    const occurredAt = new Date('2026-09-01T11:12:13.000Z');
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        upsertAgentUserDaily({
          tenantId: 'tenant-1',
          agentId: 'agent-1',
          userId: 'user-1',
          occurredAt,
        }),
      ),
    );
    expect(results.filter(({ inserted }) => inserted)).toHaveLength(1);
    const marker = await Marker.findOne({ tenantId: 'tenant-1' }).lean();
    expect(marker?.bucket).toEqual(bucket);
    expect(marker?.expiresAt).toEqual(new Date(occurredAt.getTime() + 48 * 60 * 60 * 1000));
  });

  it('isolates ranges and cleanup by tenant and exact agent IDs', async () => {
    const metricMethods = methods();
    await Promise.all([
      metricMethods.incrementAgentMetricDaily({
        tenantId: 'tenant-1',
        agentId: 'same',
        bucket,
        conversations: 1,
      }),
      metricMethods.incrementAgentMetricDaily({
        tenantId: 'tenant-2',
        agentId: 'same',
        bucket,
        conversations: 2,
      }),
    ]);
    const rows = await metricMethods.getAgentMetricDailyRange({
      tenantId: 'tenant-1',
      agentId: 'same',
      fromUtcInclusive: bucket,
      toUtcExclusive: new Date(bucket.getTime() + 24 * 60 * 60 * 1000),
    });
    expect(rows.map(({ conversations }) => conversations)).toEqual([1]);
    await metricMethods.deleteAgentStatistics(['same'], 'tenant-1');
    expect(await Daily.countDocuments({ tenantId: 'tenant-1' })).toBe(0);
    expect(await Daily.countDocuments({ tenantId: 'tenant-2' })).toBe(1);
  });

  it('uses the scoped compound index for bounded daily reads', async () => {
    await Daily.create({ tenantId: 'tenant-1', agentId: 'agent-1', bucket });
    const explanation = await Daily.collection
      .find({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        bucket: { $gte: bucket, $lt: new Date(bucket.getTime() + 24 * 60 * 60 * 1000) },
      })
      .sort({ bucket: 1 })
      .limit(90)
      .explain('executionStats');

    expect(JSON.stringify(explanation.queryPlanner.winningPlan)).toContain(
      'tenantId_1_agentId_1_bucket_1',
    );
    expect(explanation.executionStats.totalDocsExamined).toBe(1);
  });

  it('conditionally decrements counters without underflow', async () => {
    const metricMethods = methods();
    await metricMethods.incrementAgentMetricDaily({
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      bucket,
      thumbsUp: 1,
    });
    const input = {
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      bucket,
      counter: 'thumbsUp' as const,
    };
    expect(await metricMethods.decrementAgentMetricDaily(input)).toBe(true);
    expect(await metricMethods.decrementAgentMetricDaily(input)).toBe(false);
  });

  it('keeps message metric state private and returns transition preimages', async () => {
    const messageMethods = createMessageMethods(mongoose);
    await Message.create({
      user: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      isCreatedByUser: false,
      endpoint: 'openAI',
      langfuseSampled: true,
      langfuseDestinationIds: ['destination-1'],
    });
    const scope = {
      tenantId: undefined,
      userId: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
    };
    const first = await messageMethods.transitionAgentMetricState({
      ...scope,
      statisticsAgentId: 'agent-1',
      bucket,
      status: 'successful',
    });
    expect(first?.previous).toBeUndefined();
    expect(
      (await Message.findOne({ messageId: 'message-1' }).lean())?.agentMetricState,
    ).toBeUndefined();
    const second = await messageMethods.transitionAgentMetricState({
      ...scope,
      statisticsAgentId: 'agent-2',
      bucket: new Date('2026-09-02T00:00:00.000Z'),
      status: 'failed',
    });
    expect(second?.previous?.status).toBe('successful');
    expect(second?.current).toMatchObject({ statisticsAgentId: 'agent-1', bucket });
    const lowerPriority = await messageMethods.transitionAgentMetricState({
      ...scope,
      statisticsAgentId: 'agent-2',
      bucket: new Date('2026-09-02T00:00:00.000Z'),
      status: 'successful',
    });
    expect(lowerPriority?.previous?.status).toBe('failed');
    expect(lowerPriority?.current.status).toBe('failed');
    const feedback = { rating: 'thumbsUp' as const, tag: FEEDBACK_TAGS[7] };
    const feedbackResult = await messageMethods.updateMessageFeedbackWithMetricState({
      ...scope,
      feedback,
    });
    expect(feedbackResult?.metricState?.status).toBe('failed');
    expect(feedbackResult?.message).toMatchObject({
      endpoint: 'openAI',
      langfuseSampled: true,
      langfuseDestinationIds: ['destination-1'],
      feedback,
    });
    const stored = await Message.findOne({ messageId: 'message-1' })
      .select('+agentMetricState')
      .lean();
    expect(stored?.agentMetricState?.feedback).toEqual({
      rating: 'thumbsUp',
      tag: 'accurate_reliable',
    });
  });

  it('validates private status and feedback updates', async () => {
    const messageMethods = createMessageMethods(mongoose);
    await Message.create({
      user: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      isCreatedByUser: false,
    });
    const scope = {
      userId: 'user-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
    };
    await expect(
      messageMethods.transitionAgentMetricState({
        ...scope,
        statisticsAgentId: 'agent-1',
        bucket,
        status: 'invalid' as never,
      }),
    ).rejects.toThrow();
    await messageMethods.transitionAgentMetricState({
      ...scope,
      statisticsAgentId: 'agent-1',
      bucket,
      status: 'successful',
    });
    await expect(
      messageMethods.updateMessageFeedbackWithMetricState({
        ...scope,
        feedback: { rating: 'invalid' as never, tag: undefined },
      }),
    ).rejects.toThrow();
  });

  it('persists the opt-in through create, update, versions, and expanded reads', async () => {
    const agentMethods = createAgentMethods(mongoose, {
      removeAllPermissions: async () => undefined,
      getActions: async () => [],
      getSoleOwnedResourceIds: async () => [],
    });
    const author = new mongoose.Types.ObjectId();
    const created = await agentMethods.createAgent({
      id: 'agent-1',
      name: 'Agent',
      provider: 'openAI',
      model: 'model-1',
      author,
      statistics_enabled: true,
    });
    expect(created.statistics_enabled).toBe(true);
    expect(created.versions?.[0].statistics_enabled).toBe(true);
    const updated = await agentMethods.updateAgent(
      { id: 'agent-1' },
      { statistics_enabled: false },
    );
    expect(updated?.statistics_enabled).toBe(false);
    expect(updated?.versions?.at(-1)?.statistics_enabled).toBe(false);
    expect(
      (await agentMethods.getAgentWithVersionCount({ id: 'agent-1' }))?.statistics_enabled,
    ).toBe(false);
    const defaultOff = await agentMethods.createAgent({
      id: 'agent-2',
      provider: 'openAI',
      model: 'model-1',
      author,
    });
    expect(defaultOff.statistics_enabled).toBeUndefined();
  });
});
