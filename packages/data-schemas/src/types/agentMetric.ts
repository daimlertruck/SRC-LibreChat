export type AgentMetricScope = {
  tenantId?: string;
  agentId: string;
  bucket: Date;
};

export type AgentConversationMetricInput = AgentMetricScope;

export type AgentUserMarkerInput = AgentMetricScope & {
  userId: string;
  occurredAt: Date;
};

export type AgentMetricDelta = AgentMetricScope & {
  conversations?: number;
  successfulResponses?: number;
  failedResponses?: number;
  interruptedResponses?: number;
  thumbsUp?: number;
  thumbsDown?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  costCredits?: number;
  uniqueUsers?: number;
  costUnavailable?: boolean;
  lastUsedAt?: Date;
  failureAt?: Date;
};

export type ScopedAgentMetricRange = {
  tenantId?: string;
  agentId: string;
  fromUtcInclusive: Date;
  toUtcExclusive: Date;
};
