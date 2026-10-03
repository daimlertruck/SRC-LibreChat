/**
 * Token rotation and `invalid_grant` on `/api/auth/refresh`, driving the real `refreshController`
 * and `refreshOpenIDSession` against a real custody service on `mongodb-memory-server`. Only the IdP
 * token endpoint (`refreshTokenGrant`) is mocked; `AuthController.spec.js` mocks
 * `refreshOpenIDSession` and so cannot reach this behavior.
 */

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

/**
 * The single mocked dependency: the IdP token endpoint. Every other export is the real one so the
 * refresh service and the custody service run unmodified.
 */
const mockRefreshTokenGrant = jest.fn();
jest.mock('openid-client', () => ({
  __esModule: true,
  refreshTokenGrant: (...args) => mockRefreshTokenGrant(...args),
}));

/** Shared holders the mocked service modules read after `beforeAll` wires the real instances. */
const mockCustodyHolder = { service: null };
const mockRefreshHolder = { refreshOpenIDSession: null };
const mockClearOpenIDAuthTokens = jest.fn();
/** The orphaned-token revocation the `gone` branch runs; a spy so the test asserts its argument. */
const mockRevokeRefreshToken = jest.fn().mockResolvedValue(undefined);

jest.mock('~/strategies/openidStrategy', () => ({
  getOpenIdConfig: jest.fn(() => ({})),
}));

jest.mock('~/models', () => {
  /** Real data-schemas methods are attached in `beforeAll`; the holder keeps them reachable. */
  const holder = { methods: null };
  const proxyMethod =
    (name) =>
    (...args) => {
      if (!holder.methods) {
        throw new Error(`~/models proxy called before methods were wired: ${name}`);
      }
      return holder.methods[name](...args);
    };
  return {
    __holder: holder,
    upsertTokenCustody: proxyMethod('upsertTokenCustody'),
    findTokenCustody: proxyMethod('findTokenCustody'),
    findTokenCustodyMeta: proxyMethod('findTokenCustodyMeta'),
    updateTokenCustodyIfCurrent: proxyMethod('updateTokenCustodyIfCurrent'),
    deleteTokenCustody: proxyMethod('deleteTokenCustody'),
    deleteTokenCustodiesByUser: proxyMethod('deleteTokenCustodiesByUser'),
    getUserById: jest.fn(),
    deleteAllUserSessions: jest.fn(),
    findSession: jest.fn(),
    deleteTokens: jest.fn(),
  };
});

jest.mock('~/server/services/AuthService', () => ({
  getTokenCustodyService: () => mockCustodyHolder.service,
  clearOpenIDAuthTokens: (...args) => mockClearOpenIDAuthTokens(...args),
  getOpenIDAppAuthToken: (tokenset) => tokenset?.id_token || tokenset?.access_token,
  setCloudFrontAuthCookies: jest.fn(() => false),
  setOpenIDAuthTokens: jest.fn(),
  getOpenIDAppAuthTokenNoop: jest.fn(),
  requestPasswordReset: jest.fn(),
  resetPassword: jest.fn(),
  setAuthTokens: jest.fn(),
  registerUser: jest.fn(),
}));

jest.mock('~/server/services/OpenIDSessionRefresh', () => ({
  refreshOpenIDSession: (...args) => mockRefreshHolder.refreshOpenIDSession(...args),
}));

/** The controller also requires this; the refresh path never touches it, so a plain stub. */
jest.mock('~/server/services/GraphTokenService', () => ({ getGraphApiToken: jest.fn() }));

const api = require('@librechat/api');
const {
  createTokenCustodyService,
  createOpenIDSessionRefreshService,
  resolveRecordExpiry,
  parseTokenKey,
  hashTokenKey,
  loadOpenIDCustody,
  setTokenKeyCookie,
  clearTokenKeyCookie,
  TOKEN_KEY_COOKIE,
  OPENID_USER_ID_COOKIE,
} = api;
const {
  createMethods,
  createModels,
  DEFAULT_REFRESH_TOKEN_EXPIRY,
} = require('@librechat/data-schemas');

