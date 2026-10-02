/**
 * Logout, image and shared-link authorization, ban and account deletion against ONE real
 * `mongodb-memory-server` custody store, so a delete on one path makes the next authorizing request
 * fail closed. The unit specs mock the custody service; here only the IdP revocation chain is mocked.
 */
const jwt = require('jsonwebtoken');
const cookie = require('cookie');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const {
  createTokenCustodyService,
  createImageAuthorizationMiddleware,
  loadOpenIDCustody,
  verifyCustodyBinding,
  generateTokenKey,
  TOKEN_KEY_COOKIE,
  OPENID_USER_ID_COOKIE,
} = require('@librechat/api');
const { createMethods, tokenCustodySchema, logger } = require('@librechat/data-schemas');

const JWT_REFRESH_SECRET = 'key-custody-route-secret';
const FALLBACK_REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Two distinct 24-hex-char ObjectIds so the marker's `id` claim is well-formed. */
const USER_ID = '65cfb246f7ecadb8b1e8036b';
const OTHER_USER_ID = '65cfb246f7ecadb8b1e8036c';

/* ────────────────────────────────────────────────────────────────────────────
 * Shared real store + service, wired once and reachable by every path under test.
 * ──────────────────────────────────────────────────────────────────────────── */

let mongoServer;
/** The real data-schemas method set, each method wrapped in a jest spy. */
let db;
/** The real custody service constructed over `db`. */
let custodyService;

/**
 * Builds the spied method set from the real data-schemas methods. `createMethods(mongoose)`
 * constructs the full method graph lazily; only the custody methods are exercised here, and each
 * touches the registered `TokenCustody` model when invoked.
 */
function buildDb() {
  const real = createMethods(mongoose);
  return {
    upsertTokenCustody: jest.fn(real.upsertTokenCustody),
    findTokenCustody: jest.fn(real.findTokenCustody),
    findTokenCustodyMeta: jest.fn(real.findTokenCustodyMeta),
    updateTokenCustodyIfCurrent: jest.fn(real.updateTokenCustodyIfCurrent),
    deleteTokenCustody: jest.fn(real.deleteTokenCustody),
    deleteTokenCustodiesByUser: jest.fn(real.deleteTokenCustodiesByUser),
  };
}

/** A custody payload with a real refresh token the logout revocation chain will carry. */
function payload(overrides = {}) {
  return {
    accessToken: 'access-token-value',
    idToken: 'id-token-value',
    refreshToken: 'refresh-token-value',
    issuedAt: Date.now(),
    ...overrides,
  };
}

/** A custody identity for the given user, without a tenant unless supplied. */
function identity(userId, overrides = {}) {
  return {
    userId,
    openidIssuer: 'https://idp.example.com',
    openidSubject: `sub-${userId}`,
    ...overrides,
  };
}

/**
 * Seals one live custody record and returns the cookie material a browser would present: the raw
 * token key cookie value and the signed marker cookie carrying `{ id, tokenKeyHash }`.
 */
async function seedRecord({ userId = USER_ID, tenantId, tokens } = {}) {
  const { tokenKey, tokenKeyHash } = await custodyService.createCustody({
    tokens: tokens ?? payload(),
    identity: identity(userId, tenantId ? { tenantId } : {}),
  });
  const marker = jwt.sign({ id: userId, tokenKeyHash }, JWT_REFRESH_SECRET, { expiresIn: '1h' });
  return { tokenKey, tokenKeyHash, marker };
}

/** The cookie header a browser presents on the OpenID-reuse path. */
function openIdCookieHeader({ tokenKey, marker }) {
  return [
    'token_provider=openid',
    `${TOKEN_KEY_COOKIE}=${tokenKey}`,
    `${OPENID_USER_ID_COOKIE}=${marker}`,
  ].join('; ');
}

/** Clears the call history of every store spy between phases of one test. */
function resetStoreSpies() {
  Object.values(db).forEach((spy) => spy.mockClear());
}

