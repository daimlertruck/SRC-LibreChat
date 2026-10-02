/**
 * OpenID login-path cookies and `/api/auth/refresh` cookie handling, driving the real handler and
 * `setOpenIDAuthTokens` against `mongodb-memory-server` with real crypto. Only the IdP token
 * endpoint is mocked; `getOpenIdConfig` is stubbed so the module graph loads without OIDC discovery.
 */

const express = require('express');
const request = require('supertest');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels, createMethods } = require('@librechat/data-schemas');

/** The IdP token endpoint — the one mocked dependency. */
const mockRefreshTokenGrant = jest.fn();
jest.mock('openid-client', () => ({
  refreshTokenGrant: (...args) => mockRefreshTokenGrant(...args),
}));

/** A local config provider, not the IdP token endpoint. Stubbed so the graph loads; unused on the
 * fresh paths under test here. */
jest.mock('~/strategies/openidStrategy', () => ({
  getOpenIdConfig: jest.fn(() => ({})),
}));

/** Out-of-scope collaborators of AuthService that the login/refresh cookie flow does not exercise. */
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn(async () => ({})) }));
jest.mock('~/server/utils', () => ({ sendEmail: jest.fn() }));
jest.mock('~/strategies/validators', () => ({ registerSchema: { safeParse: jest.fn() } }));

const {
  generateTokenKey,
  parseTokenKey,
  hashTokenKey,
  TOKEN_KEY_COOKIE,
  OPENID_USER_ID_COOKIE,
} = require('@librechat/api');

const ORIGINAL_ENV = { ...process.env };

let mongoServer;
let db;
let User;
let TokenCustody;
let setOpenIDAuthTokens;
let refreshController;

/** Reads the value of a `Set-Cookie` entry by name from a supertest response. */
function readSetCookie(res, name) {
  const raw = res.headers['set-cookie'] || [];
  const entry = raw.find((c) => c.startsWith(`${name}=`));
  if (!entry) {
    return undefined;
  }
  return entry.split(';')[0].slice(name.length + 1);
}

/**
 * Runs the real OpenID login-path cookie writer and returns the mock response's captured cookies.
 * This is the production code that a completed OpenID login invokes; the marker is signed and the
 * custody record is written under real crypto.
 */
async function performOpenIDLogin(userId, tokenset) {
  const cookies = {};
  const res = {
    cookie: jest.fn((name, value, options) => {
      cookies[name] = { value, options };
    }),
    clearCookie: jest.fn((name) => {
      delete cookies[name];
    }),
  };
  const req = { session: {}, user: undefined, cookies: {} };
  const appToken = await setOpenIDAuthTokens(tokenset, req, res, {
    userId,
    openidSubject: 'oidc-sub-1',
    openidIssuer: 'https://issuer.example.com',
  });
  return { cookies, res, appToken };
}

/** Builds a token set whose id_token stays fresh well past the freshness skew buffer. */
function freshTokenset(overrides = {}) {
  const farFuture = Math.floor(Date.now() / 1000) + 3600;
  const idToken = jwt.sign({ sub: 'oidc-sub-1', exp: farFuture }, 'idp-signing-key');
  return {
    access_token: 'access-1',
    id_token: idToken,
    refresh_token: 'refresh-1',
    expires_in: 3600,
    ...overrides,
  };
}

/**
 * Mounts a minimal app exposing the real `/api/auth/refresh` handler. `cookieParser()` matches the
 * production wiring in `api/server/index.js`, populating `req.cookies` that `loadOpenIDCustody` reads.
 */
function createRefreshApp() {
  const app = express();
  app.use(cookieParser());
  app.post('/api/auth/refresh', refreshController);
  return app;
}

