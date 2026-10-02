const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { webcrypto } = require('node:crypto');
const {
  logger,
  getTenantId,
  DEFAULT_SESSION_EXPIRY,
  DEFAULT_REFRESH_TOKEN_EXPIRY,
} = require('@librechat/data-schemas');
const { ErrorTypes, SystemRoles, errorsToString } = require('librechat-data-provider');
const {
  math,
  isEnabled,
  checkEmailConfig,
  setCloudFrontCookies,
  getCloudFrontConfig,
  parseCloudFrontCookieScope,
  CLOUDFRONT_SCOPE_COOKIE,
  isEmailDomainAllowed,
  shouldUseSecureCookie,
  setOpenIDMarkerCookies,
  clearCloudFrontCookies,
  normalizeExpiresIn,
  createOpenIDSessionIdentity,
  resolveAppConfigForUser,
  parseTokenKey,
  hashTokenKey,
  setTokenKeyCookie,
  clearTokenKeyCookie,
  createTokenCustodyService,
  TOKEN_KEY_COOKIE,
} = require('@librechat/api');
const {
  findUser,
  findToken,
  createUser,
  updateUser,
  countUsers,
  getUserById,
  findSession,
  createToken,
  deleteTokens,
  deleteSession,
  createSession,
  generateToken,
  deleteUserById,
  generateRefreshToken,
  upsertTokenCustody,
  findTokenCustody,
  findTokenCustodyMeta,
  updateTokenCustodyIfCurrent,
  deleteTokenCustody,
  deleteTokenCustodiesByUser,
} = require('~/models');
const { registerSchema } = require('~/strategies/validators');
const { getAppConfig } = require('~/server/services/Config');
const { sendEmail } = require('~/server/utils');

const domains = {
  client: process.env.DOMAIN_CLIENT,
  server: process.env.DOMAIN_SERVER,
};

const AuthTokenTypes = Object.freeze({
  EMAIL_VERIFICATION: 'email_verification',
  PASSWORD_RESET: 'password_reset',
});

/**
 * The process-wide token custody service, constructed lazily. The app wires its dependencies here:
 * the custody store methods from `~/models`, the logger, and the resolved `REFRESH_TOKEN_EXPIRY`
 * (in milliseconds) as `fallbackRefreshTtlMs`, so the service itself reads no environment variable.
 * The fallback TTL is resolved once, at construction.
 */
let tokenCustodyService = null;

/**
 * Returns the process-wide custody service, constructing it on first use, so the refresh
 * controller and the OpenID session/OBO paths share one instance.
 * @returns {import('@librechat/api').TokenCustodyService}
 */
const getTokenCustodyService = () => {
  if (tokenCustodyService == null) {
    tokenCustodyService = createTokenCustodyService({
      db: {
        upsertTokenCustody,
        findTokenCustody,
        findTokenCustodyMeta,
        updateTokenCustodyIfCurrent,
        deleteTokenCustody,
        deleteTokenCustodiesByUser,
      },
      logger,
      fallbackRefreshTtlMs: math(process.env.REFRESH_TOKEN_EXPIRY, DEFAULT_REFRESH_TOKEN_EXPIRY),
    });
  }
  return tokenCustodyService;
};

const latestAuthTokenOptions = Object.freeze({ sort: { createdAt: -1 } });
const genericVerificationMessage = 'Please check your email to verify your email address.';
const invalidEmailVerificationMessage = 'Invalid or expired email verification token';
const OPENID_SESSION_ID_TOKEN_EXPIRY_BUFFER_SECONDS = 30;

const findPasswordResetToken = async (userId) => {
  const typedToken = await findToken(
    {
      userId,
      type: AuthTokenTypes.PASSWORD_RESET,
    },
    latestAuthTokenOptions,
  );

  if (typedToken) {
    return typedToken;
  }

  return await findToken(
    {
      userId,
      email: null,
      identifier: null,
      type: null,
    },
    latestAuthTokenOptions,
  );
};

const findEmailVerificationToken = async (user) => {
  const typedToken = await findToken(
    {
      userId: user._id,
      email: user.email,
      type: AuthTokenTypes.EMAIL_VERIFICATION,
    },
    latestAuthTokenOptions,
  );

  if (typedToken) {
    return typedToken;
  }

  return await findToken(
    {
      userId: user._id,
      email: user.email,
      identifier: null,
      type: null,
    },
    latestAuthTokenOptions,
  );
};

