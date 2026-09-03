import { Schema } from 'mongoose';
import { AGENT_STATISTICS_FAILURE_SOURCES, FEEDBACK_REASON_KEYS } from 'librechat-data-provider';
import type { IAgentMetricDaily, IAgentMetricState, IAgentUserDaily } from '~/types';

const counter = {
  type: Number,
  default: 0,
  min: 0,
  validate: { validator: Number.isFinite, message: 'Metric counters must be finite' },
} as const;
const feedbackTags = Object.fromEntries(FEEDBACK_REASON_KEYS.map((key) => [key, counter]));

export const agentMetricStateSchema: Schema<IAgentMetricState> = new Schema<IAgentMetricState>(
  {
    statisticsAgentId: { type: String, required: true },
    bucket: { type: Date, required: true },
    status: {
      type: String,
      enum: ['successful', 'failed', 'interrupted'],
      required: true,
    },
    feedback: {
      type: {
        rating: { type: String, enum: ['thumbsUp', 'thumbsDown'], required: true },
        tag: { type: String, enum: FEEDBACK_REASON_KEYS },
      },
      _id: false,
      default: undefined,
    },
  },
  { _id: false },
);

export const agentMetricDailySchema: Schema<IAgentMetricDaily> = new Schema<IAgentMetricDaily>(
  {
    tenantId: { type: String },
    agentId: { type: String, required: true },
    bucket: { type: Date, required: true },
    conversations: counter,
    successfulResponses: counter,
    failedResponses: counter,
    interruptedResponses: counter,
    thumbsUp: counter,
    thumbsDown: counter,
    feedbackTags: { type: feedbackTags, _id: false, default: () => ({}) },
    inputTokens: counter,
    cacheReadTokens: counter,
    cacheWriteTokens: counter,
    outputTokens: counter,
    uniqueUsers: counter,
    costCredits: counter,
    costUnavailable: { type: Boolean, default: false },
    recentFailures: {
      type: [
        {
          occurredAt: { type: Date, required: true },
          source: { type: String, enum: AGENT_STATISTICS_FAILURE_SOURCES, required: true },
          message: { type: String, required: true, maxlength: 500 },
          _id: false,
        },
      ],
      default: [],
    },
    lastUsedAt: { type: Date },
  },
  { timestamps: false },
);

agentMetricDailySchema.index({ tenantId: 1, agentId: 1, bucket: 1 }, { unique: true });
agentMetricDailySchema.index({ bucket: 1 }, { expireAfterSeconds: 120 * 24 * 60 * 60 });

export const agentUserDailySchema: Schema<IAgentUserDaily> = new Schema<IAgentUserDaily>(
  {
    tenantId: { type: String },
    agentId: { type: String, required: true },
    userId: { type: String, required: true },
    bucket: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false },
);

agentUserDailySchema.index({ tenantId: 1, agentId: 1, bucket: 1, userId: 1 }, { unique: true });
agentUserDailySchema.index({ userId: 1 });
agentUserDailySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