/** Composes the Cookie header from a login's captured cookies, with optional extra/override pairs. */
function cookieHeader(loginCookies, extra = {}) {
  const pairs = {};
  for (const [name, entry] of Object.entries(loginCookies)) {
    pairs[name] = entry.value;
  }
  Object.assign(pairs, extra);
  return Object.entries(pairs)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

beforeAll(async () => {
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.OPENID_REUSE_TOKENS = 'true';
  process.env.REFRESH_TOKEN_EXPIRY = '604800000';
  delete process.env.OPENID_SCOPE;
  delete process.env.OPENID_REFRESH_AUDIENCE;

  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  db = createMethods(mongoose);
  await db.initializeRoles();
  await db.seedDefaultRoles();

  User = mongoose.models.User;
  TokenCustody = mongoose.models.TokenCustody;

  ({ setOpenIDAuthTokens } = require('~/server/services/AuthService'));
  ({ refreshController } = require('~/server/controllers/AuthController'));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  process.env = ORIGINAL_ENV;
});

afterEach(async () => {
  await TokenCustody.deleteMany({});
  await User.deleteMany({});
  mockRefreshTokenGrant.mockReset();
});

async function seedUser() {
  const user = await User.create({
    email: `user-${Date.now()}-${Math.random()}@example.com`,
    provider: 'openid',
    openidId: 'oidc-sub-1',
    openidIssuer: 'https://issuer.example.com',
    emailVerified: true,
  });
  return user._id.toString();
}

describe('OpenID login-path cookies', () => {
  it('sets the token key cookie, marker cookie and token_provider=openid and writes exactly one record', async () => {
    const userId = await seedUser();

    const { cookies } = await performOpenIDLogin(userId, freshTokenset());

    /** The three OpenID-path cookies are present. */
    expect(cookies[TOKEN_KEY_COOKIE]).toBeDefined();
    expect(cookies[OPENID_USER_ID_COOKIE]).toBeDefined();
    expect(cookies.token_provider?.value).toBe('openid');

    /** The token key cookie value is a well-formed 43-char base64url key that parses to 32 bytes. */
    const tokenKeyValue = cookies[TOKEN_KEY_COOKIE].value;
    expect(tokenKeyValue).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const parsed = parseTokenKey(tokenKeyValue);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(32);

    /** Exactly one custody record, keyed by the hash of the presented key. */
    const records = await TokenCustody.find({}).lean();
    expect(records).toHaveLength(1);
    expect(records[0].tokenKeyHash).toBe(hashTokenKey(parsed));

    /** The marker binds to the same key hash. */
    const markerClaims = jwt.verify(
      cookies[OPENID_USER_ID_COOKIE].value,
      process.env.JWT_REFRESH_SECRET,
    );
    expect(markerClaims.id).toBe(userId);
    expect(markerClaims.tokenKeyHash).toBe(hashTokenKey(parsed));
  });

  it('sets no refreshToken cookie and no plaintext IdP-token cookies on the OpenID path', async () => {
    const userId = await seedUser();

    const { cookies } = await performOpenIDLogin(userId, freshTokenset());

    expect(cookies.refreshToken).toBeUndefined();
    expect(cookies.openid_access_token).toBeUndefined();
    expect(cookies.openid_id_token).toBeUndefined();
  });

  it('binds the record cookie expiry to the record expiresAt (one derived value)', async () => {
    const userId = await seedUser();

    const { cookies } = await performOpenIDLogin(userId, freshTokenset());

    const parsed = parseTokenKey(cookies[TOKEN_KEY_COOKIE].value);
    const record = await TokenCustody.findOne({ tokenKeyHash: hashTokenKey(parsed) }).lean();
    /** The cookie's `expires` option equals the record's stored `expiresAt`. */
    expect(cookies[TOKEN_KEY_COOKIE].options.expires.getTime()).toBe(
      new Date(record.expiresAt).getTime(),
    );
  });
});

describe('/api/auth/refresh with custody cookies', () => {
  it('succeeds (200) with a valid cookie pair on a fresh record, with no IdP call and no cookie re-issue', async () => {
    const userId = await seedUser();
    const { cookies } = await performOpenIDLogin(userId, freshTokenset());
    const app = createRefreshApp();

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookieHeader(cookies))
      .expect(200);

    expect(res.body).toHaveProperty('token');
    expect(res.body.user).toMatchObject({ _id: userId });
    /** A still-fresh record needs no IdP grant. */
    expect(mockRefreshTokenGrant).not.toHaveBeenCalled();
    /** No cookie re-issue on the fresh path. */
    expect(readSetCookie(res, TOKEN_KEY_COOKIE)).toBeUndefined();
    /** The record survives untouched. */
    expect(await TokenCustody.countDocuments({})).toBe(1);
  });

  it('rejects 401 with an absent token key cookie and leaves the record count unchanged', async () => {
    const userId = await seedUser();
    const { cookies } = await performOpenIDLogin(userId, freshTokenset());
    const before = await TokenCustody.countDocuments({});
    const app = createRefreshApp();

    const res = await request(app)
      .post('/api/auth/refresh')
      /** token_provider + marker present, but no token key cookie. */
      .set(
        'Cookie',
        cookieHeader(
          {},
          {
            token_provider: 'openid',
            [OPENID_USER_ID_COOKIE]: cookies[OPENID_USER_ID_COOKIE].value,
          },
        ),
      )
      .expect(401);

    expect(res.body).toEqual({ code: 'OPENID_SESSION_MISSING' });
    expect(mockRefreshTokenGrant).not.toHaveBeenCalled();
    expect(await TokenCustody.countDocuments({})).toBe(before);
  });

  it('rejects 401 with a malformed token key cookie and leaves the record count unchanged', async () => {
    const userId = await seedUser();
    const { cookies } = await performOpenIDLogin(userId, freshTokenset());
    const before = await TokenCustody.countDocuments({});
    const app = createRefreshApp();

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookieHeader(cookies, { [TOKEN_KEY_COOKIE]: 'not-a-valid-token-key' }))
      .expect(401);

    expect(res.body).toEqual({ code: 'OPENID_SESSION_MISSING' });
    expect(mockRefreshTokenGrant).not.toHaveBeenCalled();
    expect(await TokenCustody.countDocuments({})).toBe(before);
  });

  it('rejects 401 with a foreign token key cookie (marker binds to a different key) and leaves the record count unchanged', async () => {
    const userId = await seedUser();
    const { cookies } = await performOpenIDLogin(userId, freshTokenset());
    const before = await TokenCustody.countDocuments({});
    const app = createRefreshApp();

    /** A syntactically valid but foreign key: it does not match the marker's tokenKeyHash claim. */
    const foreignKey = generateTokenKey();
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookieHeader(cookies, { [TOKEN_KEY_COOKIE]: foreignKey }))
      .expect(401);

    expect(res.body).toEqual({ code: 'OPENID_SESSION_MISSING' });
    expect(mockRefreshTokenGrant).not.toHaveBeenCalled();
    expect(await TokenCustody.countDocuments({})).toBe(before);
  });

  it('answers 401 for a request carrying only a previous-format refreshToken cookie, with no IdP call', async () => {
    const app = createRefreshApp();

    const res = await request(app)
      .post('/api/auth/refresh')
      .set(
        'Cookie',
        `token_provider=openid; refreshToken=${jwt.sign({ id: 'someone' }, process.env.JWT_REFRESH_SECRET)}`,
      )
      .expect(401);

    expect(res.body).toEqual({ code: 'OPENID_SESSION_MISSING' });
    expect(mockRefreshTokenGrant).not.toHaveBeenCalled();
    expect(await TokenCustody.countDocuments({})).toBe(0);
  });

  it('answers 401 for a marker with no tokenKeyHash claim even with a valid token key cookie, with no IdP call', async () => {
    const userId = await seedUser();
    const { cookies } = await performOpenIDLogin(userId, freshTokenset());
    const before = await TokenCustody.countDocuments({});
    const app = createRefreshApp();

    /** A previous-format marker carrying only a refreshTokenHash claim (no tokenKeyHash). */
    const legacyMarker = jwt.sign(
      { id: userId, refreshTokenHash: 'legacy-hash' },
      process.env.JWT_REFRESH_SECRET,
    );

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookieHeader(cookies, { [OPENID_USER_ID_COOKIE]: legacyMarker }))
      .expect(401);

    expect(res.body).toEqual({ code: 'OPENID_SESSION_MISSING' });
    expect(mockRefreshTokenGrant).not.toHaveBeenCalled();
    expect(await TokenCustody.countDocuments({})).toBe(before);
  });

  it('answers 401 when a session record holds openidTokens but the cookie pair cannot bind', async () => {
    /**
     * The previous storage format kept the token set in `req.session.openidTokens`. With no valid
     * token key cookie and marker pair, the presence of that record must not resurrect the session.
     * Supertest cannot populate an express-session mid-flight, so this exercises the controller with
     * a request object that carries a session record and an unbound cookie pair directly.
     */
    const res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    };
    const req = {
      headers: {
        cookie: `token_provider=openid; refreshToken=${jwt.sign({ id: 'x' }, process.env.JWT_REFRESH_SECRET)}`,
      },
      session: { openidTokens: { appUserId: 'someone-else', refreshToken: 'session-refresh' } },
    };

    await refreshController(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith({ code: 'OPENID_SESSION_MISSING' });
    expect(mockRefreshTokenGrant).not.toHaveBeenCalled();
    expect(await TokenCustody.countDocuments({})).toBe(0);
  });

  it('lets a fresh login after a 401 make the next refresh succeed without a second login', async () => {
    const app = createRefreshApp();

    /** First refresh with no custody cookies is rejected. */
    const rejected = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', 'token_provider=openid')
      .expect(401);
    expect(rejected.body).toEqual({ code: 'OPENID_SESSION_MISSING' });

    /** A fresh OpenID login writes a record and mints cookies. */
    const userId = await seedUser();
    const { cookies } = await performOpenIDLogin(userId, freshTokenset());

    /** The next refresh from that browser succeeds — no second login required. */
    const ok = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookieHeader(cookies))
      .expect(200);

    expect(ok.body).toHaveProperty('token');
    expect(ok.body.user).toMatchObject({ _id: userId });
    expect(mockRefreshTokenGrant).not.toHaveBeenCalled();
  });
});
