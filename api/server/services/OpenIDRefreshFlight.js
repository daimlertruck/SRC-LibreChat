const { createOpenIDRefreshFlightService } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const db = require('~/models');

module.exports = createOpenIDRefreshFlightService({
  db,
  logger,
});