const { refreshController } = require('./AuthController');
const models = require('~/models');

const JWT_REFRESH_SECRET = 'test';
const ISSUER = 'https://issuer.example.com';
const SUBJECT = 'oidc-sub-123';
const USER_ID = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const TENANT_ID = undefined;

/**
 * A fixed fallback so the fallback branch of the record lifetime rule is deterministic across
 * `createCustody` and `rotateCustody`. Matches how `AuthService` wires `fallbackRefreshTtlMs`.
 */
const FALLBACK_REFRESH_TTL_MS = DEFAULT_REFRESH_TOKEN_EXPIRY;

let mongoServer;
let custodyService;
let refreshService;
const logger = { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() };

const IDENTITY = {
  userId: USER_ID,
  tenantId: TENANT_ID,
  openidIssuer: ISSUER,
  openidSubject: SUBJECT,
};

const REFRESH_USER = {
  _id: USER_ID,
  id: USER_ID,
  email: 'user@example.com',
  openidId: SUBJECT,
  tenantId: TENANT_ID,
  openidIssuer: ISSUER,
  provider: 'openid',
};

beforeAll(async () => {
  process.env.JWT_REFRESH_SECRET = JWT_REFRESH_SECRET;
  process.env.OPENID_REUSE_TOKENS = 'true';

  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);

  const methods = createMethods(mongoose);
  models.__holder.methods = {
    upsertTokenCustody: methods.upsertTokenCustody,
    findTokenCustody: methods.findTokenCustody,
    /** Projected read the service's `db` type names for the file-authorization paths. */
    findTokenCustodyMeta: async (query) => {
      const record = await methods.findTokenCustody(query);
      return record === null ? null : { userId: record.userId };
    },
    updateTokenCustodyIfCurrent: methods.updateTokenCustodyIfCurrent,
    deleteTokenCustody: methods.deleteTokenCustody,
    deleteTokenCustodiesByUser: methods.deleteTokenCustodiesByUser,
  };

  custodyService = createTokenCustodyService({
    db: {
      upsertTokenCustody: methods.upsertTokenCustody,
      findTokenCustody: methods.findTokenCustody,
      findTokenCustodyMeta: async (query) => {
        const record = await methods.findTokenCustody(query);
        return record === null ? null : { userId: record.userId };
      },
      updateTokenCustodyIfCurrent: methods.updateTokenCustodyIfCurrent,
      deleteTokenCustody: methods.deleteTokenCustody,
      deleteTokenCustodiesByUser: methods.deleteTokenCustodiesByUser,
    },
    logger,
    fallbackRefreshTtlMs: FALLBACK_REFRESH_TTL_MS,
  });
  mockCustodyHolder.service = custodyService;

  /**
   * The real refresh service, wired the way `api/server/services/OpenIDSessionRefresh.js` wires it,
   * but pointed at this test's custody service and the mocked IdP grant.
   */
  refreshService = createOpenIDSessionRefreshService({
    jwt,
    cookies: require('cookie'),
    crypto: require('node:crypto'),
    openIdClient: { refreshTokenGrant: (...args) => mockRefreshTokenGrant(...args) },
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
    getOpenIdConfig: () => ({}),
    getCustody: () => custodyService,
    loadOpenIDCustody,
    setTokenKeyCookie,
    clearTokenKeyCookie,
    revokeRefreshToken: (...args) => mockRevokeRefreshToken(...args),
  });
  mockRefreshHolder.refreshOpenIDSession = refreshService.refreshOpenIDSession;

  /** The real teardown behavior: delete the record for the presented key's hash, drop the cookie. */
  mockClearOpenIDAuthTokens.mockImplementation(async (req, res) => {
    const cookieValue = req.cookies?.[TOKEN_KEY_COOKIE];
    const key = parseTokenKey(cookieValue);
    if (key) {
      await custodyService.deleteCustody({ tokenKeyHash: hashTokenKey(key) });
    }
    clearTokenKeyCookie(res);
  });
});

