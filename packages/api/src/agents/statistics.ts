import {
  AGENT_STATISTICS_FAILURES_RESPONSE_LIMIT,
  FEEDBACK_REASON_KEYS,
} from 'librechat-data-provider';
import type {
  AgentStatisticsDailyPoint,
  AgentStatisticsDateRange,
  AgentStatisticsResponse,
  TAgentsEndpoint,
  TFeedback,
  TFeedbackTagKey,
} from 'librechat-data-provider';
import type {
  AgentMetricCounter,
  AgentMetricDelta,
  AgentMetricStatus,
  IAgentMetricDaily,
  IAgentMetricState,
  ScopedAgentMetricRange,
} from '@librechat/data-schemas';

export type AgentStatisticsContext = Readonly<{
  agentId: string;
  tenantId?: string;
  bucket: string;
  occurredAt: number;
  interactiveUserId?: string;
}>;

type StatisticsAgent = Readonly<{
  id?: string;
  tenantId?: string;
  statistics_enabled?: boolean;
}>;
type StatisticsLogger = Pick<Console, 'error'>;

export type AgentStatisticsReadMethods = Readonly<{
  getAgentMetricDailyRange: (input: ScopedAgentMetricRange) => Promise<IAgentMetricDaily[]>;
}>;

const DAY_MS = 24 * 60 * 60 * 1000;
const CREDITS_PER_USD = 1_000_000;

export type AgentStatisticsMethods = Readonly<{
  incrementAgentMetricDaily: (delta: AgentMetricDelta) => Promise<void>;
  decrementAgentMetricDaily: (input: {
    tenantId?: string;
    agentId: string;
    bucket: Date;
    counter: AgentMetricCounter;
  }) => Promise<boolean>;
  upsertAgentUserDaily: (input: {
    tenantId?: string;
    agentId: string;
    userId: string;
    occurredAt: Date;
  }) => Promise<{ inserted: boolean }>;
  transitionAgentMetricState: (input: {
    userId: string;
    conversationId: string;
    messageId: string;
    tenantId?: string;
    statisticsAgentId: string;
    bucket: Date;
    status: AgentMetricStatus;
  }) => Promise<{ previous?: IAgentMetricState; current: IAgentMetricState } | null>;
}>;

const STATUS_COUNTERS: Record<AgentMetricStatus, AgentMetricCounter> = {
  successful: 'successfulResponses',
  failed: 'failedResponses',
  interrupted: 'interruptedResponses',
};

