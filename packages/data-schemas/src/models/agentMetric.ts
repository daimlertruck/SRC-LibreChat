import type { Model } from 'mongoose';
import type { IAgentMetricDaily, IAgentUserDaily } from '~/types';
import { applyTenantIsolation } from './plugins/tenantIsolation';
import { agentMetricDailySchema, agentUserDailySchema } from '~/schema/agentMetric';

export function createAgentMetricDailyModel(
  mongoose: typeof import('mongoose'),
): Model<IAgentMetricDaily> {
  applyTenantIsolation(agentMetricDailySchema);
  return (
    mongoose.models.AgentMetricDaily ||
    mongoose.model<IAgentMetricDaily>('AgentMetricDaily', agentMetricDailySchema)
  );
}

export function createAgentUserDailyModel(
  mongoose: typeof import('mongoose'),
): Model<IAgentUserDaily> {
  applyTenantIsolation(agentUserDailySchema);
  return (
    mongoose.models.AgentUserDaily ||
    mongoose.model<IAgentUserDaily>('AgentUserDaily', agentUserDailySchema)
  );
}
