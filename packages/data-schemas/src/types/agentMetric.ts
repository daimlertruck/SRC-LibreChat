import type { AgentStatisticsFailureSource, TFeedbackTagKey } from 'librechat-data-provider';
import type { Document } from 'mongoose';

export interface IAgentMetricDaily extends Document {
  tenantId?: string;
  agentId: string;
  bucket: Date;
  conversations: number;
  successfulResponses: number;
  failedResponses: number;
  interruptedResponses: number;
  thumbsUp: number;
  thumbsDown: number;
  feedbackTags: Partial<Record<TFeedbackTagKey, number>>;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  uniqueUsers: number;
  costCredits: number;
  costUnavailable: boolean;
  recentFailures: Array<{
    occurredAt: Date;
    source: AgentStatisticsFailureSource;
    message: string;
  }>;
  lastUsedAt?: Date;
}

export interface IAgentUserDaily extends Document {
  tenantId?: string;
  agentId: string;
  userId: string;
  bucket: Date;
  expiresAt: Date;
}

export type AgentMetricScope = Readonly<{
  tenantId?: string;
  agentId: string;
}>;

export type AgentConversationMetricInput = AgentMetricScope &
  Readonly<{
    occurredAt: Date;
  }>;

export type AgentUserMarkerInput = AgentMetricScope &
  Readonly<{
    userId: string;
    occurredAt: Date;
  }>;

export type AgentMetricDelta = AgentMetricScope &
  Readonly<{
    bucket: Date;
    conversations?: number;
    successfulResponses?: number;
    failedResponses?: number;
    interruptedResponses?: number;
    thumbsUp?: number;
    thumbsDown?: number;
    feedbackTags?: Partial<Record<TFeedbackTagKey, number>>;
    inputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    outputTokens?: number;
    costCredits?: number;
    uniqueUsers?: number;
    costUnavailable?: true;
    lastUsedAt?: Date;
    failure?: { occurredAt: Date; source: AgentStatisticsFailureSource; message: string };
  }>;

export type ScopedAgentMetricRange = AgentMetricScope &
  Readonly<{
    fromUtcInclusive: Date;
    toUtcExclusive: Date;
  }>;

export type AgentMetricCounter =
  | 'successfulResponses'
  | 'failedResponses'
  | 'interruptedResponses'
  | 'thumbsUp'
  | 'thumbsDown'
  | `feedbackTags.${TFeedbackTagKey}`;
