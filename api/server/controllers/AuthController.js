const cookies = require('cookie');
const jwt = require('jsonwebtoken');
const { logger, runAsSystem, tenantStorage } = require('@librechat/data-schemas');
const {
  isEnabled,
  createOpenIDRefreshOwnershipError,
  isOpenIDRefreshOwnershipError,
  isOpenIDSessionMissingError,
  loadOpenIDCustody,
  parseTokenKey,
  hashTokenKey,
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
const { refreshOpenIDSession } = require('~/server/services/OpenIDSessionRefresh');
const {
  assertOpenIDRefreshFlightDeliveryAvailable,
  assertOpenIDRefreshSessionGenerationAvailable,
  claimOpenIDRefreshFlightDelivery,
  releaseOpenIDRefreshFlightDelivery,
} = require('~/server/services/OpenIDRefreshFlight');

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

const assertReusableOpenIDSessionGeneration = async (openidTokens) =>
  assertOpenIDRefreshSessionGenerationAvailable({
    key: openidTokens?.publicationFlightKey,
    ownerId: openidTokens?.publicationFlightOwnerId,
  });

/**
 * Serializes response delivery for one durable OpenID publication generation. A logout that
 * reaches the same flight either tombstones it before this claim or waits for the response to
 * finish before returning. The send callback keeps the final authorization check adjacent to the
 * synchronous Express write while allowing callers to do slow preparation under the lease.
 */
const withOpenIDResponseDelivery = async ({ res, openidTokens, context }, operation) => {
  let delivery;
  let responseSent = false;
  let releaseStarted = false;
  let listenersArmed = false;
  const releaseDelivery = async () => {
    if (!delivery || releaseStarted) {
      return;
    }
    releaseStarted = true;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await releaseOpenIDRefreshFlightDelivery(delivery);
        return;
      } catch (error) {
        if (attempt === 3) {
          logger.warn(`[${context}] Failed to release OpenID response delivery`, {
            error: error instanceof Error ? error.message : error,
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  };

  try {
    await assertReusableOpenIDSessionGeneration(openidTokens);
    if (openidTokens?.publicationFlightKey && openidTokens?.publicationFlightOwnerId) {
      const claimed = await claimOpenIDRefreshFlightDelivery({
        key: openidTokens.publicationFlightKey,
        ownerId: openidTokens.publicationFlightOwnerId,
        createdAt: openidTokens.publicationFlightCreatedAt,
      });
      if (!claimed.deliveryId) {
        throw new Error('OpenID response delivery claim returned no owner');
      }
      delivery = {
        key: openidTokens.publicationFlightKey,
        ownerId: openidTokens.publicationFlightOwnerId,
        deliveryId: claimed.deliveryId,
      };
    }

    const sendAuthorized = async (send) => {
      if (delivery) {
        await assertOpenIDRefreshFlightDeliveryAvailable(delivery);
        if (!listenersArmed && typeof res.once === 'function') {
          listenersArmed = true;
          res.once('finish', () => void releaseDelivery());
          res.once('close', () => void releaseDelivery());
        }
      } else {
        await assertReusableOpenIDSessionGeneration(openidTokens);
      }
      const response = send();
      responseSent = true;
      if (delivery && typeof res.once !== 'function') {
        await releaseDelivery();
      }
      return response;
    };

    return await operation(sendAuthorized);
  } finally {
    if (delivery && !responseSent) {
      await releaseDelivery();
    }
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
      custodyContext = await loadOpenIDCustody(req, {
        custody: getTokenCustodyService(),
        tenantId: req.session?.openidTokens?.tenantId,
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

    const accessToken = req.user.federatedTokens?.access_token;
    if (!accessToken) {
      return res.status(401).json({
        message: 'No federated access token available for token exchange',
      });
    }

    const sessionTokens = req.session?.openidTokens;
    const usesSessionToken = Boolean(
      sessionTokens?.accessToken && sessionTokens.accessToken === accessToken,
    );
    const requestBearer = req.headers?.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (req.session && !usesSessionToken && requestBearer !== accessToken) {
      throw createOpenIDRefreshOwnershipError('OpenID session tokens are no longer available');
    }
    const exchangeAndSend = async (sendAuthorized) => {
      const tokenResponse = await getGraphApiToken(req.user, accessToken, scopes);
      return sendAuthorized(() => res.json(tokenResponse));
    };
    if (usesSessionToken) {
      return await withOpenIDResponseDelivery(
        {
          res,
          openidTokens: sessionTokens,
          context: 'graphTokenController',
        },
        exchangeAndSend,
      );
    }
    return await exchangeAndSend((send) => send());
  } catch (error) {
    if (isOpenIDRefreshOwnershipError(error)) {
      const userId = req.user?.id ?? req.user?._id?.toString?.();
      clearOpenIDAuthTokens(req, res, userId, req.session?.openidTokens?.tenantId);
      return res.status(401).json({ message: 'OpenID session is no longer authorized' });
    }
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