const deleteEmailVerificationTokens = (user) =>
  Promise.all([
    deleteTokens({
      userId: user._id,
      email: user.email,
      type: AuthTokenTypes.EMAIL_VERIFICATION,
    }),
    deleteTokens({
      userId: user._id,
      email: user.email,
      identifier: null,
      type: null,
    }),
  ]);

const getEmailVerificationTokenDeleteQuery = (emailVerificationToken) => {
  if (!emailVerificationToken.identifier && !emailVerificationToken.type) {
    return {
      token: emailVerificationToken.token,
      userId: emailVerificationToken.userId,
      email: emailVerificationToken.email,
      identifier: null,
      type: null,
    };
  }

  return {
    token: emailVerificationToken.token,
    type: AuthTokenTypes.EMAIL_VERIFICATION,
  };
};

const getPasswordResetTokenDeleteQuery = (passwordResetToken) => {
  if (!passwordResetToken.email && !passwordResetToken.type) {
    return {
      token: passwordResetToken.token,
      email: null,
      identifier: null,
      type: null,
    };
  }

  return {
    token: passwordResetToken.token,
    type: AuthTokenTypes.PASSWORD_RESET,
  };
};

const isExpiredOpenIDIdToken = (idToken) => {
  if (!idToken) {
    return false;
  }

  const decoded = jwt.decode(idToken);
  if (!decoded || typeof decoded !== 'object' || typeof decoded.exp !== 'number') {
    return false;
  }

  return (
    decoded.exp <= Math.floor(Date.now() / 1000) + OPENID_SESSION_ID_TOKEN_EXPIRY_BUFFER_SECONDS
  );
};

const getUnexpiredOpenIDSessionIdToken = (idToken) => {
  if (!idToken) {
    return;
  }

  const decoded = jwt.decode(idToken);
  const now = Math.floor(Date.now() / 1000);
  if (
    decoded &&
    typeof decoded === 'object' &&
    decoded.exp > now + OPENID_SESSION_ID_TOKEN_EXPIRY_BUFFER_SECONDS
  ) {
    return idToken;
  }
};

const getOpenIDAppAuthToken = (tokenset, sessionIdToken) =>
  (isExpiredOpenIDIdToken(tokenset?.id_token) ? undefined : tokenset?.id_token) ||
  getUnexpiredOpenIDSessionIdToken(sessionIdToken) ||
  tokenset?.access_token;

/**
 * Clears the browser's OpenID cookies and deletes the custody record the presented token key points
 * at. A cookie that `parseTokenKey` rejects has no hash to delete by, so the delete is skipped. The
 * token key cookie is cleared either way, so a browser that logged out cannot present a key again.
 *
 * Delete failures are logged and swallowed so a caller that does not await this function never sees
 * an unhandled rejection; the record expires on its own regardless.
 *
 * @param {ServerRequest} req
 * @param {ServerResponse} res
 * @param {string} [userId]
 * @param {string} [tenantId]
 * @returns {Promise<void>}
 */
const clearOpenIDAuthTokens = async (req, res, userId, tenantId) => {
  const cookieValue = req.cookies?.[TOKEN_KEY_COOKIE];
  const key = parseTokenKey(cookieValue);
  if (key) {
    try {
      await getTokenCustodyService().deleteCustody({ tokenKeyHash: hashTokenKey(key) });
    } catch (error) {
      logger.warn('[clearOpenIDAuthTokens] Failed to delete custody record', error?.message);
    }
  }

  clearTokenKeyCookie(res);
  for (const name of ['openid_user_id', 'token_provider']) {
    res.clearCookie?.(name);
  }
  clearCloudFrontCookies(res, { userId, tenantId });
};

/**
 * Logout user
 *
 * @param {ServerRequest} req
 * @param {string} refreshToken
 * @returns
 */
const logoutUser = async (req, refreshToken) => {
  try {
    const userId = req.user._id;
    const session = await findSession({ userId: userId, refreshToken });

    if (session) {
      try {
        await deleteSession({ sessionId: session._id });
      } catch (deleteErr) {
        logger.error('[logoutUser] Failed to delete session.', deleteErr);
        return { status: 500, message: 'Failed to delete session.' };
      }
    }

    try {
      req.session.destroy();
    } catch (destroyErr) {
      logger.debug('[logoutUser] Failed to destroy session.', destroyErr);
    }

    return { status: 200, message: 'Logout successful' };
  } catch (err) {
    return { status: 500, message: err.message };
  }
};

