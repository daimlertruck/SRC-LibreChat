let mockActiveTenantId;
const mockRunAsSystem = jest.fn(async (fn) => {
  const previousTenantId = mockActiveTenantId;
  mockActiveTenantId = '__SYSTEM__';
  try {
    return await fn();
  } finally {
    mockActiveTenantId = previousTenantId;
  }
});
const mockTenantStorageRun = jest.fn(async (context, fn) => {
  const previousTenantId = mockActiveTenantId;
  mockActiveTenantId = context.tenantId;
  try {
    return await fn();
  } finally {
    mockActiveTenantId = previousTenantId;
  }
});
jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), debug: jest.fn(), warn: jest.fn(), info: jest.fn() },
  runAsSystem: (fn) => mockRunAsSystem(fn),
  tenantStorage: { run: (context, fn) => mockTenantStorageRun(context, fn) },
  getTenantId: jest.fn(() => undefined),
}));
jest.mock('~/server/services/GraphTokenService', () => ({
  getGraphApiToken: jest.fn(),
}));
jest.mock('~/server/services/AuthService', () => ({
  clearOpenIDAuthTokens: jest.fn(),
  getOpenIDAppAuthToken: jest.fn(),
  getTokenCustodyService: jest.fn(),
  requestPasswordReset: jest.fn(),
  setOpenIDAuthTokens: jest.fn(),
  setCloudFrontAuthCookies: jest.fn(),
  resetPassword: jest.fn(),
  setAuthTokens: jest.fn(),
  registerUser: jest.fn(),
}));
jest.mock('~/strategies', () => ({ getOpenIdConfig: jest.fn(), getOpenIdEmail: jest.fn() }));
jest.mock('openid-client', () => ({ refreshTokenGrant: jest.fn() }));
jest.mock('~/models', () => ({
  deleteSession: jest.fn(),
  deleteAllUserSessions: jest.fn(),
  getUserById: jest.fn(),
  findSession: jest.fn(),
  updateUser: jest.fn(),
  findUser: jest.fn(),
  deleteTokens: jest.fn(),
}));
jest.mock('~/server/services/OpenIDRefreshFlight', () => ({
  acquireOpenIDRefreshFlight: jest.fn(),
  assertOpenIDRefreshFlightAvailable: jest.fn(),
  completeOpenIDRefreshFlight: jest.fn(),
  createOpenIDRefreshFlightKey: jest.fn(),
  failOpenIDRefreshFlight: jest.fn(),
  revokeOpenIDRefreshFlights: jest.fn(),
  waitForOpenIDRefreshFlight: jest.fn(),
  withOpenIDRefreshFlightLease: jest.fn(),
}));
jest.mock('~/server/services/OpenIDSessionRefresh', () => ({
  refreshOpenIDSession: jest.fn(),
  createOpenIDSessionTokenProvider: jest.fn(),
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  OPENID_EXPIRY_BUFFER_SECONDS: 30,
  math: jest.fn((value, fallback) => fallback),
  isEnabled: jest.fn(),
  loadOpenIDCustody: jest.fn(),
  findOpenIDUser: jest.fn(),
  getOpenIdIssuer: jest.fn(() => 'https://issuer.example.com'),
  createAuthIdentityContext: jest.fn(({ user }) => ({
    appUserId: user?._id?.toString?.() ?? user?.id,
    openidSubject: user?.openidId,
    tenantId: user?.tenantId,
    openidIssuer: user?.openidIssuer,
  })),
  isOpenIDSessionIdentityMatch: jest.fn((sessionIdentity, expectedIdentity) => {
    const normalize = (value) => {
      if (value == null) {
        return undefined;
      }
      const normalized = typeof value === 'string' ? value.trim() : value.toString().trim();
      return normalized || undefined;
    };
    const normalizeIssuer = (value) => normalize(value)?.replace(/\/+$/, '');
    return (
      Boolean(normalize(sessionIdentity?.appUserId)) &&
      Boolean(normalize(sessionIdentity?.openidSubject)) &&
      normalize(sessionIdentity?.appUserId) === normalize(expectedIdentity?.appUserId) &&
      normalize(sessionIdentity?.openidSubject) === normalize(expectedIdentity?.openidSubject) &&
      normalize(sessionIdentity?.tenantId) === normalize(expectedIdentity?.tenantId) &&
      normalizeIssuer(sessionIdentity?.openidIssuer) ===
        normalizeIssuer(expectedIdentity?.openidIssuer)
    );
  }),
  buildOpenIDRefreshParams: jest.fn(() => {
    const params = {};
    if (process.env.OPENID_SCOPE) {
      params.scope = process.env.OPENID_SCOPE;
    }
    if (process.env.OPENID_REFRESH_AUDIENCE) {
      params.audience = process.env.OPENID_REFRESH_AUDIENCE;
    }
    return params;
  }),
}));