beforeAll(async () => {
  process.env.JWT_REFRESH_SECRET = JWT_REFRESH_SECRET;
  process.env.OPENID_REUSE_TOKENS = 'true';
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  if (!mongoose.models.TokenCustody) {
    mongoose.model('TokenCustody', tokenCustodySchema);
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  db = buildDb();
  custodyService = createTokenCustodyService({
    db,
    logger,
    fallbackRefreshTtlMs: FALLBACK_REFRESH_TTL_MS,
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Image authorization at the route level.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('image authorization against the shared custody store', () => {
  const OWNER_PATH = `/images/${USER_ID}/profile.png`;

  /** Mounts the real image-authorization middleware over the shared store on a GET /images route. */
  function buildImageApp() {
    const middleware = createImageAuthorizationMiddleware(
      { secureImageLinks: true },
      {
        parseCookies: cookie.parse,
        isOpenIdReuseEnabled: () => true,
        getBasePath: () => '',
        findSession: jest.fn().mockResolvedValue(null),
        custody: custodyService,
        getTenantId: () => undefined,
        getUserById: jest.fn().mockResolvedValue({ role: 'USER', tenantId: undefined }),
        getAgent: jest.fn().mockResolvedValue(null),
        getAssistant: jest.fn().mockResolvedValue(null),
        getUserPrincipals: jest.fn().mockResolvedValue([]),
        hasCapabilityForPrincipals: jest.fn().mockResolvedValue(false),
        hasPermission: jest.fn().mockResolvedValue(false),
      },
    );
    const app = express();
    app.get('/images/*rest', middleware, (_req, res) => res.status(200).send('image-bytes'));
    return app;
  }

  it('authorizes the owner from a live record with exactly one existence read and never opens the blob', async () => {
    const { tokenKey, tokenKeyHash, marker } = await seedRecord();
    resetStoreSpies();
    const app = buildImageApp();

    const res = await request(app)
      .get(OWNER_PATH)
      .set('Cookie', openIdCookieHeader({ tokenKey, marker }));

    expect(res.status).toBe(200);
    // The binding check is a single projected existence-and-userId read.
    expect(db.findTokenCustodyMeta).toHaveBeenCalledTimes(1);
    expect(db.findTokenCustodyMeta).toHaveBeenCalledWith({ tokenKeyHash, tenantId: undefined });
    // The sealed blob is never opened on this path.
    expect(db.findTokenCustody).not.toHaveBeenCalled();
  });

  it('rejects when the marker tokenKeyHash claim differs from the presented key, before any store read', async () => {
    const { marker } = await seedRecord();
    const otherKey = generateTokenKey();
    resetStoreSpies();
    const app = buildImageApp();

    const res = await request(app)
      .get(OWNER_PATH)
      .set('Cookie', openIdCookieHeader({ tokenKey: otherKey, marker }));

    expect(res.status).toBe(403);
    expect(db.findTokenCustodyMeta).not.toHaveBeenCalled();
    expect(db.findTokenCustody).not.toHaveBeenCalled();
  });

  it('rejects a previous-format marker carrying only refreshTokenHash, before any store read', async () => {
    const { tokenKey } = await seedRecord();
    const legacyMarker = jwt.sign(
      { id: USER_ID, refreshTokenHash: 'a'.repeat(43) },
      JWT_REFRESH_SECRET,
      { expiresIn: '1h' },
    );
    resetStoreSpies();
    const app = buildImageApp();

    const res = await request(app)
      .get(OWNER_PATH)
      .set('Cookie', openIdCookieHeader({ tokenKey, marker: legacyMarker }));

    expect(res.status).toBe(403);
    expect(db.findTokenCustodyMeta).not.toHaveBeenCalled();
    expect(db.findTokenCustody).not.toHaveBeenCalled();
  });

  it('rejects once the record is deleted, having performed the one existence read that found it gone', async () => {
    const { tokenKey, tokenKeyHash, marker } = await seedRecord();
    await custodyService.deleteCustody({ tokenKeyHash });
    resetStoreSpies();
    const app = buildImageApp();

    const res = await request(app)
      .get(OWNER_PATH)
      .set('Cookie', openIdCookieHeader({ tokenKey, marker }));

    expect(res.status).toBe(403);
    expect(db.findTokenCustodyMeta).toHaveBeenCalledTimes(1);
    expect(db.findTokenCustody).not.toHaveBeenCalled();
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Shared-link authorization at the route level.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('shared-link authorization against the shared custody store', () => {
  /**
   * Mounts the real `optionalShareFileAuth` middleware. Its two request-scoped dependencies —
   * the process-wide custody service and the viewer lookup — are pointed at the shared store and a
   * stub user. A terminal handler reports whether the middleware established `req.user`, which is
   * the never-block contract's observable: on a bound viewer it is set, on any failure it is unset
   * so `canAccessSharedLink` decides.
   */
  let getUserByIdMock;
  let findSessionMock;

  beforeEach(() => {
    jest.resetModules();
    getUserByIdMock = jest.fn().mockResolvedValue({ _id: USER_ID, role: 'USER' });
    findSessionMock = jest.fn().mockResolvedValue(null);
    jest.doMock('~/models', () => ({
      getUserById: (...args) => getUserByIdMock(...args),
      findSession: (...args) => findSessionMock(...args),
    }));
    jest.doMock('~/server/services/AuthService', () => ({
      getTokenCustodyService: () => custodyService,
    }));
  });

  afterEach(() => {
    jest.dontMock('~/models');
    jest.dontMock('~/server/services/AuthService');
  });

  function buildShareApp() {
    const optionalShareFileAuth = require('~/server/middleware/optionalShareFileAuth');
    const cookieParser = require('cookie-parser');
    const app = express();
    // `verifyCustodyBinding` reads the parsed `req.cookies`, so the share route runs through
    // cookie-parser exactly as the mounted app does.
    app.use(cookieParser());
    app.get('/share/*rest', optionalShareFileAuth, (req, res) =>
      res.status(200).json({ viewer: req.user ? req.user.id : null }),
    );
    return app;
  }

  it('establishes the viewer from a matching key/marker pair with one existence read, blob never opened', async () => {
    const { tokenKey, tokenKeyHash, marker } = await seedRecord();
    resetStoreSpies();
    const app = buildShareApp();

    const res = await request(app)
      .get('/share/file-1')
      .set('Cookie', openIdCookieHeader({ tokenKey, marker }));

    expect(res.status).toBe(200);
    expect(res.body.viewer).toBe(USER_ID);
    expect(db.findTokenCustodyMeta).toHaveBeenCalledTimes(1);
    expect(db.findTokenCustodyMeta).toHaveBeenCalledWith({ tokenKeyHash, tenantId: undefined });
    expect(db.findTokenCustody).not.toHaveBeenCalled();
  });

  it('leaves req.user unset on a key/marker mismatch so canAccessSharedLink decides, never sending a response', async () => {
    const { marker } = await seedRecord();
    const otherKey = generateTokenKey();
    resetStoreSpies();
    const app = buildShareApp();

    const res = await request(app)
      .get('/share/file-1')
      .set('Cookie', openIdCookieHeader({ tokenKey: otherKey, marker }));

    // The route's own handler ran (the middleware never answered), with no viewer bound.
    expect(res.status).toBe(200);
    expect(res.body.viewer).toBeNull();
    expect(getUserByIdMock).not.toHaveBeenCalled();
    expect(db.findTokenCustodyMeta).not.toHaveBeenCalled();
    expect(db.findTokenCustody).not.toHaveBeenCalled();
  });

  it('leaves req.user unset once the record is deleted, without blocking', async () => {
    const { tokenKey, tokenKeyHash, marker } = await seedRecord();
    await custodyService.deleteCustody({ tokenKeyHash });
    resetStoreSpies();
    const app = buildShareApp();

    const res = await request(app)
      .get('/share/file-1')
      .set('Cookie', openIdCookieHeader({ tokenKey, marker }));

    expect(res.status).toBe(200);
    expect(res.body.viewer).toBeNull();
    expect(db.findTokenCustodyMeta).toHaveBeenCalledTimes(1);
    expect(db.findTokenCustody).not.toHaveBeenCalled();
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Logout at the route level: revoke-before-delete, fail-open on IdP, then 401 on refresh.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('logout against the shared custody store', () => {
  let revokeMock;
  let logoutUserMock;
  let logoutController;

  beforeEach(() => {
    jest.resetModules();
    revokeMock = jest.fn().mockResolvedValue(['refresh-token-value']);
    logoutUserMock = jest.fn().mockResolvedValue({ status: 200, message: 'Logout successful' });

    jest.doMock('~/server/services/AuthService', () => ({
      logoutUser: (...args) => logoutUserMock(...args),
      getTokenCustodyService: () => custodyService,
    }));
    jest.doMock('~/server/services/OpenIDRefreshRecovery', () => ({
      revokeOpenIDRefreshTokenChain: (...args) => revokeMock(...args),
    }));
    jest.doMock('~/strategies', () => ({
      getOpenIdConfig: () => {
        throw new Error('OpenID config not initialized');
      },
    }));
    delete process.env.OPENID_USE_END_SESSION_ENDPOINT;
    ({ logoutController } = require('~/server/controllers/auth/LogoutController'));
  });

  afterEach(() => {
    jest.dontMock('~/server/services/AuthService');
    jest.dontMock('~/server/services/OpenIDRefreshRecovery');
    jest.dontMock('~/strategies');
  });

  /** Builds an app whose /logout handler runs the real controller with a pre-authenticated user. */
  function buildLogoutApp({ tokenKey, marker }, user) {
    const app = express();
    app.post(
      '/logout',
      (req, _res, next) => {
        req.user = user;
        req.cookies = { [TOKEN_KEY_COOKIE]: tokenKey, [OPENID_USER_ID_COOKIE]: marker };
        req.headers.cookie = openIdCookieHeader({ tokenKey, marker });
        req.session = {};
        next();
      },
      logoutController,
    );
    return app;
  }

  const openIdUser = () => ({
    id: USER_ID,
    _id: USER_ID,
    openidId: 'sub-user',
    provider: 'openid',
    openidIssuer: 'https://idp.example.com',
  });

  it('revokes the IdP token opened from the record before deleting every record for the user', async () => {
    const seeded = await seedRecord();
    const app = buildLogoutApp(seeded, openIdUser());

    const res = await request(app).post('/logout');

    expect(res.status).toBe(200);
    // The revocation carried the refresh token the record actually held.
    expect(revokeMock).toHaveBeenCalledTimes(1);
    expect(revokeMock.mock.calls[0][0].refreshTokens).toEqual(['refresh-token-value']);
    // Revoke ran before the sweep that removed the records.
    expect(revokeMock.mock.invocationCallOrder[0]).toBeLessThan(
      db.deleteTokenCustodiesByUser.mock.invocationCallOrder[0],
    );
    // The record is gone: a direct existence check now reads absent.
    await expect(
      custodyService.custodyExists({
        tokenKeyHash: seeded.tokenKeyHash,
        expectedUserId: USER_ID,
      }),
    ).resolves.toBe(false);
    // The token key cookie was cleared alongside the rest.
    const cleared = res.headers['set-cookie'].join('\n');
    expect(cleared).toContain(TOKEN_KEY_COOKIE);
  });

  it('still deletes the record and clears the cookie when the IdP revocation fails', async () => {
    revokeMock.mockRejectedValue(new Error('idp unreachable'));
    const seeded = await seedRecord();
    const app = buildLogoutApp(seeded, openIdUser());

    const res = await request(app).post('/logout');

    expect(res.status).toBe(200);
    expect(db.deleteTokenCustodiesByUser).toHaveBeenCalledTimes(1);
    await expect(
      custodyService.custodyExists({ tokenKeyHash: seeded.tokenKeyHash, expectedUserId: USER_ID }),
    ).resolves.toBe(false);
    expect(res.headers['set-cookie'].join('\n')).toContain(TOKEN_KEY_COOKIE);
  });

  it('fails closed with 500 and no cookie clearing when the record sweep rejects', async () => {
    const seeded = await seedRecord();
    db.deleteTokenCustodiesByUser.mockRejectedValueOnce(new Error('store down'));
    const app = buildLogoutApp(seeded, openIdUser());

    const res = await request(app).post('/logout');

    expect(res.status).toBe(500);
    expect(logoutUserMock).not.toHaveBeenCalled();
    expect(res.headers['set-cookie']).toBeUndefined();
    // The record survives the failed sweep, so the session is still openable by its key.
    await expect(
      custodyService.custodyExists({ tokenKeyHash: seeded.tokenKeyHash, expectedUserId: USER_ID }),
    ).resolves.toBe(true);
  });

  it('leaves the next request unauthenticated: loadOpenIDCustody returns null after logout', async () => {
    const seeded = await seedRecord();
    const app = buildLogoutApp(seeded, openIdUser());
    await request(app).post('/logout');
    resetStoreSpies();

    // A later request presenting the same cookie pair can no longer open a context.
    const laterReq = {
      cookies: { [TOKEN_KEY_COOKIE]: seeded.tokenKey, [OPENID_USER_ID_COOKIE]: seeded.marker },
    };
    const context = await loadOpenIDCustody(laterReq, { custody: custodyService });

    expect(context).toBeNull();
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Ban and account deletion: each leaves no usable record for a later request.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('ban and account deletion leave no usable custody record', () => {
  /** A request-shaped object carrying the given cookie pair, as the binding checks read them. */
  function reqWith({ tokenKey, marker }) {
    return { cookies: { [TOKEN_KEY_COOKIE]: tokenKey, [OPENID_USER_ID_COOKIE]: marker } };
  }

  it("a banned user's later request is unauthenticated after the ban sweeps the records", async () => {
    const seeded = await seedRecord();
    // The ban path effects revocation by deleting every custody record for the user.
    await custodyService.deleteAllForUser({ userId: USER_ID });

    const binding = await verifyCustodyBinding(reqWith(seeded), { custody: custodyService });
    const context = await loadOpenIDCustody(reqWith(seeded), { custody: custodyService });

    expect(binding).toBeNull();
    expect(context).toBeNull();
  });

  it("account deletion leaves the deleted user's record unopenable for a later request", async () => {
    const seeded = await seedRecord();
    await custodyService.deleteAllForUser({ userId: USER_ID });

    const binding = await verifyCustodyBinding(reqWith(seeded), { custody: custodyService });
    expect(binding).toBeNull();
  });

  it("sweeping one user leaves another user's live record authorizing", async () => {
    const banned = await seedRecord({ userId: USER_ID });
    const survivor = await seedRecord({ userId: OTHER_USER_ID });

    await custodyService.deleteAllForUser({ userId: USER_ID });

    const bannedBinding = await verifyCustodyBinding(
      { cookies: { [TOKEN_KEY_COOKIE]: banned.tokenKey, [OPENID_USER_ID_COOKIE]: banned.marker } },
      { custody: custodyService },
    );
    const survivorBinding = await verifyCustodyBinding(
      {
        cookies: {
          [TOKEN_KEY_COOKIE]: survivor.tokenKey,
          [OPENID_USER_ID_COOKIE]: survivor.marker,
        },
      },
      { custody: custodyService },
    );

    expect(bannedBinding).toBeNull();
    expect(survivorBinding).toMatchObject({ userId: OTHER_USER_ID });
  });
});