/**
 * Creates Token and corresponding Hash for verification
 * @returns {[string, string]}
 */
const createTokenHash = () => {
  const token = Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString('hex');
  const hash = bcrypt.hashSync(token, 10);
  return [token, hash];
};

/**
 * Send Verification Email
 * @param {Partial<IUser>} user
 * @returns {Promise<void>}
 */
const sendVerificationEmail = async (user) => {
  const [verifyToken, hash] = createTokenHash();
  const email = user.email.toLowerCase();

  const verificationLink = `${
    domains.client
  }/verify?token=${verifyToken}&email=${encodeURIComponent(email)}`;
  await sendEmail({
    email,
    subject: 'Verify your email',
    payload: {
      appName: process.env.APP_TITLE || 'LibreChat',
      name: user.name || user.username || email,
      verificationLink: verificationLink,
      year: new Date().getFullYear(),
    },
    template: 'verifyEmail.handlebars',
  });

  await createToken({
    userId: user._id,
    email,
    type: AuthTokenTypes.EMAIL_VERIFICATION,
    token: hash,
    createdAt: Date.now(),
    expiresIn: 900,
  });

  logger.info(`[sendVerificationEmail] Verification link issued. [Email: ${email}]`);
};

/**
 * Verify Email
 * @param {ServerRequest} req
 */
const verifyEmail = async (req) => {
  const { email, token } = req.body;

  if (typeof email !== 'string' || typeof token !== 'string' || !email || !token) {
    logger.warn('[verifyEmail] [Invalid email verification request]');
    return new Error(invalidEmailVerificationMessage);
  }

  let decodedEmail;
  try {
    decodedEmail = decodeURIComponent(email);
  } catch {
    logger.warn(`[verifyEmail] [Invalid email encoding] [Email: ${email}]`);
    return new Error(invalidEmailVerificationMessage);
  }

  const user = await findUser({ email: decodedEmail }, 'email _id emailVerified');

  if (!user) {
    logger.warn(`[verifyEmail] [User not found] [Email: ${decodedEmail}]`);
    return new Error(invalidEmailVerificationMessage);
  }

  const emailVerificationData = await findEmailVerificationToken(user);

  if (!emailVerificationData) {
    logger.warn(`[verifyEmail] [No email verification data found] [Email: ${decodedEmail}]`);
    return new Error(invalidEmailVerificationMessage);
  }

  if (!emailVerificationData.token) {
    logger.warn(
      `[verifyEmail] [Email verification token data is invalid] [Email: ${decodedEmail}]`,
    );
    return new Error(invalidEmailVerificationMessage);
  }

  const tokenUserId = emailVerificationData.userId?.toString();
  const userId = user._id?.toString();
  if (!tokenUserId || tokenUserId !== userId) {
    logger.warn(`[verifyEmail] [Email verification token user mismatch] [Email: ${decodedEmail}]`);
    return new Error(invalidEmailVerificationMessage);
  }

  const isValid = bcrypt.compareSync(token, emailVerificationData.token);

  if (!isValid) {
    logger.warn(
      `[verifyEmail] [Invalid or expired email verification token] [Email: ${decodedEmail}]`,
    );
    return new Error(invalidEmailVerificationMessage);
  }

  if (user.emailVerified) {
    await deleteTokens(getEmailVerificationTokenDeleteQuery(emailVerificationData));
    logger.info(`[verifyEmail] Email already verified [Email: ${decodedEmail}]`);
    return { message: 'Email verification was successful', status: 'success' };
  }

  const updatedUser = await updateUser(emailVerificationData.userId, { emailVerified: true });

  if (!updatedUser) {
    logger.warn(`[verifyEmail] [User update failed] [Email: ${decodedEmail}]`);
    return new Error(invalidEmailVerificationMessage);
  }

  await deleteTokens(getEmailVerificationTokenDeleteQuery(emailVerificationData));
  logger.info(`[verifyEmail] Email verification successful [Email: ${decodedEmail}]`);
  return { message: 'Email verification was successful', status: 'success' };
};

/**
 * Register a new user.
 * @param {IUser} user <email, password, name, username>
 * @param {Partial<IUser>} [additionalData={}] Trusted server-provided fields, such as CLI overrides.
 * @returns {Promise<{status: number, message: string, user?: IUser}>}
 */