const jwt = require('jsonwebtoken');
const { logger } = require('@librechat/data-schemas');
const { isEnabled, loadOpenIDCustody } = require('@librechat/api');
const {
  graphTokenController,
  refreshController,
  registrationController,
} = require('./AuthController');
const { getGraphApiToken } = require('~/server/services/GraphTokenService');
const {
  clearOpenIDAuthTokens,
  getOpenIDAppAuthToken,
  getTokenCustodyService,
  setCloudFrontAuthCookies,
  setAuthTokens,
  registerUser,
} = require('~/server/services/AuthService');
const { getUserById, findSession, deleteTokens } = require('~/models');
const {
  createOpenIDRefreshFlightKey,
  revokeOpenIDRefreshFlights,
} = require('~/server/services/OpenIDRefreshFlight');
const {
  refreshOpenIDSession,
  createOpenIDSessionTokenProvider,
} = require('~/server/services/OpenIDSessionRefresh');
const { revokeOpenIDRefreshTokenChain } = require('~/server/services/OpenIDRefreshRecovery');

const ORIGINAL_JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

const { createOpenIDRefreshOwnershipError } = jest.requireActual('@librechat/api');
const ownershipLost = (message) => createOpenIDRefreshOwnershipError(message);

describe('OpenID logout refresh chain', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createOpenIDRefreshFlightKey.mockImplementation(
      ({ refreshToken }) => `session:${refreshToken}`,
    );
  });

  it('tombstones every discovered successor generation before logout completes', async () => {
    createOpenIDRefreshFlightKey.mockImplementation(
      ({ refreshToken, identityContext }) =>
        `session:${identityContext.openidSubject}:${refreshToken}`,
    );
    const acceptedIdentity = {
      appUserId: 'user-2',
      openidSubject: 'subject-2',
      tenantId: 'tenant-1',
      openidIssuer: 'https://issuer-2.example.com',
    };
    revokeOpenIDRefreshFlights
      .mockResolvedValueOnce([{ refresh_token: 'rt-successor-1', acceptedIdentity }, null])
      .mockResolvedValueOnce([{ tokenset: { refresh_token: 'rt-successor-2' } }, null, null, null])
      .mockResolvedValueOnce([null, null, null, null]);
    /**
     * The chain seals its revocation flights under the request's custody token key; only the
     * session flight key is targeted per token.
     */
    const custodyContext = {
      tokenKey: Buffer.alloc(32, 7),
      tokenKeyHash: 'hash-abc',
      identity: {
        userId: 'user-1',
        openidSubject: 'subject-1',
        tenantId: 'tenant-1',
        openidIssuer: 'https://issuer.example.com',
      },
    };
    const expectedSeal = {
      aeadKey: custodyContext.tokenKey,
      tokenKeyHash: custodyContext.tokenKeyHash,
      identity: custodyContext.identity,
    };
    const req = { user: { _id: 'user-1', openidId: 'subject-1' }, openidCustody: custodyContext };
    const user = req.user;
    const identityContext = {
      appUserId: 'user-1',
      openidSubject: 'subject-1',
      tenantId: 'tenant-1',
      openidIssuer: 'https://issuer.example.com',
    };

    await expect(
      revokeOpenIDRefreshTokenChain({
        req,
        user,
        identityContext,
        refreshTokens: ['rt-predecessor'],
        ttl: 60_000,
      }),
    ).resolves.toEqual(['rt-predecessor', 'rt-successor-1', 'rt-successor-2']);

    expect(revokeOpenIDRefreshFlights).toHaveBeenNthCalledWith(1, {
      keys: ['session:subject-1:rt-predecessor'],
      seal: expectedSeal,
      ttl: 60_000,
    });
    expect(revokeOpenIDRefreshFlights).toHaveBeenNthCalledWith(2, {
      keys: ['session:subject-1:rt-successor-1', 'session:subject-2:rt-successor-1'],
      seal: expectedSeal,
      ttl: 60_000,
    });
    expect(revokeOpenIDRefreshFlights).toHaveBeenNthCalledWith(3, {
      keys: ['session:subject-1:rt-successor-2', 'session:subject-2:rt-successor-2'],
      seal: expectedSeal,
      ttl: 60_000,
    });
  });
});