afterAll(async () => {
  /**
   * `refreshController` fires `clearOpenIDAuthTokens` without awaiting it on its session-missing and
   * ownership-error branches, so a background custody delete can still be in flight when a test
   * returns. Drain the microtask/timer queue before disconnecting so that delete does not run
   * against a closed Mongo client and surface as a post-teardown error.
   */
  await new Promise((resolve) => setTimeout(resolve, 50));
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  jest.clearAllMocks();
  models.getUserById.mockResolvedValue({ ...REFRESH_USER });
  /** Reset the in-flight coalescing map so each test starts from a clean single-flight state. */
  refreshService.__internals.inFlightRefreshes.clear();
});

/** Signs a marker cookie binding `USER_ID` to the given key's hash, as `setOpenIDMarkerCookies` does. */
function makeMarker(tokenKey, overrides = {}) {
  const key = parseTokenKey(tokenKey);
  return jwt.sign(
    { id: USER_ID, tokenKeyHash: hashTokenKey(key), ...overrides },
    JWT_REFRESH_SECRET,
  );
}

/**
 * Mints a custody record for a login, returning the cookie value, the derived expiry and the
 * request/response fixtures a `/refresh` call needs. `accessTokenExpiresAt` / `refreshTokenExpiresAt`
 * are unix seconds, matching the login path (`setOpenIDAuthTokens`).
 */
async function login({ accessTokenExpiresAt } = {}) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  /**
   * Mirror the real login path (`setOpenIDAuthTokens`): the code-exchange carries no refresh-token
   * expiry, so the record's TTL comes from the fallback term; `accessTokenExpiresAt` is unix
   * seconds. The access token is deliberately already expired so the first `/refresh` must contact
   * the IdP rather than reusing a still-fresh token.
   */
  const tokens = {
    accessToken: 'access-login',
    idToken: 'id-login',
    refreshToken: 'refresh-login',
    accessTokenExpiresAt: accessTokenExpiresAt ?? nowSeconds - 60,
    issuedAt: Date.now(),
  };
  const created = await custodyService.createCustody({ tokens, identity: IDENTITY });
  return {
    tokenKey: created.tokenKey,
    tokenKeyHash: created.tokenKeyHash,
    expiresAt: created.expiresAt,
  };
}

/** Builds a `/refresh` req/res pair carrying the OpenID cookie triple. */
function makeReqRes(tokenKey, marker = makeMarker(tokenKey)) {
  const cookieHeader = [
    'token_provider=openid',
    `${TOKEN_KEY_COOKIE}=${tokenKey}`,
    `${OPENID_USER_ID_COOKIE}=${marker}`,
  ].join('; ');
  const req = {
    headers: { cookie: cookieHeader },
    cookies: {
      token_provider: 'openid',
      [TOKEN_KEY_COOKIE]: tokenKey,
      [OPENID_USER_ID_COOKIE]: marker,
    },
    session: {},
  };
  const res = {
    headersSent: false,
    statusCode: null,
    body: undefined,
    status: jest.fn(function (code) {
      this.statusCode = code;
      return this;
    }),
    send: jest.fn(function (payload) {
      this.body = payload;
      return this;
    }),
    cookie: jest.fn(),
    clearCookie: jest.fn(),
    redirect: jest.fn(),
  };
  return { req, res };
}

/** Reads the single Set-Cookie call for the token key cookie on a response, or undefined. */
function tokenKeyCookieCall(res) {
  return res.cookie.mock.calls.find(([name]) => name === TOKEN_KEY_COOKIE);
}

async function findRecord(tokenKeyHash) {
  return mongoose.models.TokenCustody.findOne({ tokenKeyHash }).lean();
}

async function countRecords() {
  return mongoose.models.TokenCustody.countDocuments();
}

/**
 * Normalizes a timestamp to milliseconds. `expiresAt` is stored as a `Date`; `lastRefreshedAt` is
 * stored as a number (the receipt-time ms `resolveRecordExpiry` was anchored at). Reading both
 * through the same accessor keeps the assertion agnostic to that column's storage shape.
 */
function asMs(value) {
  return value instanceof Date ? value.getTime() : Number(value);
}

