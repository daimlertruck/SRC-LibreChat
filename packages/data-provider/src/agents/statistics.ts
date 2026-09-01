import { z } from 'zod';
import type { TFeedbackTagKey } from '../feedback';

export const AGENT_STATISTICS_RETENTION_DAYS = 120;
export const AGENT_STATISTICS_VISIBLE_DAYS = 90;
export const AGENT_STATISTICS_DEFAULT_DAYS = 30;
export const AGENT_STATISTICS_MAX_RANGE_DAYS = 90;
export const AGENT_STATISTICS_FAILURES_PER_DAY = 20;
export const AGENT_STATISTICS_FAILURES_RESPONSE_LIMIT = 20;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const rangeQuerySchema = z.object({ range: z.enum(['7d', '30d', '90d']).optional() }).strict();
const dateQuerySchema = z.object({ date: z.string().regex(DATE_PATTERN) }).strict();
const customQuerySchema = z
  .object({ from: z.string().regex(DATE_PATTERN), to: z.string().regex(DATE_PATTERN) })
  .strict();

const baseAgentStatisticsQuerySchema = z.union([
  rangeQuerySchema,
  dateQuerySchema,
  customQuerySchema,
]);

export type AgentStatisticsQuery = z.infer<typeof baseAgentStatisticsQuerySchema>;

export type AgentStatisticsDateRange = {
  from: string;
  to: string;
  days: number;
  fromUtcInclusive: Date;
  toUtcExclusive: Date;
};

export type AgentStatisticsDailyPoint = {
  date: string;
  conversations: number;
  successfulResponses: number;
  failedResponses: number;
  interruptedResponses: number;
  responses: number;
  thumbsUp: number;
  thumbsDown: number;
  feedbackTags: Partial<Record<TFeedbackTagKey, number>>;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
  costAvailable: boolean;
  costUSD: number | null;
  uniqueUsers: number;
  lastUsedAt: string | null;
};

export type AgentStatisticsResponse = {
  range: { from: string; to: string; days: number };
  summary: {
    conversations: number;
    responses: number;
    successfulResponses: number;
    failedResponses: number;
    interruptedResponses: number;
    successRate: number | null;
    thumbsUp: number;
    thumbsDown: number;
    ratedResponses: number;
    ratingCoverage: number;
    feedbackTags: Partial<Record<TFeedbackTagKey, number>>;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    totalTokens: number;
    costAvailable: boolean;
    costUSD: number | null;
    averageDailyUniqueUsers: number;
    lastUsedAt: string | null;
  };
  daily: AgentStatisticsDailyPoint[];
  recentFailures: string[];
};

function parseUtcDate(value: string): Date | null {
  if (!DATE_PATTERN.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcToday(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function resolveInterval(
  query: AgentStatisticsQuery,
  today: Date,
): { from: Date; to: Date } | null {
  if ('date' in query) {
    const date = parseUtcDate(query.date);
    return date ? { from: date, to: date } : null;
  }
  if ('from' in query) {
    const from = parseUtcDate(query.from);
    const to = parseUtcDate(query.to);
    return from && to ? { from, to } : null;
  }
  const days = Number((query.range ?? `${AGENT_STATISTICS_DEFAULT_DAYS}d`).slice(0, -1));
  return { from: new Date(today.getTime() - (days - 1) * DAY_MS), to: today };
}

export function createAgentStatisticsQuerySchema(
  now: () => Date = () => new Date(),
): z.ZodEffects<typeof baseAgentStatisticsQuerySchema> {
  return baseAgentStatisticsQuerySchema.superRefine((query, context) => {
    const today = utcToday(now());
    const interval = resolveInterval(query, today);
    if (!interval) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid calendar date' });
      return;
    }

    const { from, to } = interval;
    const days = Math.floor((to.getTime() - from.getTime()) / DAY_MS) + 1;
    const oldest = new Date(today.getTime() - (AGENT_STATISTICS_VISIBLE_DAYS - 1) * DAY_MS);
    if (from > to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: 'From must not be after to',
      });
    }
    if (to > today) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: 'Future dates are not allowed',
      });
    }
    if (from < oldest) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: 'Date is outside the visible window',
      });
    }
    if (days > AGENT_STATISTICS_MAX_RANGE_DAYS) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Date range is too long' });
    }
  });
}

export const agentStatisticsQuerySchema = createAgentStatisticsQuerySchema();

export function parseAgentStatisticsQuery(
  input: Record<string, string | string[] | undefined>,
  now = new Date(),
): AgentStatisticsDateRange {
  const query = createAgentStatisticsQuerySchema(() => now).parse(input);
  const today = utcToday(now);
  const interval = resolveInterval(query, today);
  if (!interval) throw new z.ZodError([]);
  const { from, to } = interval;
  const days = Math.floor((to.getTime() - from.getTime()) / DAY_MS) + 1;
  return {
    from: formatUtcDate(from),
    to: formatUtcDate(to),
    days,
    fromUtcInclusive: from,
    toUtcExclusive: new Date(to.getTime() + DAY_MS),
  };
}
