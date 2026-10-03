const cookies = require('cookie');
const jwt = require('jsonwebtoken');
const { logger, runAsSystem, tenantStorage, getTenantId } = require('@librechat/data-schemas');
const {
  isEnabled,
  isOpenIDRefreshOwnershipError,
  isOpenIDSessionMissingError,
  loadOpenIDCustody,
  parseTokenKey,
  hashTokenKey,
  createAuthIdentityContext,
  resolveGraphApiToken,
  OPENID_USER_ID_COOKIE,
} = require('@librechat/api');
const {
  requestPasswordReset,
  clearOpenIDAuthTokens,
  setCloudFrontAuthCookies,
  getOpenIDAppAuthToken,
  getTokenCustodyService,
  resetPassword,
  setAuthTokens,
  registerUser,
} = require('~/server/services/AuthService');
const { deleteAllUserSessions, getUserById, findSession, deleteTokens } = require('~/models');
const { getGraphApiToken } = require('~/server/services/GraphTokenService');
const {
  refreshOpenIDSession,
  createOpenIDSessionTokenProvider,
} = require('~/server/services/OpenIDSessionRefresh');

const AUTH_REFRESH_USER_PROJECTION = '-password -__v -totpSecret -backupCodes -federatedTokens';

/** The app auth token prefers `id_token` for JWKS validation; see `getOpenIDAppAuthToken`. */
const OPENID_REFRESH_TOKEN_PREFERENCE = 'id_token';

/** The custody service surfaces a missing session as an error carrying this `code`. */
const isOpenIDSessionMissingCode = (error) => error?.code === 'OPENID_SESSION_MISSING';

const registrationController = async (req, res) => {
  try {
    const response = await registerUser(req.body);
    const { status, message } = response;
    /** Consume the invite only once the account exists. `registerUser` returns the same
     * 200 whether it created a user or found the email already in use, so the decision
     * rests on `userCreated` rather than the status. A failure to delete leaves a
     * usable invite, which is recoverable; failing the response here would tell a user
     * whose account was just created that registration failed, which is not. */
    if (response.userCreated === true && req.invite?.token != null) {
      try {
        await deleteTokens({ token: req.invite.token });
      } catch (error) {
        logger.error('[registrationController] Failed to consume invite after registration', error);
      }
    }
    res.status(status).send({ message });
  } catch (err) {
    logger.error('[registrationController]', err);
    return res.status(500).json({ message: err.message });
  }
};

const sanitizeUserForAuthResponse = (user) => {
  const source = (typeof user?.toObject === 'function' ? user.toObject() : user) || {};
  const {
    password: _pw,
    __v: _v,
    totpSecret: _ts,
    backupCodes: _bc,
    federatedTokens: _ft,
    ...safeUser
  } = source;
  return safeUser;
};

const runInUserTenant = (user, fn) =>
  user.tenantId
    ? tenantStorage.run(
        { tenantId: user.tenantId, userId: user._id.toString() },
        async () => await fn(),
      )
    : runAsSystem(fn);

/**
 * Resolves the app user id a `/refresh` request may reuse, from the cookie pair alone. Since
 * `/refresh` is unauthenticated, the id is trusted only when the marker cookie binds to the token
 * key the browser presents: the marker's `tokenKeyHash` claim must equal `hashTokenKey` of the
 * parsed key cookie. The binding is the key/marker pair, not any IdP token, so the `refreshToken`
 * cookie is never read here. Returns null (never throws) when the pair cannot bind.
 *
 * @param {Record<string, string>} parsedCookies
 * @returns {string | null}
 */
const getValidOpenIDReuseUserId = (parsedCookies) => {
  const key = parseTokenKey(parsedCookies.openid_token_key);
  const marker = parsedCookies[OPENID_USER_ID_COOKIE];
  if (!key || !marker || !process.env.JWT_REFRESH_SECRET) {
    return null;
  }

  try {
    const payload = jwt.verify(marker, process.env.JWT_REFRESH_SECRET);
    if (
      typeof payload !== 'object' ||
      payload == null ||
      typeof payload.id !== 'string' ||
      typeof payload.tokenKeyHash !== 'string'
    ) {
      return null;
    }
    return payload.tokenKeyHash === hashTokenKey(key) ? payload.id : null;
  } catch {
    return null;
  }
};

const resetPasswordRequestController = async (req, res) => {
  try {
    const resetService = await requestPasswordReset(req);
    if (resetService instanceof Error) {
      return res.status(400).json(resetService);
    } else {
      return res.status(200).json(resetService);
    }
  } catch (e) {
    logger.error('[resetPasswordRequestController]', e);
    return res.status(400).json({ message: e.message });
  }
};