/**
 * Recomputes the record lifetime rule from a stored record's own unsealed columns, so the assertion is
 * "against the derived value" rather than against `expiresAt` always moving later. `resolveRecordExpiry`
 * is the single authority both `createCustody` and `rotateCustody` write through.
 */
function derivedExpiryOf(record) {
  return resolveRecordExpiry(
    {
      accessTokenExpiresAt: record.accessTokenExpiresAt,
      refreshTokenExpiresAt: record.refreshTokenExpiresAt,
    },
    asMs(record.lastRefreshedAt),
    FALLBACK_REFRESH_TTL_MS,
  );
}

/** Builds a `refreshTokenGrant` response with optional access and refresh expiries. */
function grantResponse({ expiresIn, refreshExpiresIn } = {}) {
  const response = {
    access_token: 'access-new',
    id_token: 'id-new',
    refresh_token: 'refresh-new',
  };
  if (expiresIn !== undefined) {
    response.expires_in = expiresIn;
  }
  if (refreshExpiresIn !== undefined) {
    response.refresh_expires_in = refreshExpiresIn;
  }
  return response;
}

describe('refreshController — rotation at the route level', () => {
  /**
   * A refresh across a rotation leaves the token key cookie value byte-identical, sets the record's
   * `expiresAt` to the lifetime derived from the rotation response, and re-issues the cookie with
   * `expires` equal to that same instant — asserted against the derived value.
   */
  it('re-issues the byte-identical cookie value with expires equal to the derived record expiresAt', async () => {
    const { tokenKey, tokenKeyHash } = await login();
    mockRefreshTokenGrant.mockResolvedValue(
      grantResponse({ expiresIn: 3600, refreshExpiresIn: 7 * 24 * 3600 }),
    );
    const { req, res } = makeReqRes(tokenKey);

    await refreshController(req, res);

    expect(mockRefreshTokenGrant).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);

    const record = await findRecord(tokenKeyHash);
    expect(record.rotationCounter).toBe(1);

    // The cookie value is unchanged by rotation — the token key itself never changes.
    const cookieCall = tokenKeyCookieCall(res);
    expect(cookieCall).toBeDefined();
    const [, cookieValue, cookieOptions] = cookieCall;
    expect(cookieValue).toBe(tokenKey);

    // The record's expiresAt is the value the record lifetime rule derives from the rotation response.
    expect(asMs(record.expiresAt)).toBe(derivedExpiryOf(record).getTime());
    // The cookie's expires equals that same instant — one derived value, record and cookie.
    expect(asMs(cookieOptions.expires)).toBe(asMs(record.expiresAt));
  });

  /**
   * The record lifetime rule over all four response shapes: both expiries present, refresh expiry only,
   * access expiry only, neither. In the last two the fallback term applies. Each is asserted against
   * the derived value the store recomputed, and the cookie follows it.
   */
  describe.each([
    ['both expiries present', { expiresIn: 3600, refreshExpiresIn: 7 * 24 * 3600 }],
    ['refresh expiry only', { refreshExpiresIn: 7 * 24 * 3600 }],
    ['access expiry only', { expiresIn: 3600 }],
    ['neither expiry', {}],
  ])('response shape: %s', (_label, grantArgs) => {
    it('sets the record and cookie expires to the derived lifetime', async () => {
      const { tokenKey, tokenKeyHash } = await login();
      mockRefreshTokenGrant.mockResolvedValue(grantResponse(grantArgs));
      const { req, res } = makeReqRes(tokenKey);

      await refreshController(req, res);

      expect(res.statusCode).toBe(200);
      const record = await findRecord(tokenKeyHash);

      expect(asMs(record.expiresAt)).toBe(derivedExpiryOf(record).getTime());

      // In the two fallback shapes the response states no refresh expiry, so the record carries none.
      if (grantArgs.refreshExpiresIn === undefined) {
        expect(record.refreshTokenExpiresAt).toBeUndefined();
      } else {
        expect(record.refreshTokenExpiresAt).toBeDefined();
      }

      const [, cookieValue, cookieOptions] = tokenKeyCookieCall(res);
      expect(cookieValue).toBe(tokenKey);
      expect(asMs(cookieOptions.expires)).toBe(asMs(record.expiresAt));
    });
  });

  /**
   * A rotation whose response omits a refresh-token expiry the previous response provided: the
   * record falls back to the `fallbackRefreshTtlMs` term, and `expiresAt` is permitted to land
   * earlier than it was before the refresh, with the cookie's `expires` following it. The prior
   * value is not read, so nothing carries it forward.
   */
  it('recomputes expiresAt from the rotation response alone, permitting it to land earlier than before', async () => {
    /**
     * The record's lifetime is recomputed on every rotation from the response in hand and its
     * receipt time; the stored value is never an input. `expiresAt` is *permitted to land earlier*
     * — the test must not assume it always moves later — and the cookie's `expires` follows the
     * recomputed record value whichever direction it moves.
     *
     * The login record carries no refresh-token expiry, so its `expiresAt` is the fallback term (a
     * point well into the future). The route-level refresh then rotates with a response that STATES a
     * refresh-token expiry, so the record's `expiresAt` becomes a function of that stated value
     * instead — a different, independent derivation that here lands earlier than the fallback the
     * login used. The assertion pins the new value to the derived rule (`resolveRecordExpiry` over the
     * record's own columns) rather than to a direction of change.
     */
    const { tokenKey, tokenKeyHash } = await login();
    const before = await findRecord(tokenKeyHash);
    expect(before.refreshTokenExpiresAt).toBeUndefined();
    // Login's expiresAt is the fallback term (future) and matches the derived rule.
    expect(asMs(before.expiresAt)).toBe(derivedExpiryOf(before).getTime());

    // The route-level rotation response states a refresh-token expiry the login did not carry. It is
    // unix seconds (`refresh_expires_in`); one hour derives an `expiresAt` an hour out — earlier than
    // the login's seven-day fallback term, the legitimate decrease the rule permits.
    mockRefreshTokenGrant.mockResolvedValue(
      grantResponse({ expiresIn: 3600, refreshExpiresIn: 3600 }),
    );
    const { req, res } = makeReqRes(tokenKey);

    await refreshController(req, res);

    expect(res.statusCode).toBe(200);
    const after = await findRecord(tokenKeyHash);
    expect(after.rotationCounter).toBe(1);
    // The new record carries the stated refresh expiry, so it drove the recomputation.
    expect(after.refreshTokenExpiresAt).toBeDefined();

    // The new expiresAt is recomputed from the response alone; the prior stored value was not read.
    expect(asMs(after.expiresAt)).toBe(derivedExpiryOf(after).getTime());
    // It is a different derivation than the login's fallback term — here it lands earlier, which the
    // rule explicitly permits. The assertion is against the derived value, not a monotonic direction.
    expect(asMs(after.expiresAt)).not.toBe(asMs(before.expiresAt));
    expect(asMs(after.expiresAt)).toBeLessThan(asMs(before.expiresAt));
    // The cookie's expires follows the recomputed record value, whichever direction it moved.
    const [, , cookieOptions] = tokenKeyCookieCall(res);
    expect(asMs(cookieOptions.expires)).toBe(asMs(after.expiresAt));
  });
});

