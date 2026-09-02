import type { TAgentsEndpoint, TFeedback, TFeedbackTagKey } from 'librechat-data-provider';
import type {
  AgentMetricCounter,
  AgentMetricDelta,
  AgentMetricStatus,
  IAgentMetricState,
} from '@librechat/data-schemas';

export type AgentStatisticsContext = Readonly<{
  agentId: string;
  tenantId?: string;
  bucket: string;
  occurredAt: number;
  interactiveUserId?: string;
}>;

type StatisticsAgent = Readonly<{ id?: string; statistics_enabled?: boolean }>;
type StatisticsLogger = Pick<Console, 'error'>;

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
