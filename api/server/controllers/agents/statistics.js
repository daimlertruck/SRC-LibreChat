const { getAgentStatistics } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { parseAgentStatisticsQuery } = require('librechat-data-provider');
const { getAgent, getAgentMetricDailyRange } = require('~/models');

async function statistics(req, res) {
  res.set('Cache-Control', 'private, no-store');

  let range;
  try {
    range = parseAgentStatisticsQuery(req.query);
  } catch (_error) {
    return res.status(400).json({ message: 'Invalid statistics date range' });
  }

  try {
    const agent = req.resourceAccess?.resourceInfo ?? (await getAgent({ id: req.params.id }));
    const result = await getAgentStatistics(
      {
        enabled: req.config?.endpoints?.agents?.statistics === true,
        agent,
        agentId: req.params.id,
        tenantId: req.user?.tenantId,
        range,
      },
      { getAgentMetricDailyRange },
    );
    if (!result) return res.status(404).json({ message: 'Agent statistics not found' });
    return res.json(result);
  } catch (_error) {
    logger.error('[AgentStatistics] Read failed');
    return res.status(503).json({ message: 'Agent statistics are temporarily unavailable' });
  }
}

module.exports = statistics;