describe('refreshController — invalid_grant at the route level', () => {
  /**
   * `invalid_grant` with a concurrent rotation (a higher counter on re-read) retries with the fresh
   * set and succeeds. We simulate the concurrent winner by advancing the record's counter (through a
   * real `rotateCustody` on a second opened context) before the IdP rejects the losing worker.
   */
  it('retries with the concurrent winner set on a higher-counter reload and succeeds', async () => {
    const { tokenKey, tokenKeyHash } = await login();
    const key = parseTokenKey(tokenKey);

    // The losing worker opens the counter-0 context and then hits invalid_grant on the IdP.
    mockRefreshTokenGrant.mockImplementation(async () => {
      // A concurrent worker rotates the record to counter 1 with a distinct token set first.
      const winnerContext = await custodyService.openCustody({
        tokenKey: key,
        expectedUserId: USER_ID,
      });
      await custodyService.rotateCustody({
        context: winnerContext,
        tokens: {
          accessToken: 'access-concurrent-winner',
          idToken: 'id-concurrent-winner',
          refreshToken: 'refresh-concurrent-winner',
          accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
          issuedAt: Date.now(),
        },
      });
      throw Object.assign(new Error('token rejected'), { error: 'invalid_grant' });
    });

    const { req, res } = makeReqRes(tokenKey);
    await refreshController(req, res);

    // The refresh succeeded by adopting the concurrent winner: no delete, no cookie clear.
    expect(res.statusCode).toBe(200);
    expect(mockClearOpenIDAuthTokens).not.toHaveBeenCalled();
    expect(await countRecords()).toBe(1);
    const record = await findRecord(tokenKeyHash);
    expect(record.rotationCounter).toBe(1);
  });

  /**
   * `invalid_grant` without a concurrent rotation (the counter is unchanged on re-read) deletes the
   * record, clears the cookies, and is rejected as unauthenticated with `OPENID_SESSION_MISSING`.
   */
  it('deletes the record and clears cookies on an unchanged-counter reload, answering 401', async () => {
    const { tokenKey, tokenKeyHash } = await login();
    mockRefreshTokenGrant.mockRejectedValue(
      Object.assign(new Error('token rejected'), { error: 'invalid_grant' }),
    );

    const { req, res } = makeReqRes(tokenKey);
    await refreshController(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ code: 'OPENID_SESSION_MISSING' });
    // The record is retired and the token key cookie is dropped.
    expect(await findRecord(tokenKeyHash)).toBeNull();
    expect(await countRecords()).toBe(0);
    expect(res.clearCookie).toHaveBeenCalledWith(TOKEN_KEY_COOKIE, { path: '/' });
  });
});

