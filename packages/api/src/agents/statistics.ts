export type AgentStatisticsContext = Readonly<{
  agentId: string;
  tenantId?: string;
  bucket: string;
  occurredAt: number;
  interactiveUserId?: string;
}>;