const registerUser = async (user, additionalData = {}) => {
  const result = registerSchema.safeParse(user);
  if (!result.success) {
    const errorMessage = errorsToString(result.error.errors);
    logger.info(
      'Route: register - Validation Error',
      { name: 'Request params:', value: user },
      { name: 'Validation error:', value: errorMessage },
    );

    return { status: 404, message: errorMessage };
  }

  const { email, password, name, username } = result.data;
  const { provider, ...trustedAdditionalData } = additionalData ?? {};

  let newUserId;
  try {
    const tenantId = getTenantId();
    const appConfig = await getAppConfig(tenantId ? { tenantId } : {});
    if (!isEmailDomainAllowed(email, appConfig?.registration?.allowedDomains)) {
      const errorMessage =
        'The email address provided cannot be used. Please use a different email address.';
      logger.error(`[registerUser] [Registration not allowed] [Email: ${user.email}]`);
      return { status: 403, message: errorMessage };
    }

    const existingUser = await findUser({ email }, 'email _id');

    if (existingUser) {
      logger.info(
        'Register User - Email in use',
        { name: 'Request params:', value: user },
        { name: 'Existing user:', value: existingUser },
      );

      // Sleep for 1 second
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return { status: 200, message: genericVerificationMessage };
    }

    // Only the first user in the unscoped, single-tenant deployment bootstraps ADMIN.
    // Tenant administrators must be provisioned through a trusted administrative flow.
    const isFirstRegisteredUser = !tenantId && (await countUsers()) === 0;

    const salt = bcrypt.genSaltSync(10);
    const newUserData = {
      provider: provider ?? 'local',
      email,
      username,
      name,
      avatar: null,
      role: isFirstRegisteredUser ? SystemRoles.ADMIN : SystemRoles.USER,
      password: bcrypt.hashSync(password, salt),
      ...trustedAdditionalData,
    };

    const emailEnabled = checkEmailConfig();
    const disableTTL = isEnabled(process.env.ALLOW_UNVERIFIED_EMAIL_LOGIN);

    const newUser = await createUser(newUserData, appConfig.balance, disableTTL, true);
    newUserId = newUser._id;
    if (emailEnabled && !newUser.emailVerified) {
      await sendVerificationEmail({
        _id: newUserId,
        email,
        name,
      });
    } else {
      await updateUser(newUserId, { emailVerified: true });
    }

    /** `userCreated` separates this from the identical 200 returned when the email is
     * already in use, so a caller can act on an account having actually been created
     * without the response body revealing which of the two happened. */
    return { status: 200, message: genericVerificationMessage, userCreated: true };
  } catch (err) {
    logger.error('[registerUser] Error in registering user:', err);
    if (newUserId) {
      const result = await deleteUserById(newUserId);
      logger.warn(
        `[registerUser] [Email: ${email}] [Temporary User deleted: ${JSON.stringify(result)}]`,
      );
    }
    return { status: 500, message: 'Something went wrong' };
  }
};

/**
 * Request password reset.
 *
 * Uses a two-phase domain check: fast-fail with the memory-cached base config
 * (zero DB queries) to block globally denied domains before user lookup, then
 * re-check with tenant-scoped config after user lookup so tenant-specific
 * restrictions are enforced.
 *
 * Phase 1 (base check) returns an Error (HTTP 400) — this intentionally reveals
 * that the domain is globally blocked, but fires before any DB lookup so it
 * cannot confirm user existence. Phase 2 (tenant check) returns the generic
 * success message (HTTP 200) to prevent user-enumeration via status codes.
 *
 * @param {ServerRequest} req
 */
