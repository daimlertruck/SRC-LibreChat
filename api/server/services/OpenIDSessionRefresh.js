const jwt = require('jsonwebtoken');
const cookies = require('cookie');
const crypto = require('node:crypto');
const openIdClient = require('openid-client');
const api = require('@librechat/api');
const { logger, DEFAULT_REFRESH_TOKEN_EXPIRY } = require('@librechat/data-schemas');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');
const { getTokenCustodyService } = require('./AuthService');

module.exports = api.createOpenIDSessionRefreshService({
  jwt,
  cookies,
  crypto,
  openIdClient,
  logger,
  defaultRefreshTokenExpiry: DEFAULT_REFRESH_TOKEN_EXPIRY,
  isEnabled: api.isEnabled,
  math: api.math,
  createAuthIdentityContext: api.createAuthIdentityContext,
  isOpenIDSessionIdentityMatch: api.isOpenIDSessionIdentityMatch,
  createOpenIDRefreshIdentityTuple: api.createOpenIDRefreshIdentityTuple,
  serializeAuthIdentityTuple: api.serializeAuthIdentityTuple,
  buildOpenIDRefreshParams: api.buildOpenIDRefreshParams,
  normalizeExpiresIn: api.normalizeExpiresIn,
  getOpenIdConfig,
  /**
   * The process-wide token custody service and the request-scoped loader. The service is the same
   * instance the refresh controller and `AuthService` use, wired once in `AuthService`. The cookie
   * helpers are the single source of the token key cookie's options.
   */
  getCustody: getTokenCustodyService,
  loadOpenIDCustody: api.loadOpenIDCustody,
  setTokenKeyCookie: api.setTokenKeyCookie,
  clearTokenKeyCookie: api.clearTokenKeyCookie,
});