function utcBucket(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function contextDate(context: AgentStatisticsContext): Date | null {
  const occurredAt = new Date(context.occurredAt);
  return Number.isNaN(occurredAt.getTime()) ? null : occurredAt;
}

function contextBucket(context: AgentStatisticsContext): Date | null {
  const bucket = new Date(context.bucket);
  if (Number.isNaN(bucket.getTime()) || bucket.getTime() !== utcBucket(bucket).getTime())
    return null;
  return bucket;
}

function logFailure(logger: StatisticsLogger, operation: string, error: unknown): void {
  logger.error(`[AgentStatistics] ${operation} failed`, error);
}

export function createAgentStatisticsContext(input: {
  endpoint?: Pick<TAgentsEndpoint, 'statistics'>;
  agent?: StatisticsAgent;
  tenantId?: string;
  interactiveUserId?: string;
  occurredAt?: Date;
}): AgentStatisticsContext | null {
  const agentId = input.agent?.id;
  if (
    input.endpoint?.statistics !== true ||
    input.agent?.statistics_enabled !== true ||
    typeof agentId !== 'string' ||
    agentId.length === 0
  ) {
    return null;
  }
  const occurredAt = input.occurredAt ?? new Date();
  if (Number.isNaN(occurredAt.getTime())) return null;
  return Object.freeze({
    agentId,
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
    bucket: utcBucket(occurredAt).toISOString(),
    occurredAt: occurredAt.getTime(),
    ...(input.interactiveUserId ? { interactiveUserId: input.interactiveUserId } : {}),
  });
}

export async function recordAgentInvocation(
  context: AgentStatisticsContext | null,
  methods: AgentStatisticsMethods,
  logger: StatisticsLogger = console,
): Promise<void> {
  if (!context) return;
  const occurredAt = contextDate(context);
  const bucket = contextBucket(context);
  if (!occurredAt || !bucket) return;
  try {
    const marker = context.interactiveUserId
      ? await methods.upsertAgentUserDaily({
          agentId: context.agentId,
          tenantId: context.tenantId,
          userId: context.interactiveUserId,
          occurredAt,
        })
      : null;
    await methods.incrementAgentMetricDaily({
      agentId: context.agentId,
      tenantId: context.tenantId,
      bucket,
      uniqueUsers: marker?.inserted ? 1 : undefined,
      lastUsedAt: occurredAt,
    });
  } catch (error) {
    logFailure(logger, 'invocation projection', error);
  }
}

export async function recordAgentResponse(
  input: {
    context: AgentStatisticsContext | null;
    userId: string;
    conversationId: string;
    messageId: string;
    status: AgentMetricStatus;
    observedAt?: Date;
  },
  methods: AgentStatisticsMethods,
  logger: StatisticsLogger = console,
): Promise<void> {
  const { context } = input;
  const bucket = context ? contextBucket(context) : null;
  const occurredAt = input.observedAt ?? (context ? contextDate(context) : null);
  if (occurredAt && Number.isNaN(occurredAt.getTime())) return;
  if (!context || !bucket || !occurredAt) return;
  try {
    const transition = await methods.transitionAgentMetricState({
      userId: input.userId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      tenantId: context.tenantId,
      statisticsAgentId: context.agentId,
      bucket,
      status: input.status,
    });
    if (!transition || transition.previous?.status === transition.current.status) return;
    if (transition.previous) {
      await methods.decrementAgentMetricDaily({
        agentId: transition.current.statisticsAgentId,
        tenantId: context.tenantId,
        bucket: transition.current.bucket,
        counter: STATUS_COUNTERS[transition.previous.status],
      });
    }
    await methods.incrementAgentMetricDaily({
      agentId: transition.current.statisticsAgentId,
      tenantId: context.tenantId,
      bucket: transition.current.bucket,
      [STATUS_COUNTERS[transition.current.status]]: 1,
      lastUsedAt: occurredAt,
      ...(transition.current.status === 'failed' ? { failureOccurredAt: occurredAt } : {}),
    });
  } catch (error) {
    logFailure(logger, 'response projection', error);
  }
}

type FeedbackState = Readonly<{ rating?: TFeedback['rating']; tag?: TFeedbackTagKey }>;

function feedbackCounters(feedback?: FeedbackState): AgentMetricCounter[] {
  if (!feedback?.rating) return [];
  const counters: AgentMetricCounter[] = [feedback.rating];
  if (feedback.tag) counters.push(`feedbackTags.${feedback.tag}`);
  return counters;
}

export async function projectAgentFeedback(
  input: {
    enabled: boolean;
    tenantId?: string;
    previous?: FeedbackState;
    current?: FeedbackState;
    metricState?: IAgentMetricState;
  },
  methods: Pick<AgentStatisticsMethods, 'incrementAgentMetricDaily' | 'decrementAgentMetricDaily'>,
  logger: StatisticsLogger = console,
): Promise<void> {
  if (!input.enabled || !input.metricState) return;
  const previous = new Set(feedbackCounters(input.previous));
  const current = new Set(feedbackCounters(input.current));
  try {
    for (const counter of previous) {
      if (current.has(counter)) continue;
      await methods.decrementAgentMetricDaily({
        agentId: input.metricState.statisticsAgentId,
        tenantId: input.tenantId,
        bucket: input.metricState.bucket,
        counter,
      });
    }
    const feedbackTags: Partial<Record<TFeedbackTagKey, number>> = {};
    let thumbsUp: number | undefined;
    let thumbsDown: number | undefined;
    for (const counter of current) {
      if (previous.has(counter)) continue;
      if (counter === 'thumbsUp') thumbsUp = 1;
      else if (counter === 'thumbsDown') thumbsDown = 1;
      else feedbackTags[counter.slice('feedbackTags.'.length) as TFeedbackTagKey] = 1;
    }
    await methods.incrementAgentMetricDaily({
      agentId: input.metricState.statisticsAgentId,
      tenantId: input.tenantId,
      bucket: input.metricState.bucket,
      thumbsUp,
      thumbsDown,
      feedbackTags,
    });
  } catch (error) {
    logFailure(logger, 'feedback projection', error);
  }
}

function feedbackTags(
  values: Partial<Record<TFeedbackTagKey, number>> | undefined,
): Partial<Record<TFeedbackTagKey, number>> {
  const result: Partial<Record<TFeedbackTagKey, number>> = {};
  for (const key of FEEDBACK_REASON_KEYS) {
    const value = values?.[key] ?? 0;
    if (value > 0) result[key] = value;
  }
  return result;
}

function metricPoint(date: string, row?: IAgentMetricDaily): AgentStatisticsDailyPoint {
  const successfulResponses = row?.successfulResponses ?? 0;
  const failedResponses = row?.failedResponses ?? 0;
  const interruptedResponses = row?.interruptedResponses ?? 0;
  const inputTokens = row?.inputTokens ?? 0;
  const cacheReadTokens = row?.cacheReadTokens ?? 0;
  const cacheWriteTokens = row?.cacheWriteTokens ?? 0;
  const outputTokens = row?.outputTokens ?? 0;
  const costAvailable = row?.costUnavailable !== true;
  return {
    date,
    conversations: row?.conversations ?? 0,
    successfulResponses,
    failedResponses,
    interruptedResponses,
    responses: successfulResponses + failedResponses + interruptedResponses,
    thumbsUp: row?.thumbsUp ?? 0,
    thumbsDown: row?.thumbsDown ?? 0,
    feedbackTags: feedbackTags(row?.feedbackTags),
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    totalTokens: inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
    costAvailable,
    costUSD: costAvailable ? (row?.costCredits ?? 0) / CREDITS_PER_USD : null,
    uniqueUsers: row?.uniqueUsers ?? 0,
    lastUsedAt: row?.lastUsedAt?.toISOString() ?? null,
  };
}

export async function getAgentStatistics(
  input: {
    enabled: boolean;
    agent: StatisticsAgent | null;
    agentId: string;
    tenantId?: string;
    range: AgentStatisticsDateRange;
  },
  methods: AgentStatisticsReadMethods,
): Promise<AgentStatisticsResponse | null> {
  if (
    !input.enabled ||
    input.agent?.id !== input.agentId ||
    input.agent.statistics_enabled !== true ||
    input.agent.tenantId !== input.tenantId
  )
    return null;

  const rows = await methods.getAgentMetricDailyRange({
    agentId: input.agentId,
    tenantId: input.tenantId,
    fromUtcInclusive: input.range.fromUtcInclusive,
    toUtcExclusive: input.range.toUtcExclusive,
  });
  const rowsByDate = new Map(rows.map((row) => [row.bucket.toISOString().slice(0, 10), row]));
  const daily: AgentStatisticsDailyPoint[] = [];
  const totals = {
    conversations: 0,
    successfulResponses: 0,
    failedResponses: 0,
    interruptedResponses: 0,
    thumbsUp: 0,
    thumbsDown: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    uniqueUsers: 0,
    costUSD: 0,
  };
  const totalFeedback: Partial<Record<TFeedbackTagKey, number>> = {};
  let costAvailable = true;
  let lastUsedAt: string | null = null;
  const recentFailures: Date[] = [];

  for (let offset = 0; offset < input.range.days; offset += 1) {
    const date = new Date(input.range.fromUtcInclusive.getTime() + offset * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const row = rowsByDate.get(date);
    const point = metricPoint(date, row);
    daily.push(point);
    totals.conversations += point.conversations;
    totals.successfulResponses += point.successfulResponses;
    totals.failedResponses += point.failedResponses;
    totals.interruptedResponses += point.interruptedResponses;
    totals.thumbsUp += point.thumbsUp;
    totals.thumbsDown += point.thumbsDown;
    totals.inputTokens += point.inputTokens;
    totals.cacheReadTokens += point.cacheReadTokens;
    totals.cacheWriteTokens += point.cacheWriteTokens;
    totals.outputTokens += point.outputTokens;
    totals.uniqueUsers += point.uniqueUsers;
    if (point.costAvailable) totals.costUSD += point.costUSD ?? 0;
    else costAvailable = false;
    for (const key of FEEDBACK_REASON_KEYS) {
      const value = point.feedbackTags[key] ?? 0;
      if (value > 0) totalFeedback[key] = (totalFeedback[key] ?? 0) + value;
    }
    if (point.lastUsedAt && (!lastUsedAt || point.lastUsedAt > lastUsedAt))
      lastUsedAt = point.lastUsedAt;
    if (row?.recentFailures) recentFailures.push(...row.recentFailures);
  }

  const responses =
    totals.successfulResponses + totals.failedResponses + totals.interruptedResponses;
  const completedResponses = totals.successfulResponses + totals.failedResponses;
  const ratedResponses = totals.thumbsUp + totals.thumbsDown;
  return {
    range: { from: input.range.from, to: input.range.to, days: input.range.days },
    summary: {
      conversations: totals.conversations,
      responses,
      successfulResponses: totals.successfulResponses,
      failedResponses: totals.failedResponses,
      interruptedResponses: totals.interruptedResponses,
      successRate:
        completedResponses === 0 ? null : totals.successfulResponses / completedResponses,
      thumbsUp: totals.thumbsUp,
      thumbsDown: totals.thumbsDown,
      ratedResponses,
      ratingCoverage: responses === 0 ? 0 : ratedResponses / responses,
      feedbackTags: totalFeedback,
      inputTokens: totals.inputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      outputTokens: totals.outputTokens,
      totalTokens:
        totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens,
      costAvailable,
      costUSD: costAvailable ? totals.costUSD : null,
      averageDailyUniqueUsers: totals.uniqueUsers / input.range.days,
      lastUsedAt,
    },
    daily,
    recentFailures: recentFailures
      .sort((left, right) => right.getTime() - left.getTime())
      .slice(0, AGENT_STATISTICS_FAILURES_RESPONSE_LIMIT)
      .map((date) => date.toISOString()),
  };
}
