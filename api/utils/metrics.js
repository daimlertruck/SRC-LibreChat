const promClient = require('prom-client');

// Create metrics registry
const register = new promClient.Registry();

// Define metrics
const metrics = {
  presignedUrlsGenerated: new promClient.Counter({
    name: 'agent_presigned_urls_generated_total',
    help: 'Total number of presigned URLs generated',
    labelNames: ['status', 'storage_type'],
    registers: [register],
  }),

  presignedUrlGenerationDuration: new promClient.Histogram({
    name: 'agent_presigned_url_generation_duration_seconds',
    help: 'Duration of presigned URL generation',
    labelNames: ['status'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
    registers: [register],
  }),

  fileAccessDenied: new promClient.Counter({
    name: 'agent_file_access_denied_total',
    help: 'Total number of file access denials',
    labelNames: ['reason'],
    registers: [register],
  }),

  cacheHits: new promClient.Counter({
    name: 'agent_cache_hits_total',
    help: 'Cache hit count',
    labelNames: ['cache'],
    registers: [register],
  }),

  suspiciousActivity: new promClient.Counter({
    name: 'agent_suspicious_activity_total',
    help: 'Suspicious activity detection',
    labelNames: ['type'],
    registers: [register],
  }),

  circuitBreakerOpen: new promClient.Counter({
    name: 'agent_circuit_breaker_open_total',
    help: 'Circuit breaker open events',
    labelNames: ['service'],
    registers: [register],
  }),
};

// Collect default metrics
promClient.collectDefaultMetrics({ register });

module.exports = {
  metrics,
  register,
};