const requestPasswordReset = async (req) => {
  const { email } = req.body;

  const baseConfig = await getAppConfig({ baseOnly: true });
  if (!isEmailDomainAllowed(email, baseConfig?.registration?.allowedDomains)) {
    logger.warn(
      `[requestPasswordReset] Blocked - email domain not allowed [Email: ${email}] [IP: ${req.ip}]`,
    );
    const error = new Error(ErrorTypes.AUTH_FAILED);
    error.code = ErrorTypes.AUTH_FAILED;
    error.message = 'Email domain not allowed';
    return error;
  }

  const user = await findUser({ email }, 'email _id role tenantId');
  let appConfig = baseConfig;
  if (user?.tenantId) {
    try {
      appConfig = await resolveAppConfigForUser(getAppConfig, user);
    } catch (err) {
      logger.error('[requestPasswordReset] Failed to resolve tenant config, using base:', err);
    }
  }

  if (!isEmailDomainAllowed(email, appConfig?.registration?.allowedDomains)) {
    logger.warn(
      `[requestPasswordReset] Tenant config blocked domain [Email: ${email}] [IP: ${req.ip}]`,
    );
    return {
      message: 'If an account with that email exists, a password reset link has been sent to it.',
    };
  }
  const emailEnabled = checkEmailConfig();

  logger.warn(`[requestPasswordReset] [Password reset request initiated] [Email: ${email}]`);

  if (!user) {
    logger.warn(`[requestPasswordReset] [No user found] [Email: ${email}] [IP: ${req.ip}]`);
    return {
      message: 'If an account with that email exists, a password reset link has been sent to it.',
    };
  }

  await Promise.all([
    deleteTokens({ userId: user._id, type: AuthTokenTypes.PASSWORD_RESET }),
    deleteTokens({ userId: user._id, email: null, identifier: null, type: null }),
  ]);

  const [resetToken, hash] = createTokenHash();

  await createToken({
    userId: user._id,
    type: AuthTokenTypes.PASSWORD_RESET,
    token: hash,
    createdAt: Date.now(),
    expiresIn: 900,
  });

  const link = `${domains.client}/reset-password?token=${resetToken}&userId=${user._id}`;

  if (emailEnabled) {
    await sendEmail({
      email: user.email,
      subject: 'Password Reset Request',
      payload: {
        appName: process.env.APP_TITLE || 'LibreChat',
        name: user.name || user.username || user.email,
        link: link,
        year: new Date().getFullYear(),
      },
      template: 'requestPasswordReset.handlebars',
    });
    logger.info(
      `[requestPasswordReset] Link emailed. [Email: ${email}] [ID: ${user._id}] [IP: ${req.ip}]`,
    );
  } else {
    logger.info(
      `[requestPasswordReset] Link issued. [Email: ${email}] [ID: ${user._id}] [IP: ${req.ip}]`,
    );
    return { link };
  }

  return {
    message: 'If an account with that email exists, a password reset link has been sent to it.',
  };
};

/**
 * Reset Password
 *
 * @param {*} userId
 * @param {String} token
 * @param {String} password
 * @returns
 */
const resetPassword = async (userId, token, password) => {
  const passwordResetToken = await findPasswordResetToken(userId);

  if (!passwordResetToken) {
    return new Error('Invalid or expired password reset token');
  }

  const isValid = bcrypt.compareSync(token, passwordResetToken.token);

  if (!isValid) {
    return new Error('Invalid or expired password reset token');
  }

  const hash = bcrypt.hashSync(password, 10);
  const user = await updateUser(userId, { password: hash });

  if (checkEmailConfig()) {
    await sendEmail({
      email: user.email,
      subject: 'Password Reset Successfully',
      payload: {
        appName: process.env.APP_TITLE || 'LibreChat',
        name: user.name || user.username || user.email,
        year: new Date().getFullYear(),
      },
      template: 'passwordReset.handlebars',
    });
  }

  await deleteTokens(getPasswordResetTokenDeleteQuery(passwordResetToken));
  logger.info(`[resetPassword] Password reset successful. [Email: ${user.email}]`);
  return { message: 'Password reset was successful' };
};

/**
 * Reads the previously issued CloudFront cookie scope used for stale cookie cleanup.
 * @param {ServerRequest | null} [req=null]
 * @returns {import('@librechat/api').CloudFrontCookieScope | null}
 */
const getPreviousCloudFrontScope = (req) =>
  parseCloudFrontCookieScope(req?.cookies?.[CLOUDFRONT_SCOPE_COOKIE]);

const normalizeCloudFrontScopeValue = (value) => (value == null ? undefined : String(value));

const getCloudFrontScopeValue = (optionsValue, userValue, requestValue) =>
  normalizeCloudFrontScopeValue(optionsValue ?? userValue ?? requestValue);

const getCloudFrontAuthCookieSkipReason = (scope) => {
  const config = getCloudFrontConfig();
  if (!config || config.imageSigning !== 'cookies' || !config.privateKey || !config.keyPairId) {
    return 'cloudfront_disabled';
  }
  if (!config.cookieDomain) {
    return 'missing_cookie_domain';
  }
  if (!scope.userId) {
    return 'missing_user_id';
  }
  return null;
};