describe('graphTokenController', () => {
  let req, res, upstreamTokenProvider, custody;

  /** The live upstream token set the custody-backed provider resolves (its access token is the
   *  OBO assertion). The exercised `resolveGraphApiToken` is the real `@librechat/api` export. */
  const liveTokens = {
    access_token: 'custody-access-token',
    id_token: 'custody-id-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  };

  const sessionMissingError = () =>
    Object.assign(new Error('OpenID session is no longer available'), {
      code: 'OPENID_SESSION_MISSING',
    });

  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockReturnValue(true);

    /** The provider the controller builds; default resolves the live custody token set. */
    upstreamTokenProvider = jest.fn().mockResolvedValue(liveTokens);
    createOpenIDSessionTokenProvider.mockReturnValue(upstreamTokenProvider);

    /** The custody liveness recheck before the response; default: still live. */
    custody = { custodyExists: jest.fn().mockResolvedValue(true) };
    getTokenCustodyService.mockReturnValue(custody);

    req = {
      user: {
        id: 'user-123',
        openidId: 'oid-123',
        provider: 'openid',
        tenantId: undefined,
      },
      headers: { authorization: 'Bearer app-jwt-which-is-id-token' },
      query: { scopes: 'https://graph.microsoft.com/.default' },
      /** The provider loads this; the recheck reads the hash and identity from it. */
      openidCustody: {
        tokenKeyHash: 'hash-abc',
        identity: { userId: 'user-123', tenantId: undefined },
      },
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    getGraphApiToken.mockResolvedValue({
      access_token: 'graph-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });
  });

  it('exchanges the custody-provided access token as the OBO assertion, not the header bearer', async () => {
    await graphTokenController(req, res);

    expect(getGraphApiToken).toHaveBeenCalledWith(
      req.user,
      'custody-access-token',
      'https://graph.microsoft.com/.default',
    );
    expect(getGraphApiToken).not.toHaveBeenCalledWith(
      expect.anything(),
      'app-jwt-which-is-id-token',
      expect.anything(),
    );
  });

  it('builds the provider with access_token preference', async () => {
    await graphTokenController(req, res);

    expect(createOpenIDSessionTokenProvider).toHaveBeenCalledWith(
      expect.objectContaining({ user: req.user, tokenPreference: 'access_token' }),
    );
  });

  it('should return the graph token response on success', async () => {
    await graphTokenController(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      access_token: 'graph-access-token',
      token_type: 'Bearer',
      expires_in: 3600,
    });
  });

  it('returns 401 and clears the OpenID cookies when the session is missing', async () => {
    upstreamTokenProvider.mockRejectedValue(sessionMissingError());

    await graphTokenController(req, res);

    expect(getGraphApiToken).not.toHaveBeenCalled();
    expect(clearOpenIDAuthTokens).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ code: 'OPENID_SESSION_MISSING' });
  });

  it('falls back to the request bearer (remote-agent) when the provider resolves null', async () => {
    upstreamTokenProvider.mockResolvedValue(null);
    req.user.federatedTokens = { access_token: 'remote-agent-bearer' };
    /** No custody record backs this request, so the pre-send recheck is skipped. */
    delete req.openidCustody;

    await graphTokenController(req, res);

    expect(getGraphApiToken).toHaveBeenCalledWith(
      req.user,
      'remote-agent-bearer',
      'https://graph.microsoft.com/.default',
    );
    expect(custody.custodyExists).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('returns 401 when the provider resolves null and no request bearer is present', async () => {
    upstreamTokenProvider.mockResolvedValue(null);
    delete req.openidCustody;

    await graphTokenController(req, res);

    expect(getGraphApiToken).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('fails closed when the custody record is deleted before the Graph response', async () => {
    custody.custodyExists.mockResolvedValue(false);

    await graphTokenController(req, res);

    expect(getGraphApiToken).toHaveBeenCalled();
    expect(custody.custodyExists).toHaveBeenCalledWith(
      expect.objectContaining({ tokenKeyHash: 'hash-abc', expectedUserId: 'user-123' }),
    );
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ code: 'OPENID_SESSION_MISSING' });
  });

  it('should return 403 when user is not authenticated via Entra ID', async () => {
    req.user.provider = 'google';
    req.user.openidId = undefined;

    await graphTokenController(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(getGraphApiToken).not.toHaveBeenCalled();
  });

  it('should return 403 when OPENID_REUSE_TOKENS is not enabled', async () => {
    isEnabled.mockReturnValue(false);

    await graphTokenController(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(getGraphApiToken).not.toHaveBeenCalled();
  });

  it('should return 400 when scopes query param is missing', async () => {
    req.query.scopes = undefined;

    await graphTokenController(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(getGraphApiToken).not.toHaveBeenCalled();
  });

  it('should return 500 when getGraphApiToken throws', async () => {
    getGraphApiToken.mockRejectedValue(new Error('OBO exchange failed'));

    await graphTokenController(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Failed to obtain Microsoft Graph token',
    });
  });
});

describe('refreshController – OpenID path', () => {
  /**
   * `refreshController` resolves the user from the custody context and delegates the refresh to
   * `refreshOpenIDSession`; a missing context or a session-missing rejection answers
   * `401 { code: 'OPENID_SESSION_MISSING' }`.
   */
  const { generateTokenKey, parseTokenKey, hashTokenKey, OPENID_USER_ID_COOKIE } =
    jest.requireActual('@librechat/api');

  const TOKEN_KEY = generateTokenKey();
  const TOKEN_KEY_HASH = hashTokenKey(parseTokenKey(TOKEN_KEY));

  const baseClaims = {
    iss: 'https://issuer.example.com',
    sub: 'oidc-sub-123',
    email: 'user@example.com',
    exp: 9999999999,
  };

  const refreshUser = {
    _id: 'user-db-id',
    email: baseClaims.email,
    openidId: baseClaims.sub,
    tenantId: 'tenant-1',
    openidIssuer: baseClaims.iss,
  };

  const makeMarker = (overrides = {}) =>
    jwt.sign(
      { id: 'user-db-id', tokenKeyHash: TOKEN_KEY_HASH, ...overrides },
      process.env.JWT_REFRESH_SECRET,
    );

  const makeCustodyContext = (overrides = {}) => ({
    tokens: {
      accessToken: 'access-old',
      idToken: 'id-old',
      refreshToken: 'refresh-old',
      issuedAt: Date.now(),
      ...(overrides.tokens ?? {}),
    },
    identity: {
      userId: 'user-db-id',
      tenantId: 'tenant-1',
      openidIssuer: baseClaims.iss,
      openidSubject: baseClaims.sub,
      ...(overrides.identity ?? {}),
    },
    tokenKeyHash: TOKEN_KEY_HASH,
    rotationCounter: 7,
    recordExpiresAt: new Date(Date.now() + 3_600_000),
    tokenKey: parseTokenKey(TOKEN_KEY),
  });

  const setOpenIDCookies = (marker = makeMarker(), tokenKey = TOKEN_KEY) => {
    const parts = ['token_provider=openid'];
    if (tokenKey != null) {
      parts.push(`openid_token_key=${tokenKey}`);
    }
    if (marker != null) {
      parts.push(`${OPENID_USER_ID_COOKIE}=${marker}`);
    }
    req.headers.cookie = parts.join('; ');
  };

  const sessionMissingError = () =>
    Object.assign(new Error('OpenID session is no longer available'), {
      code: 'OPENID_SESSION_MISSING',
    });

  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    mockActiveTenantId = undefined;
    delete process.env.OPENID_SCOPE;
    delete process.env.OPENID_REFRESH_AUDIENCE;
    process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

    isEnabled.mockReturnValue(true);
    setCloudFrontAuthCookies.mockReturnValue(true);
    getOpenIDAppAuthToken.mockReturnValue('new-app-token');
    getTokenCustodyService.mockReturnValue({ marker: 'custody-service' });
    getUserById.mockResolvedValue({ ...refreshUser });

    loadOpenIDCustody.mockResolvedValue(makeCustodyContext());
    refreshOpenIDSession.mockResolvedValue({
      access_token: 'access-new',
      id_token: 'id-new',
      refresh_token: 'refresh-new',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    req = {
      headers: {},
      session: {},
    };
    setOpenIDCookies();

    res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      redirect: jest.fn(),
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    };
  });

  it('skips the OpenID path when OPENID_REUSE_TOKENS is disabled', async () => {
    isEnabled.mockReturnValue(false);
    req.headers.cookie = 'token_provider=openid';

    await refreshController(req, res);

    expect(loadOpenIDCustody).not.toHaveBeenCalled();
    expect(refreshOpenIDSession).not.toHaveBeenCalled();
  });

  it('resolves the user and token set from the custody context and responds 200 { token, user }', async () => {
    await refreshController(req, res);

    expect(loadOpenIDCustody).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ custody: { marker: 'custody-service' } }),
    );
    expect(getUserById).toHaveBeenCalledWith('user-db-id', expect.any(String));
    expect(refreshOpenIDSession).toHaveBeenCalledWith(req, res, expect.any(Object), 'id_token');
    expect(getOpenIDAppAuthToken).toHaveBeenCalledWith(
      { id_token: 'id-new', access_token: 'access-new' },
      'id-old',
    );
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.send.mock.calls[0][0];
    expect(payload).toMatchObject({ token: 'new-app-token' });
    expect(payload.user).toMatchObject({ _id: 'user-db-id', email: baseClaims.email });
  });

  it('does not read req.session.openidTokens or the refreshToken cookie to resolve the user', async () => {
    req.session = {
      openidTokens: { appUserId: 'someone-else', refreshToken: 'session-refresh' },
    };
    req.headers.cookie = `${req.headers.cookie}; refreshToken=browser-refresh`;

    await refreshController(req, res);

    expect(getUserById).toHaveBeenCalledWith('user-db-id', expect.any(String));
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('never exposes sensitive fields or federatedTokens in the refresh response', async () => {
    getUserById.mockResolvedValue({
      ...refreshUser,
      password: 'hashed',
      __v: 3,
      totpSecret: 'secret',
      backupCodes: ['a', 'b'],
      federatedTokens: { access_token: 'x' },
    });

    await refreshController(req, res);

    const payload = res.send.mock.calls[0][0];
    expect(payload.user).not.toHaveProperty('password');
    expect(payload.user).not.toHaveProperty('__v');
    expect(payload.user).not.toHaveProperty('totpSecret');
    expect(payload.user).not.toHaveProperty('backupCodes');
    expect(payload.user).not.toHaveProperty('federatedTokens');
  });

  it('does not resend the local-auth branch when the OpenID path answers', async () => {
    await refreshController(req, res);
    // Only the OpenID 200 response is sent; the local-auth findSession path is never reached.
    expect(setAuthTokens).not.toHaveBeenCalled();
    expect(findSession).not.toHaveBeenCalled();
  });

  describe('missing / unbound cookie pair → 401 OPENID_SESSION_MISSING', () => {
    it('answers 401 when the token key cookie is absent, even with a previous-format refreshToken cookie', async () => {
      req.headers.cookie = `token_provider=openid; refreshToken=stored-refresh; ${OPENID_USER_ID_COOKIE}=${makeMarker()}`;

      await refreshController(req, res);

      expect(loadOpenIDCustody).not.toHaveBeenCalled();
      expect(refreshOpenIDSession).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.send).toHaveBeenCalledWith({ code: 'OPENID_SESSION_MISSING' });
    });

    it('answers 401 when the token key cookie does not parse to 32 bytes', async () => {
      setOpenIDCookies(makeMarker(), 'not-a-valid-token-key');

      await refreshController(req, res);

      expect(loadOpenIDCustody).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.send).toHaveBeenCalledWith({ code: 'OPENID_SESSION_MISSING' });
    });

    it('answers 401 when the marker carries no tokenKeyHash claim', async () => {
      setOpenIDCookies(
        jwt.sign({ id: 'user-db-id', refreshTokenHash: 'legacy' }, process.env.JWT_REFRESH_SECRET),
      );

      await refreshController(req, res);

      expect(loadOpenIDCustody).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.send).toHaveBeenCalledWith({ code: 'OPENID_SESSION_MISSING' });
    });

    it('answers 401 when the marker tokenKeyHash does not match the presented key', async () => {
      setOpenIDCookies(
        makeMarker({ tokenKeyHash: hashTokenKey(parseTokenKey(generateTokenKey())) }),
      );

      await refreshController(req, res);

      expect(loadOpenIDCustody).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.send).toHaveBeenCalledWith({ code: 'OPENID_SESSION_MISSING' });
    });

    it('accepts a matching key/marker pair regardless of any refreshToken cookie present', async () => {
      req.headers.cookie = `token_provider=openid; openid_token_key=${TOKEN_KEY}; refreshToken=browser-refresh; ${OPENID_USER_ID_COOKIE}=${makeMarker()}`;

      await refreshController(req, res);

      // The binding is the key/marker pair; the refreshToken cookie is irrelevant to acceptance.
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('no live custody record → 401 OPENID_SESSION_MISSING', () => {
    it('answers 401 without an IdP call when loadOpenIDCustody returns null', async () => {
      loadOpenIDCustody.mockResolvedValue(null);

      await refreshController(req, res);

      expect(refreshOpenIDSession).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.send).toHaveBeenCalledWith({ code: 'OPENID_SESSION_MISSING' });
    });

    it('answers 401 and clears cookies when the custody user cannot be found', async () => {
      getUserById.mockResolvedValue(null);

      await refreshController(req, res);

      expect(refreshOpenIDSession).not.toHaveBeenCalled();
      expect(clearOpenIDAuthTokens).toHaveBeenCalledWith(req, res, 'user-db-id', 'tenant-1');
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.send).toHaveBeenCalledWith({ code: 'OPENID_SESSION_MISSING' });
    });
  });

  describe('refresh delegation', () => {
    it('passes the request, response, resolved user and id_token preference to refreshOpenIDSession', async () => {
      await refreshController(req, res);

      expect(refreshOpenIDSession).toHaveBeenCalledTimes(1);
      const [passedReq, passedRes, passedUser, preference] = refreshOpenIDSession.mock.calls[0];
      expect(passedReq).toBe(req);
      expect(passedRes).toBe(res);
      expect(passedUser).toMatchObject({ _id: 'user-db-id' });
      expect(preference).toBe('id_token');
    });

    it('responds 401 OPENID_SESSION_MISSING and clears cookies when refreshOpenIDSession rejects session-missing (genuine invalid_grant)', async () => {
      refreshOpenIDSession.mockRejectedValue(sessionMissingError());

      await refreshController(req, res);

      expect(clearOpenIDAuthTokens).toHaveBeenCalledWith(req, res, 'user-db-id', 'tenant-1');
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.send).toHaveBeenCalledWith({ code: 'OPENID_SESSION_MISSING' });
    });

    it('responds 401 OPENID_SESSION_MISSING when refreshOpenIDSession resolves null', async () => {
      refreshOpenIDSession.mockResolvedValue(null);

      await refreshController(req, res);

      expect(clearOpenIDAuthTokens).toHaveBeenCalledWith(req, res, 'user-db-id', 'tenant-1');
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.send).toHaveBeenCalledWith({ code: 'OPENID_SESSION_MISSING' });
    });

    it('clears cookies and responds 403 on an ownership error', async () => {
      refreshOpenIDSession.mockRejectedValue(ownershipLost('lease lost'));

      await refreshController(req, res);

      expect(clearOpenIDAuthTokens).toHaveBeenCalledWith(req, res, 'user-db-id', 'tenant-1');
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.send).toHaveBeenCalledWith('Invalid OpenID refresh token');
    });

    it('responds 403 without clearing cookies on a generic refresh error (e.g. identity mismatch)', async () => {
      refreshOpenIDSession.mockRejectedValue(new Error('OpenID session token identity mismatch'));

      await refreshController(req, res);

      expect(clearOpenIDAuthTokens).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.send).toHaveBeenCalledWith('Invalid OpenID refresh token');
    });

    it('answers 401 when the custody context cannot be loaded due to a store error', async () => {
      loadOpenIDCustody.mockRejectedValue(new Error('mongo down'));

      await refreshController(req, res);

      expect(refreshOpenIDSession).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.send).toHaveBeenCalledWith({ code: 'OPENID_SESSION_MISSING' });
    });
  });

  it('contains no bridge-recovery branch: a session-missing refresh answers 401 with no recovery', async () => {
    // A session-missing rejection results in a 401 rather than any recovery attempt.
    refreshOpenIDSession.mockRejectedValue(sessionMissingError());

    await refreshController(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('refreshController – LibreChat path', () => {
  let req, res;
  const refreshSecret = 'test-refresh-secret';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_REFRESH_SECRET = refreshSecret;
    process.env.NODE_ENV = 'test';
    setAuthTokens.mockResolvedValue('local-app-token');
    findSession.mockResolvedValue({ expiration: new Date(Date.now() + 60_000) });

    const refreshToken = jwt.sign({ id: 'local-user-id' }, refreshSecret, {
      expiresIn: '1h',
    });
    req = {
      headers: { cookie: `refreshToken=${refreshToken}` },
      query: {},
      session: {},
    };
    res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      redirect: jest.fn(),
    };
  });

  afterAll(() => {
    if (ORIGINAL_JWT_REFRESH_SECRET === undefined) {
      delete process.env.JWT_REFRESH_SECRET;
    } else {
      process.env.JWT_REFRESH_SECRET = ORIGINAL_JWT_REFRESH_SECRET;
    }

    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    }
  });

  it('sanitizes user documents before returning local refresh responses', async () => {
    getUserById.mockResolvedValue({
      toObject: () => ({
        _id: 'local-user-id',
        email: 'local@example.com',
        password: 'hashed-password',
        __v: 1,
        totpSecret: 'totp-secret',
        backupCodes: ['backup-code'],
        federatedTokens: { access_token: 'do-not-return' },
      }),
    });

    await refreshController(req, res);

    const sentPayload = res.send.mock.calls[0][0];
    expect(setAuthTokens).toHaveBeenCalledWith(
      'local-user-id',
      res,
      { expiration: expect.any(Date) },
      req,
    );
    expect(sentPayload).toEqual({
      token: 'local-app-token',
      user: {
        _id: 'local-user-id',
        email: 'local@example.com',
      },
    });
  });

  it('sanitizes user documents before returning CI refresh responses', async () => {
    process.env.NODE_ENV = 'CI';
    getUserById.mockResolvedValue({
      toObject: () => ({
        _id: 'local-user-id',
        email: 'local@example.com',
        password: 'hashed-password',
        __v: 1,
        totpSecret: 'totp-secret',
        backupCodes: ['backup-code'],
        federatedTokens: { access_token: 'do-not-return' },
      }),
    });

    await refreshController(req, res);

    const sentPayload = res.send.mock.calls[0][0];
    expect(findSession).not.toHaveBeenCalled();
    expect(setAuthTokens).toHaveBeenCalledWith('local-user-id', res, null, req);
    expect(sentPayload).toEqual({
      token: 'local-app-token',
      user: {
        _id: 'local-user-id',
        email: 'local@example.com',
      },
    });
  });
});

