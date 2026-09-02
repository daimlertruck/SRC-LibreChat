import { FEEDBACK_REASON_KEYS } from 'librechat-data-provider';
import type { Model, UpdateQuery } from 'mongoose';
import type {
  AgentMetricCounter,
  AgentMetricDelta,
  AgentUserMarkerInput,
  IAgentMetricDaily,
  IAgentUserDaily,
  ScopedAgentMetricRange,
} from '~/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const MARKER_TTL_MS = 48 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 90;
const CLEANUP_BATCH_SIZE = 500;
const OPERATION_TIMEOUT_MS = 10_000;
const COUNTERS = [
  'conversations',
  'successfulResponses',
  'failedResponses',
  'interruptedResponses',
  'thumbsUp',
  'thumbsDown',
  'inputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'uniqueUsers',
  'costCredits',
] as const;
const DECREMENTABLE_COUNTERS = new Set<string>([
  'successfulResponses',
  'failedResponses',
  'interruptedResponses',
  'thumbsUp',
  'thumbsDown',
  ...FEEDBACK_REASON_KEYS.map((key) => `feedbackTags.${key}`),
]);

function tenantFilter(tenantId?: string): { tenantId: string | { $exists: false } } {
  return tenantId == null ? { tenantId: { $exists: false } } : { tenantId };
}