const shouldLogCloudFrontAuthCookieSkip = (reason) => reason !== 'cloudfront_disabled';

/**
 * Refreshes CloudFront signed cookies for authenticated image/avatar access.
 * @param {ServerRequest | null} req
 * @param {ServerResponse} res
 * @param {Partial<IUser> | null} user
 * @param {import('@librechat/api').CloudFrontCookieScope & { orgId?: string }} [options={}]
 * @returns {boolean}
 */
const setCloudFrontAuthCookies = (req, res, user, options = {}) => {
  const storageRegion = getCloudFrontScopeValue(
    options.storageRegion,
    user?.storageRegion,
    req?.user?.storageRegion,
  );
  const scope = {
    userId: getCloudFrontScopeValue(
      options.userId,
      user?._id ?? user?.id,
      req?.user?._id ?? req?.user?.id,
    ),
    tenantId: getCloudFrontScopeValue(
      options.tenantId ?? options.orgId,
      user?.tenantId ?? user?.orgId,
      req?.user?.tenantId ?? req?.user?.orgId,
    ),
    ...(storageRegion ? { storageRegion } : {}),
  };
  const skipReason = getCloudFrontAuthCookieSkipReason(scope);
  if (skipReason) {
    if (shouldLogCloudFrontAuthCookieSkip(skipReason)) {
      logger.debug('[setCloudFrontAuthCookies] CloudFront auth cookies skipped', {
        attempted: false,
        set: false,
        reason: skipReason,
        has_user_id: Boolean(scope.userId),
        has_tenant_scope: Boolean(scope.tenantId),
        has_storage_region: Boolean(scope.storageRegion),
        has_previous_scope: Boolean(getPreviousCloudFrontScope(req)?.userId),
      });
    }
    return false;
  }

  const previousScope = getPreviousCloudFrontScope(req);
  const cookiesSet = setCloudFrontCookies(res, scope, previousScope);
  logger.debug('[setCloudFrontAuthCookies] CloudFront auth cookies refreshed', {
    attempted: true,
    set: cookiesSet,
    reason: cookiesSet ? undefined : 'set_failed',
    has_user_id: true,
    has_tenant_scope: Boolean(scope.tenantId),
    has_storage_region: Boolean(scope.storageRegion),
    has_previous_scope: Boolean(previousScope?.userId),
  });
  return cookiesSet;
};

/**
 * Set Auth Tokens
 * @param {String | ObjectId} userId
 * @param {ServerResponse} res
 * @param {ISession | null} [_session=null]
 * @param {ServerRequest | null} [req=null]
 * @returns
 */
const setAuthTokens = async (userId, res, _session = null, req = null) => {
  try {
    let session = _session;
    let refreshToken;
    let refreshTokenExpires;
    const expiresIn = math(process.env.REFRESH_TOKEN_EXPIRY, DEFAULT_REFRESH_TOKEN_EXPIRY);

    if (session && session._id && session.expiration != null) {
      refreshTokenExpires = session.expiration.getTime();
      refreshToken = await generateRefreshToken(session);
    } else {
      const result = await createSession(userId, { expiresIn });
      session = result.session;
      refreshToken = result.refreshToken;
      refreshTokenExpires = session.expiration.getTime();
    }

    const user = await getUserById(userId);
    const sessionExpiry = math(process.env.SESSION_EXPIRY, DEFAULT_SESSION_EXPIRY);
    const token = await generateToken(user, sessionExpiry);

    res.cookie('refreshToken', refreshToken, {
      expires: new Date(refreshTokenExpires),
      httpOnly: true,
      secure: shouldUseSecureCookie(),
      sameSite: 'strict',
    });
    res.cookie('token_provider', 'librechat', {
      expires: new Date(refreshTokenExpires),
      httpOnly: true,
      secure: shouldUseSecureCookie(),
      sameSite: 'strict',
    });

    setCloudFrontAuthCookies(req, res, user, { userId: user?._id ?? userId });

    return token;
  } catch (error) {
    logger.error('[setAuthTokens] Error in setting authentication tokens:', error);
    throw error;
  }
};

const resolveOpenIDAuthTokenOptions = (optionsOrUserId, existingRefreshToken, tenantId) => {
  if (optionsOrUserId != null && typeof optionsOrUserId === 'object') {
    if (
      'userId' in optionsOrUserId ||
      'existingRefreshToken' in optionsOrUserId ||
      'tenantId' in optionsOrUserId ||
      'openidSubject' in optionsOrUserId ||
      'openidIssuer' in optionsOrUserId
    ) {
      return optionsOrUserId;
    }
    return {};
  }

  return { userId: optionsOrUserId, existingRefreshToken, tenantId };
};