describe('refreshController — single-flight coalescing at the route level', () => {
  /**
   * A second waiter on the same in-flight refresh joins the leader's grant rather than issuing a
   * second one: two concurrent `/refresh` calls on the same token key produce exactly one IdP grant,
   * and both responses reflect the single rotation. The waiter opens the rotated set from the shared
   * flight without a second IdP call — the route-level analogue of a second worker reading
   * `sealedResult` under its own cookie's key.
   */
  it('coalesces two concurrent refreshes into a single IdP grant', async () => {
    const { tokenKey, tokenKeyHash } = await login();

    let resolveGrant;
    mockRefreshTokenGrant.mockReturnValue(
      new Promise((resolve) => {
        resolveGrant = resolve;
      }),
    );

    const first = makeReqRes(tokenKey);
    const second = makeReqRes(tokenKey);
    const firstCall = refreshController(first.req, first.res);
    const secondCall = refreshController(second.req, second.res);

    // Let both callers reach the single-flight join before the grant resolves.
    await new Promise((resolve) => setImmediate(resolve));
    resolveGrant(grantResponse({ expiresIn: 3600, refreshExpiresIn: 7 * 24 * 3600 }));
    await Promise.all([firstCall, secondCall]);

    expect(mockRefreshTokenGrant).toHaveBeenCalledTimes(1);
    expect(first.res.statusCode).toBe(200);
    expect(second.res.statusCode).toBe(200);

    // Exactly one rotation was applied to the single record.
    expect(await countRecords()).toBe(1);
    const record = await findRecord(tokenKeyHash);
    expect(record.rotationCounter).toBe(1);
  });
});

/**
 * Requirement 29: the custody record supplies the tenant. Login stamps the record's `tenantId` from
 * the authenticated user; `/refresh` is unauthenticated and no longer carries the session copy, so
 * the lookup must address the record by hash alone and read the tenant back from the opened record,
 * rather than requiring the caller to supply the tenant up front. This block mints a tenant-stamped
 * record and drives `/refresh` with no tenant header; it must succeed exactly as the no-tenant case
 * does.
 */