const resetPasswordController = async (req, res) => {
  try {
    const resetPasswordService = await resetPassword(
      req.body.userId,
      req.body.token,
      req.body.password,
    );
    if (resetPasswordService instanceof Error) {
      return res.status(400).json(resetPasswordService);
    } else {
      await deleteAllUserSessions({ userId: req.body.userId });
      return res.status(200).json(resetPasswordService);
    }
  } catch (e) {
    logger.error('[resetPasswordController]', e);
    return res.status(400).json({ message: e.message });
  }
};

const refreshController = async (req, res) => {
  const parsedCookies = req.headers.cookie ? cookies.parse(req.headers.cookie) : {};
  const token_provider = parsedCookies.token_provider;

  if (token_provider === 'openid' && isEnabled(process.env.OPENID_REUSE_TOKENS)) {
    /**
     * The user and the token set both come from the custody context. The cookie-pair check runs
     * first so a request that cannot bind is rejected without a store read. `loadOpenIDCustody`
     * memoizes the loaded record on `req.openidCustody`, so `refreshOpenIDSession` reuses it
     * without a second read. Any failure to load (missing cookies, absent or expired record,
     * identity mismatch, a blob that fails to open) is a `401 OPENID_SESSION_MISSING` with no IdP
     * call, even when the request still carries previous-format cookies.
     */
    if (!getValidOpenIDReuseUserId(parsedCookies)) {
      logger.warn('[refreshController] OpenID session missing; sign-in required');
      return res.status(401).send({ code: 'OPENID_SESSION_MISSING' });
    }

    let custodyContext;
    try {
      /**
       * `/refresh` is unauthenticated and no longer carries the session copy, so it knows no
       * tenant up front. The record is looked up by the token key hash alone and its own tenant is
       * read back from the opened context (`custodyContext.identity.tenantId`), which the user load
       * and the refresh then run under. Passing no `expectedTenantId` is what lets a tenant-stamped
       * record refresh; `assertOpenIDSessionIdentityMatch` still rejects a cross-tenant record
       * before any IdP call by comparing the record's tenant with the loaded user's.
       */
      custodyContext = await loadOpenIDCustody(req, {
        custody: getTokenCustodyService(),
      });
    } catch (error) {
      logger.error('[refreshController] Failed to load OpenID custody context', error);
      return res.status(401).send({ code: 'OPENID_SESSION_MISSING' });
    }

    if (!custodyContext) {
      logger.warn('[refreshController] OpenID session missing; sign-in required');
      return res.status(401).send({ code: 'OPENID_SESSION_MISSING' });
    }

    const refreshUserId = custodyContext.identity.userId;

    try {
      const refreshUser = await runAsSystem(async () =>
        getUserById(refreshUserId, AUTH_REFRESH_USER_PROJECTION),
      );
      if (!refreshUser) {
        logger.warn('[refreshController] OpenID custody user not found; sign-in required', {
          userId: refreshUserId,
        });
        clearOpenIDAuthTokens(req, res, refreshUserId, custodyContext.identity.tenantId);
        return res.status(401).send({ code: 'OPENID_SESSION_MISSING' });
      }

      return await runInUserTenant(refreshUser, async () => {
        /**
         * `refreshOpenIDSession` returns a still-fresh token set as-is. Otherwise it performs one
         * IdP grant under a lease keyed on the token key hash, rotates the record under the same
         * key, and re-issues the key cookie with the rotated `expiresAt`. A concurrent rotation
         * that wins is adopted without a second grant. A session that cannot be recovered after
         * `invalid_grant` is deleted and rejected as session-missing, which this controller
         * answers `401`.
         */
        const tokenset = await refreshOpenIDSession(
          req,
          res,
          refreshUser,
          OPENID_REFRESH_TOKEN_PREFERENCE,
        );

        if (!tokenset) {
          logger.warn('[refreshController] OpenID refresh returned no token set; sign-in required');
          clearOpenIDAuthTokens(req, res, refreshUserId, custodyContext.identity.tenantId);
          return res.status(401).send({ code: 'OPENID_SESSION_MISSING' });
        }

        const token = getOpenIDAppAuthToken(
          { id_token: tokenset.id_token, access_token: tokenset.access_token },
          custodyContext.tokens.idToken,
        );
        const cloudFrontCookiesSet = setCloudFrontAuthCookies(req, res, refreshUser);
        logger.debug('[refreshController] OpenID custody refresh succeeded', {
          has_id_token: Boolean(tokenset.id_token),
          has_access_token: Boolean(tokenset.access_token),
          cloudfront_cookies_set: cloudFrontCookiesSet,
        });
        return res.status(200).send({
          token,
          user: sanitizeUserForAuthResponse(refreshUser),
        });
      });
    } catch (error) {
      if (isOpenIDSessionMissingCode(error) || isOpenIDSessionMissingError(error)) {
        /**
         * The custody refresh already deleted the record and cleared the cookies on a genuine
         * `invalid_grant`; clearing again is idempotent and covers the Express-session reload
         * failure that `isOpenIDSessionMissingError` detects.
         */
        clearOpenIDAuthTokens(req, res, refreshUserId, custodyContext.identity.tenantId);
        logger.warn('[refreshController] OpenID session missing; sign-in required');
        return res.status(401).send({ code: 'OPENID_SESSION_MISSING' });
      }
      if (isOpenIDRefreshOwnershipError(error)) {
        clearOpenIDAuthTokens(req, res, refreshUserId, custodyContext.identity.tenantId);
        return res.status(403).send('Invalid OpenID refresh token');
      }
      logger.error('[refreshController] OpenID token refresh error', error);
      return res.status(403).send('Invalid OpenID refresh token');
    }
  }

  /** For non-OpenID users, read refresh token from cookies */
  const refreshToken = parsedCookies.refreshToken;
  if (!refreshToken) {
    return res.status(200).send('Refresh token not provided');
  }

  try {
    const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const user = await getUserById(payload.id, AUTH_REFRESH_USER_PROJECTION);
    if (!user) {
      return res.status(401).redirect('/login');
    }

    const userId = payload.id;

    if (process.env.NODE_ENV === 'CI') {
      const token = await setAuthTokens(userId, res, null, req);
      return res.status(200).send({ token, user: sanitizeUserForAuthResponse(user) });
    }

    /** Session with the hashed refresh token */
    const session = await findSession(
      {
        userId: userId,
        refreshToken: refreshToken,
      },
      { lean: false },
    );

    if (session && session.expiration > new Date()) {
      const token = await setAuthTokens(userId, res, session, req);

      res.status(200).send({ token, user: sanitizeUserForAuthResponse(user) });
    } else if (req?.query?.retry) {
      // Retrying from a refresh token request that failed (401)
      res.status(403).send('No session found');
    } else if (payload.exp < Date.now() / 1000) {
      res.status(403).redirect('/login');
    } else {
      res.status(401).send('Refresh token expired or not found for this user');
    }
  } catch (err) {
    logger.error(`[refreshController] Invalid refresh token:`, err);
    res.status(403).send('Invalid refresh token');
  }
};