const getOpenIDTokenClaims = (tokenset) => {
  if (typeof tokenset?.claims === 'function') {
    try {
      const claims = tokenset.claims();
      return claims && typeof claims === 'object' ? claims : {};
    } catch (error) {
      logger.debug('[setOpenIDAuthTokens] Unable to read tokenset claims', error?.message);
    }
  }

  if (typeof tokenset?.id_token !== 'string') {
    return {};
  }

  const decoded = jwt.decode(tokenset.id_token);
  return decoded && typeof decoded === 'object' ? decoded : {};
};

const getStringClaim = (claims, claim) => {
  const value = claims?.[claim];
  return typeof value === 'string' && value ? value : undefined;
};

/**
 * @function setOpenIDAuthTokens
 * Set OpenID Authentication Tokens
 *
 * Seals the IdP token set into a custody record through the custody service, hands the browser the
 * token key in the `openid_token_key` cookie, and signs the marker cookie with that key's hash. The
 * server keeps neither the key nor a decryptable copy of the tokens, and a custody record does not
 * need an Express session to exist.
 *
 * @param {import('openid-client').TokenEndpointResponse & import('openid-client').TokenEndpointResponseHelpers} tokenset
 * - The tokenset object containing access and refresh tokens
 * @param {Object} req - request object
 * @param {Object} res - response object
 * @param {Object} [options] - Optional token/cookie context
 * @param {string} [options.userId] - Optional MongoDB user ID for image path validation
 * @param {string} [options.existingRefreshToken] - Optional existing refresh token to preserve
 * @param {string} [options.tenantId] - Optional tenant identifier for CloudFront cookie scoping
 * @param {string} [options.openidSubject] - Optional OpenID subject bound to the custody identity
 * @param {string} [options.openidIssuer] - Optional OpenID issuer bound to the custody identity
 * @returns {Promise<String|undefined>} - id_token (preferred) or access_token as the app auth token
 */
