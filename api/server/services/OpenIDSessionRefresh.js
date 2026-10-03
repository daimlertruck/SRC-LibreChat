const jwt = require('jsonwebtoken');
const cookies = require('cookie');
const crypto = require('node:crypto');
const openIdClient = require('openid-client');
const api = require('@librechat/api');
const { logger, DEFAULT_REFRESH_TOKEN_EXPIRY } = require('@librechat/data-schemas');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');
const { getTokenCustodyService } = require('./AuthService');
const { revokeOpenIDRefreshTokenChain } = require('./OpenIDRefreshRecovery');

/**
 * Best-effort revocation of a single refresh token the IdP just issued to a request whose custody
 * record was deleted mid-rotation (logout/ban raced the refresh). Reuses the same chain the logout
 * controller runs so the token — which the rotation never persisted and nothing else will revoke —
 * does not stay live at the IdP. Translates the custody identity to the chain's `identityContext`
 * shape; failures are swallowed by the caller (`revokeOrphanedRefreshToken`), which logs and still
 * fails the session closed.
 */
const revokeRefreshToken = async ({ req, refreshToken, identity }) => {
  await revokeOpenIDRefreshTokenChain({
    req,
    user: req?.user,
    identityContext: {
      appUserId: identity?.userId,
      tenantId: identity?.tenantId,
      openidIssuer: identity?.openidIssuer,
      openidSubject: identity?.openidSubject,
    },
    refreshTokens: [refreshToken],
    ttl: api.math(process.env.REFRESH_TOKEN_EXPIRY, DEFAULT_REFRESH_TOKEN_EXPIRY),
  });
};

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
  revokeRefreshToken,
});