const graphTokenController = async (req, res) => {
  try {
    // Validate user is authenticated via Entra ID
    if (!req.user.openidId || req.user.provider !== 'openid') {
      return res.status(403).json({
        message: 'Microsoft Graph access requires Entra ID authentication',
      });
    }

    // Check if OpenID token reuse is active (required for on-behalf-of flow)
    if (!isEnabled(process.env.OPENID_REUSE_TOKENS)) {
      return res.status(403).json({
        message: 'SharePoint integration requires OpenID token reuse to be enabled',
      });
    }

    const scopes = req.query.scopes;
    if (!scopes) {
      return res.status(400).json({
        message: 'Graph API scopes are required as query parameter',
      });
    }

    /**
     * The upstream IdP access token comes from the custody record through the token provider, not
     * from `req.user.federatedTokens` (empty for a custody-login browser session). The provider's
     * identity check keeps the ownership guarantee the old session comparison gave; a session-missing
     * rejection clears the OpenID cookies, as the ownership failure did. The `packages/api` handler
     * also rechecks `custodyExists` right before returning, replacing the removed response-delivery
     * guard. The thin controller only builds the provider and sends what the handler returns.
     */
    const tenantId = getTenantId();
    const identityContext = createAuthIdentityContext({ user: req.user, tenantId });
    const upstreamTokenProvider = createOpenIDSessionTokenProvider({
      req,
      res,
      user: req.user,
      identityContext,
      tokenPreference: 'access_token',
    });

    const result = await resolveGraphApiToken({
      req,
      res,
      user: req.user,
      scopes,
      upstreamTokenProvider,
      graphTokenResolver: (user, accessToken, graphScopes) =>
        getGraphApiToken(user, accessToken, graphScopes),
      custody: getTokenCustodyService(),
      clearAuthCookies: () =>
        clearOpenIDAuthTokens(req, res, req.user?.id ?? req.user?._id?.toString?.(), tenantId),
      logger,
    });

    return res.status(result.status).json(result.body);
  } catch (error) {
    logger.error('[graphTokenController] Failed to obtain Graph API token:', error);
    return res.status(500).json({
      message: 'Failed to obtain Microsoft Graph token',
    });
  }
};

module.exports = {
  refreshController,
  registrationController,
  resetPasswordController,
  resetPasswordRequestController,
  graphTokenController,
};