const setOpenIDAuthTokens = async (
  tokenset,
  req,
  res,
  optionsOrUserId = null,
  existingRefreshTokenArg,
  tenantIdArg,
) => {
  try {
    const { userId, existingRefreshToken, tenantId, openidSubject, openidIssuer } =
      resolveOpenIDAuthTokenOptions(optionsOrUserId, existingRefreshTokenArg, tenantIdArg);

    if (!tokenset) {
      logger.error('[setOpenIDAuthTokens] No tokenset found in request');
      return;
    }
    const expiryInMilliseconds = math(
      process.env.REFRESH_TOKEN_EXPIRY,
      DEFAULT_REFRESH_TOKEN_EXPIRY,
    );
    if (!tokenset.access_token) {
      logger.error('[setOpenIDAuthTokens] No access token found in tokenset');
      return;
    }

    const refreshToken = tokenset.refresh_token || existingRefreshToken;

    if (!refreshToken) {
      logger.error('[setOpenIDAuthTokens] No refresh token available');
      return;
    }

    /**
     * Use id_token as the app authentication token (Bearer token for JWKS validation).
     * The id_token is always a standard JWT signed by the IdP's JWKS keys with the app's
     * client_id as audience. The access_token may be opaque or intended for a different
     * audience (e.g., Microsoft Graph API), which fails JWKS validation.
     * Falls back to access_token for providers where id_token is not available.
     *
     * On the login path there is no prior custody context to carry a previous id_token forward, so
     * the selection is over `tokenset` alone; the inline-refresh path supplies the carried id_token
     * from the request's custody context.
     */
    const appAuthToken = getOpenIDAppAuthToken(tokenset, undefined);
    const claims = getOpenIDTokenClaims(tokenset);
    const sessionIdentity = createOpenIDSessionIdentity({
      user: req?.user,
      userId,
      openidSubject: openidSubject ?? getStringClaim(claims, 'sub'),
      tenantId,
      openidIssuer: openidIssuer ?? getStringClaim(claims, 'iss'),
    });

    /**
     * The custody identity the sealed blob is bound to, also used as the AEAD associated data.
     * `userId` is the app user id the marker will claim; the optional fields mirror
     * `createOpenIDSessionIdentity`.
     */
    const custodyUserId = sessionIdentity.appUserId ?? userId;
    if (!custodyUserId) {
      logger.error('[setOpenIDAuthTokens] No user id available for custody record');
      return;
    }
    const identity = {
      userId: custodyUserId,
      ...(sessionIdentity.tenantId != null && { tenantId: sessionIdentity.tenantId }),
      ...(sessionIdentity.openidIssuer != null && { openidIssuer: sessionIdentity.openidIssuer }),
      ...(sessionIdentity.openidSubject != null && {
        openidSubject: sessionIdentity.openidSubject,
      }),
    };

    /**
     * Capture the access-token's own expiry (unix seconds) when the IdP advertises one, so a
     * keyless reader can decide "does this even need a refresh" without paying an AEAD open. The
     * IdP's code exchange does not carry a refresh-token expiry on this path, so the record's TTL
     * falls back to the resolved `REFRESH_TOKEN_EXPIRY` inside the custody service.
     */
    const accessTokenExpiresIn = normalizeExpiresIn(tokenset.expires_in);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const tokens = {
      accessToken: tokenset.access_token,
      ...(tokenset.id_token != null && { idToken: tokenset.id_token }),
      refreshToken,
      ...(accessTokenExpiresIn != null && {
        accessTokenExpiresAt: nowSeconds + accessTokenExpiresIn,
      }),
      issuedAt: Date.now(),
    };

    /**
     * Seal the token set and write exactly one custody record. On a rejection we set neither cookie,
     * write no fallback and let the login fail — the caller's try/catch surfaces the error.
     */
    const { tokenKey, expiresAt } = await getTokenCustodyService().createCustody({
      tokens,
      identity,
    });

    /**
     * Hand the browser the token key and the marker cookie signed with its hash. The cookie's
     * `expires` is the record's `expiresAt`, passed through so the two cannot drift.
     */
    setTokenKeyCookie(res, tokenKey, expiresAt);
    setOpenIDMarkerCookies(res, {
      userId: custodyUserId,
      expires: expiresAt,
      refreshExpiryMs: expiryInMilliseconds,
      tokenKey,
    });

    setCloudFrontAuthCookies(req, res, req.user, { userId, tenantId });

    return appAuthToken;
  } catch (error) {
    logger.error('[setOpenIDAuthTokens] Error in setting authentication tokens:', error);
    throw error;
  }
};

/**
 * Resend Verification Email
 * @param {Object} req
 * @param {Object} req.body
 * @param {String} req.body.email
 * @returns {Promise<{status: number, message: string}>}
 */
const resendVerificationEmail = async (req) => {
  try {
    const { email } = req.body;
    const user = await findUser({ email }, 'email _id name');

    if (!user) {
      logger.warn(`[resendVerificationEmail] [No user found] [Email: ${email}]`);
      return { status: 200, message: genericVerificationMessage };
    }

    await deleteEmailVerificationTokens(user);

    const [verifyToken, hash] = createTokenHash();

    const verificationLink = `${
      domains.client
    }/verify?token=${verifyToken}&email=${encodeURIComponent(user.email)}`;

    await sendEmail({
      email: user.email,
      subject: 'Verify your email',
      payload: {
        appName: process.env.APP_TITLE || 'LibreChat',
        name: user.name || user.username || user.email,
        verificationLink: verificationLink,
        year: new Date().getFullYear(),
      },
      template: 'verifyEmail.handlebars',
    });

    await createToken({
      userId: user._id,
      email: user.email,
      type: AuthTokenTypes.EMAIL_VERIFICATION,
      token: hash,
      createdAt: Date.now(),
      expiresIn: 900,
    });

    logger.info(`[resendVerificationEmail] Verification link issued. [Email: ${user.email}]`);

    return {
      status: 200,
      message: genericVerificationMessage,
    };
  } catch (error) {
    logger.error(`[resendVerificationEmail] Error resending verification email: ${error.message}`);
    return {
      status: 200,
      message: genericVerificationMessage,
    };
  }
};

module.exports = {
  logoutUser,
  verifyEmail,
  registerUser,
  setAuthTokens,
  resetPassword,
  clearOpenIDAuthTokens,
  getOpenIDAppAuthToken,
  setOpenIDAuthTokens,
  getTokenCustodyService,
  setCloudFrontAuthCookies,
  requestPasswordReset,
  resendVerificationEmail,
};