describe('registrationController - invite consumption', () => {
  const invite = { token: 'hashed-invite', email: 'invitee@example.com' };

  const buildRes = () => {
    const res = {};
    res.status = jest.fn(() => res);
    res.send = jest.fn(() => res);
    res.json = jest.fn(() => res);
    return res;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('consumes the invite once the account exists', async () => {
    registerUser.mockResolvedValue({ status: 200, message: 'ok', userCreated: true });

    await registrationController({ body: {}, invite }, buildRes());

    expect(deleteTokens).toHaveBeenCalledWith({ token: 'hashed-invite' });
  });

  it('leaves the invite when registration is rejected', () => {
    /** A mistyped password confirmation is the common case; it has to stay retryable. */
    registerUser.mockResolvedValue({ status: 404, message: 'The passwords did not match' });

    return registrationController({ body: {}, invite }, buildRes()).then(() => {
      expect(deleteTokens).not.toHaveBeenCalled();
    });
  });

  it('leaves the invite when the email is already in use, despite the 200', async () => {
    /** `registerUser` returns the same status and message whether it created an account
     *  or found the email taken, so the status alone cannot drive this decision. */
    registerUser.mockResolvedValue({ status: 200, message: 'ok' });

    await registrationController({ body: {}, invite }, buildRes());

    expect(deleteTokens).not.toHaveBeenCalled();
  });

  it('does not attempt a deletion for an uninvited registration', async () => {
    registerUser.mockResolvedValue({ status: 200, message: 'ok', userCreated: true });

    await registrationController({ body: {} }, buildRes());

    expect(deleteTokens).not.toHaveBeenCalled();
  });

  it('still reports success when consuming the invite fails', async () => {
    /** The account exists by this point; reporting failure would be worse than
     *  leaving a usable invite behind. */
    registerUser.mockResolvedValue({ status: 200, message: 'ok', userCreated: true });
    deleteTokens.mockRejectedValue(new Error('mongo unavailable'));
    const res = buildRes();

    await registrationController({ body: {}, invite }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith({ message: 'ok' });
    expect(logger.error).toHaveBeenCalled();
  });

  it('never forwards the creation signal to the client', async () => {
    registerUser.mockResolvedValue({ status: 200, message: 'ok', userCreated: true });
    const res = buildRes();

    await registrationController({ body: {}, invite }, res);

    expect(res.send).toHaveBeenCalledWith({ message: 'ok' });
  });
});