function utcBucket(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function assertDate(date: Date, name: string): void {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error(`Invalid ${name}`);
}

function assertIncrement(value: number, name: string): void {
  const isValid =
    name === 'costCredits'
      ? Number.isFinite(value) && value >= 0
      : Number.isSafeInteger(value) && value >= 0;
  if (!isValid) throw new Error(`Invalid ${name}`);
}

export interface AgentMetricMethods {
  incrementAgentMetricDaily(delta: AgentMetricDelta): Promise<void>;
  decrementAgentMetricDaily(input: {
    tenantId?: string;
    agentId: string;
    bucket: Date;
    counter: AgentMetricCounter;
  }): Promise<boolean>;
  upsertAgentUserDaily(input: AgentUserMarkerInput): Promise<{ inserted: boolean }>;
  getAgentMetricDailyRange(input: ScopedAgentMetricRange): Promise<IAgentMetricDaily[]>;
  deleteAgentStatistics(agentIds: string[], tenantId?: string): Promise<void>;
  deleteAgentUserStatistics(userId: string, tenantId?: string): Promise<void>;
}

export function createAgentMetricMethods(mongoose: typeof import('mongoose')): AgentMetricMethods {
  const Daily = mongoose.models.AgentMetricDaily as Model<IAgentMetricDaily>;
  const Marker = mongoose.models.AgentUserDaily as Model<IAgentUserDaily>;

  async function incrementAgentMetricDaily(delta: AgentMetricDelta): Promise<void> {
    assertDate(delta.bucket, 'bucket');
    if (delta.bucket.getTime() !== utcBucket(delta.bucket).getTime()) {
      throw new Error('Metric bucket must be UTC midnight');
    }
    const increment: Record<string, number> = {};
    for (const field of COUNTERS) {
      const value = delta[field];
      if (value == null || value === 0) continue;
      assertIncrement(value, field);
      increment[field] = value;
    }
    for (const [tag, value] of Object.entries(delta.feedbackTags ?? {})) {
      if (!FEEDBACK_REASON_KEYS.includes(tag as (typeof FEEDBACK_REASON_KEYS)[number])) {
        throw new Error('Invalid feedback tag');
      }
      if (value == null || value === 0) continue;
      assertIncrement(value, `feedbackTags.${tag}`);
      increment[`feedbackTags.${tag}`] = value;
    }

    const update: UpdateQuery<IAgentMetricDaily> = {};
    if (Object.keys(increment).length > 0) update.$inc = increment;
    if (delta.lastUsedAt) {
      assertDate(delta.lastUsedAt, 'lastUsedAt');
      update.$max = { lastUsedAt: delta.lastUsedAt };
    }
    if (delta.costUnavailable) update.$set = { costUnavailable: true };
    if (delta.failureOccurredAt) {
      assertDate(delta.failureOccurredAt, 'failureOccurredAt');
      update.$push = {
        recentFailures: { $each: [delta.failureOccurredAt], $sort: -1, $slice: 20 },
      };
    }
    if (Object.keys(update).length === 0) return;

    const filter = {
      ...tenantFilter(delta.tenantId),
      agentId: delta.agentId,
      bucket: delta.bucket,
    };
    try {
      await Daily.updateOne(filter, update, {
        upsert: true,
        setDefaultsOnInsert: true,
        maxTimeMS: OPERATION_TIMEOUT_MS,
      });
    } catch (error) {
      if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) throw error;
      await Daily.updateOne(filter, update, {
        upsert: false,
        maxTimeMS: OPERATION_TIMEOUT_MS,
      });
    }
  }

  async function decrementAgentMetricDaily(input: {
    tenantId?: string;
    agentId: string;
    bucket: Date;
    counter: AgentMetricCounter;
  }): Promise<boolean> {
    assertDate(input.bucket, 'bucket');
    if (!DECREMENTABLE_COUNTERS.has(input.counter)) throw new Error('Invalid metric counter');
    const result = await Daily.updateOne(
      {
        ...tenantFilter(input.tenantId),
        agentId: input.agentId,
        bucket: input.bucket,
        [input.counter]: { $gt: 0 },
      },
      { $inc: { [input.counter]: -1 } },
      { maxTimeMS: OPERATION_TIMEOUT_MS },
    );
    return result.modifiedCount === 1;
  }

  async function upsertAgentUserDaily(input: AgentUserMarkerInput): Promise<{ inserted: boolean }> {
    assertDate(input.occurredAt, 'occurredAt');
    const bucket = utcBucket(input.occurredAt);
    const expiresAt = new Date(input.occurredAt.getTime() + MARKER_TTL_MS);
    const filter = {
      ...tenantFilter(input.tenantId),
      agentId: input.agentId,
      userId: input.userId,
      bucket,
    };
    try {
      const result = await Marker.updateOne(
        filter,
        { $setOnInsert: { expiresAt } },
        { upsert: true, setDefaultsOnInsert: true, maxTimeMS: OPERATION_TIMEOUT_MS },
      );
      return { inserted: result.upsertedCount === 1 };
    } catch (error) {
      if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
        return { inserted: false };
      }
      throw error;
    }
  }

  async function getAgentMetricDailyRange(
    input: ScopedAgentMetricRange,
  ): Promise<IAgentMetricDaily[]> {
    assertDate(input.fromUtcInclusive, 'fromUtcInclusive');
    assertDate(input.toUtcExclusive, 'toUtcExclusive');
    if (
      input.fromUtcInclusive.getTime() !== utcBucket(input.fromUtcInclusive).getTime() ||
      input.toUtcExclusive.getTime() !== utcBucket(input.toUtcExclusive).getTime()
    ) {
      throw new Error('Metric range bounds must be UTC midnight');
    }
    const days = (input.toUtcExclusive.getTime() - input.fromUtcInclusive.getTime()) / DAY_MS;
    if (days <= 0 || days > MAX_RANGE_DAYS) throw new Error('Invalid metric range');
    return Daily.find({
      ...tenantFilter(input.tenantId),
      agentId: input.agentId,
      bucket: { $gte: input.fromUtcInclusive, $lt: input.toUtcExclusive },
    })
      .sort({ bucket: 1 })
      .limit(MAX_RANGE_DAYS)
      .maxTimeMS(OPERATION_TIMEOUT_MS)
      .lean<IAgentMetricDaily[]>();
  }

  async function deleteAgentStatistics(agentIds: string[], tenantId?: string): Promise<void> {
    for (let index = 0; index < agentIds.length; index += CLEANUP_BATCH_SIZE) {
      const ids = agentIds.slice(index, index + CLEANUP_BATCH_SIZE);
      await Promise.all([
        Daily.deleteMany({ ...tenantFilter(tenantId), agentId: { $in: ids } }).maxTimeMS(
          OPERATION_TIMEOUT_MS,
        ),
        Marker.deleteMany({ ...tenantFilter(tenantId), agentId: { $in: ids } }).maxTimeMS(
          OPERATION_TIMEOUT_MS,
        ),
      ]);
    }
  }

  async function deleteAgentUserStatistics(userId: string, tenantId?: string): Promise<void> {
    await Marker.deleteMany({ ...tenantFilter(tenantId), userId }).maxTimeMS(OPERATION_TIMEOUT_MS);
  }

  return {
    incrementAgentMetricDaily,
    decrementAgentMetricDaily,
    upsertAgentUserDaily,
    getAgentMetricDailyRange,
    deleteAgentStatistics,
    deleteAgentUserStatistics,
  };
}
