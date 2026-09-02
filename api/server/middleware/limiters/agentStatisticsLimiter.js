const rateLimit = require('express-rate-limit');
const { limiterCache } = require('@librechat/api');

const agentStatisticsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => `${req.user?.tenantId ?? 'default'}:${req.user?.id}`,
  handler: (_req, res) =>
    res.status(429).json({ message: 'Too many agent statistics requests. Try again later' }),
  store: limiterCache('agent_statistics_limiter'),
});

module.exports = { agentStatisticsLimiter };