describe('refreshController — tenant-scoped custody records (Requirement 29)', () => {
  const TENANT = 'tenant-a';
  const TENANT_IDENTITY = {
    userId: USER_ID,
    tenantId: TENANT,
    openidIssuer: ISSUER,
    openidSubject: SUBJECT,
  };
  const TENANT_USER = { ...REFRESH_USER, tenantId: TENANT };

  /** Mints a tenant-stamped record, mirroring `login()` but with a tenant on the identity. */
  async function loginTenant() {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const created = await custodyService.createCustody({
      tokens: {
        accessToken: 'access-login',
        idToken: 'id-login',
        refreshToken: 'refresh-login',
        accessTokenExpiresAt: nowSeconds - 60,
        issuedAt: Date.now(),
      },
      identity: TENANT_IDENTITY,
    });
    return created;
  }

  it('refreshes a tenant-stamped record with no tenant header', async () => {
    models.getUserById.mockResolvedValue({ ...TENANT_USER });
    const { tokenKey, tokenKeyHash } = await loginTenant();
    mockRefreshTokenGrant.mockResolvedValue(
      grantResponse({ expiresIn: 3600, refreshExpiresIn: 7 * 24 * 3600 }),
    );
    const { req, res } = makeReqRes(tokenKey);

    await refreshController(req, res);

    expect(mockRefreshTokenGrant).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.body?.token).toBeTruthy();
    const record = await findRecord(tokenKeyHash);
    expect(record.rotationCounter).toBe(1);
    expect(record.tenantId).toBe(TENANT);
  });
});

/**
 * Requirement 30: a rotation that finds its record deleted fails closed. When a logout, ban or
 * account deletion removes the custody record while a refresh holds the IdP grant in flight, the
 * rotation's compare-and-set matches nothing and the reload finds nothing live. The refresh must
 * then reject session-missing rather than revive the pre-rotation session, re-issue no token key
 * cookie, return no token, and make one best-effort IdP revocation of the refresh token it just
 * obtained (which the rotation never persisted and nothing else will revoke).
 */
describe('refreshController — record deleted mid-rotation (Requirement 30)', () => {
  it('fails closed, re-issues no cookie, and revokes the just-granted refresh token', async () => {
    const { tokenKey, tokenKeyHash } = await login();

    /**
     * The IdP grant succeeds, but the record is deleted (a concurrent logout) between the grant and
     * the rotation's compare-and-set. The granted refresh token is the one the orphan-revocation
     * must target.
     */
    mockRefreshTokenGrant.mockImplementation(async () => {
      await custodyService.deleteCustody({ tokenKeyHash });
      return grantResponse({ expiresIn: 3600, refreshExpiresIn: 7 * 24 * 3600 });
    });

    const { req, res } = makeReqRes(tokenKey);
    await refreshController(req, res);

    // The IdP was contacted exactly once; no second grant was attempted.
    expect(mockRefreshTokenGrant).toHaveBeenCalledTimes(1);

    // Fails closed: 401 session-missing, no token in the body.
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ code: 'OPENID_SESSION_MISSING' });

    // No token key cookie was re-issued.
    expect(tokenKeyCookieCall(res)).toBeUndefined();

    // The record stays gone; the pre-rotation context was not revived into a new record.
    expect(await countRecords()).toBe(0);

    // Exactly one best-effort revocation, carrying the refresh token the IdP just granted.
    expect(mockRevokeRefreshToken).toHaveBeenCalledTimes(1);
    expect(mockRevokeRefreshToken.mock.calls[0][0]).toMatchObject({
      refreshToken: 'refresh-new',
    });
  });

  it('still fails closed when the orphan-token revocation itself rejects', async () => {
    const { tokenKey, tokenKeyHash } = await login();
    mockRevokeRefreshToken.mockRejectedValueOnce(new Error('IdP unreachable'));
    mockRefreshTokenGrant.mockImplementation(async () => {
      await custodyService.deleteCustody({ tokenKeyHash });
      return grantResponse({ expiresIn: 3600, refreshExpiresIn: 7 * 24 * 3600 });
    });

    const { req, res } = makeReqRes(tokenKey);
    await refreshController(req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ code: 'OPENID_SESSION_MISSING' });
    expect(tokenKeyCookieCall(res)).toBeUndefined();
    expect(mockRevokeRefreshToken).toHaveBeenCalledTimes(1);
  });
});
