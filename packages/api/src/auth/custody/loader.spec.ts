import jwt from 'jsonwebtoken';
import type { OpenIDCustodyContext, TokenCustodyService } from './service';
import type { CustodyTokenPayload, TokenCustodyIdentity } from './aead';
import { generateTokenKey, hashTokenKey, parseTokenKey, TOKEN_KEY_COOKIE } from './key';
import { loadOpenIDCustody, type CustodyRequest } from './loader';
import { OPENID_USER_ID_COOKIE } from '~/oauth/csrf';

/**
 * `openCustody` stands in for the store read, the expensive step, so these tests
 * count its calls: one per request when memoized, zero for every shape that must
 * fail closed, and the result must not depend on `req.session`.
 */

const SECRET = 'loader-refresh-secret';
const USER_ID = '507f1f77bcf86cd799439011';

/** A representative opened token set; its exact values do not matter to the loader. */
const TOKENS: CustodyTokenPayload = {
  accessToken: 'access-token',
  idToken: 'id-token',
  refreshToken: 'refresh-token',
  accessTokenExpiresAt: 2_000_000_000_000,
  refreshTokenExpiresAt: 3_000_000_000_000,
  issuedAt: 1_000_000_000_000,
};

const IDENTITY: TokenCustodyIdentity = {
  userId: USER_ID,
  openidIssuer: 'https://issuer.example.com',
  openidSubject: 'subject-abc',
};

/**
 * A stub custody service whose `openCustody` is a `jest.fn()`, so every test can
 * count store reads by the number of calls. By default it returns a context bound
 * to the key it was handed, echoing back what a successful open produces. All
 * other methods throw: the loader must never reach them.
 */
function makeCustodyStub(
  openImpl: (args: {
    tokenKey: Buffer;
    expectedUserId?: string;
    tenantId?: string;
  }) => Promise<OpenIDCustodyContext | null>,
): TokenCustodyService {
  const unreachable = (name: string) => () => {
    throw new Error(`${name} must not be called by the loader`);
  };
  return {
    openCustody: jest.fn(openImpl),
    createCustody: unreachable('createCustody'),
    custodyExists: unreachable('custodyExists'),
    rotateCustody: unreachable('rotateCustody'),
    reloadAfterInvalidGrant: unreachable('reloadAfterInvalidGrant'),
    deleteCustody: unreachable('deleteCustody'),
    deleteAllForUser: unreachable('deleteAllForUser'),
  } as unknown as TokenCustodyService;
}

/** The default successful open: a context bound to the presented key. */
function contextFor(tokenKey: Buffer): OpenIDCustodyContext {
  return {
    tokens: TOKENS,
    identity: IDENTITY,
    tokenKeyHash: hashTokenKey(tokenKey),
    rotationCounter: 0,
    recordExpiresAt: new Date(3_000_000_000_000),
    tokenKey,
  };
}

/** Signs a valid marker for the given key: `{ id, tokenKeyHash }` under SECRET. */
function signMarker(
  tokenKey: string,
  { id = USER_ID, secret = SECRET }: { id?: string; secret?: string } = {},
): string {
  const parsed = parseTokenKey(tokenKey) as Buffer;
  return jwt.sign({ id, tokenKeyHash: hashTokenKey(parsed) }, secret, { expiresIn: 3600 });
}

/** Builds a request carrying the given cookies (and optionally a session record). */
function makeRequest(
  cookies: Record<string, string>,
  session?: Record<string, unknown>,
): CustodyRequest {
  return { cookies, session } as unknown as CustodyRequest;
}

describe('loadOpenIDCustody', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, JWT_REFRESH_SECRET: SECRET };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('memoization — exactly one store read per request', () => {
    it('reads the store once across repeated loader calls in one request', async () => {
      const tokenKey = generateTokenKey();
      const custody = makeCustodyStub(async ({ tokenKey: key }) => contextFor(key));
      const req = makeRequest({
        [TOKEN_KEY_COOKIE]: tokenKey,
        [OPENID_USER_ID_COOKIE]: signMarker(tokenKey),
      });

      const first = await loadOpenIDCustody(req, { custody });
      const second = await loadOpenIDCustody(req, { custody });
      const third = await loadOpenIDCustody(req, { custody });

      expect(custody.openCustody).toHaveBeenCalledTimes(1);
      expect(first).not.toBeNull();
      expect(second).toBe(first);
      expect(third).toBe(first);
    });

    /**
     * The memoized value distinguishes "loaded and null" from "not yet loaded":
     * a request whose open returned null is not re-read on the next call.
     */
    it('memoizes a null open result without re-reading the store', async () => {
      const tokenKey = generateTokenKey();
      const custody = makeCustodyStub(async () => null);
      const req = makeRequest({
        [TOKEN_KEY_COOKIE]: tokenKey,
        [OPENID_USER_ID_COOKIE]: signMarker(tokenKey),
      });

      const first = await loadOpenIDCustody(req, { custody });
      const second = await loadOpenIDCustody(req, { custody });

      expect(custody.openCustody).toHaveBeenCalledTimes(1);
      expect(first).toBeNull();
      expect(second).toBeNull();
    });

    /** The marker's `id` reaches `openCustody` as `expectedUserId`, and tenant is passed through. */
    it('passes the marker id as expectedUserId and forwards the tenant', async () => {
      const tokenKey = generateTokenKey();
      const custody = makeCustodyStub(async ({ tokenKey: key }) => contextFor(key));
      const req = makeRequest({
        [TOKEN_KEY_COOKIE]: tokenKey,
        [OPENID_USER_ID_COOKIE]: signMarker(tokenKey),
      });

      await loadOpenIDCustody(req, { custody, expectedTenantId: 'tenant-7' });

      expect(custody.openCustody).toHaveBeenCalledWith({
        tokenKey: parseTokenKey(tokenKey),
        expectedUserId: USER_ID,
        expectedTenantId: 'tenant-7',
      });
    });
  });

  describe('fail-closed — zero store reads before any check passes', () => {
    it('returns null with no store read when the key cookie is absent', async () => {
      const tokenKey = generateTokenKey();
      const custody = makeCustodyStub(async ({ tokenKey: key }) => contextFor(key));
      // Marker present, but no token key cookie at all.
      const req = makeRequest({ [OPENID_USER_ID_COOKIE]: signMarker(tokenKey) });

      const result = await loadOpenIDCustody(req, { custody });

      expect(result).toBeNull();
      expect(custody.openCustody).not.toHaveBeenCalled();
    });

    it('returns null with no store read when the key cookie is malformed', async () => {
      const custody = makeCustodyStub(async ({ tokenKey: key }) => contextFor(key));
      // 42 chars — one short of the strict 43-char base64url shape.
      const req = makeRequest({
        [TOKEN_KEY_COOKIE]: 'a'.repeat(42),
        [OPENID_USER_ID_COOKIE]: jwt.sign({ id: USER_ID, tokenKeyHash: 'x'.repeat(43) }, SECRET, {
          expiresIn: 3600,
        }),
      });

      const result = await loadOpenIDCustody(req, { custody });

      expect(result).toBeNull();
      expect(custody.openCustody).not.toHaveBeenCalled();
    });

    it('returns null with no store read when the marker is absent', async () => {
      const tokenKey = generateTokenKey();
      const custody = makeCustodyStub(async ({ tokenKey: key }) => contextFor(key));
      const req = makeRequest({ [TOKEN_KEY_COOKIE]: tokenKey });

      const result = await loadOpenIDCustody(req, { custody });

      expect(result).toBeNull();
      expect(custody.openCustody).not.toHaveBeenCalled();
    });

    it('returns null with no store read when the marker signature is bad', async () => {
      const tokenKey = generateTokenKey();
      const custody = makeCustodyStub(async ({ tokenKey: key }) => contextFor(key));
      const req = makeRequest({
        [TOKEN_KEY_COOKIE]: tokenKey,
        [OPENID_USER_ID_COOKIE]: signMarker(tokenKey, { secret: 'not-the-refresh-secret' }),
      });

      const result = await loadOpenIDCustody(req, { custody });

      expect(result).toBeNull();
      expect(custody.openCustody).not.toHaveBeenCalled();
    });

    it('returns null with no store read when the marker lacks a tokenKeyHash claim', async () => {
      const tokenKey = generateTokenKey();
      const custody = makeCustodyStub(async ({ tokenKey: key }) => contextFor(key));
      const req = makeRequest({
        [TOKEN_KEY_COOKIE]: tokenKey,
        // A previous-format / id-only marker: no tokenKeyHash claim to bind.
        [OPENID_USER_ID_COOKIE]: jwt.sign({ id: USER_ID }, SECRET, { expiresIn: 3600 }),
      });

      const result = await loadOpenIDCustody(req, { custody });

      expect(result).toBeNull();
      expect(custody.openCustody).not.toHaveBeenCalled();
    });

    it('returns null with no store read when the marker claim does not match the presented key', async () => {
      const presentedKey = generateTokenKey();
      const otherKey = generateTokenKey();
      const custody = makeCustodyStub(async ({ tokenKey: key }) => contextFor(key));
      const req = makeRequest({
        [TOKEN_KEY_COOKIE]: presentedKey,
        // Marker bound to a different key's hash.
        [OPENID_USER_ID_COOKIE]: signMarker(otherKey),
      });

      const result = await loadOpenIDCustody(req, { custody });

      expect(result).toBeNull();
      expect(custody.openCustody).not.toHaveBeenCalled();
    });

    /**
     * A legacy marker carrying only `refreshTokenHash` — even one whose value
     * equals the key's hash — carries no `tokenKeyHash` claim, so it fails closed
     * before any read.
     */
    it('returns null with no store read for a legacy refreshTokenHash-only marker', async () => {
      const tokenKey = generateTokenKey();
      const custody = makeCustodyStub(async ({ tokenKey: key }) => contextFor(key));
      const req = makeRequest({
        [TOKEN_KEY_COOKIE]: tokenKey,
        [OPENID_USER_ID_COOKIE]: jwt.sign(
          { id: USER_ID, refreshTokenHash: hashTokenKey(parseTokenKey(tokenKey) as Buffer) },
          SECRET,
          { expiresIn: 3600 },
        ),
      });

      const result = await loadOpenIDCustody(req, { custody });

      expect(result).toBeNull();
      expect(custody.openCustody).not.toHaveBeenCalled();
    });
  });

  describe('independence from the express session', () => {
    /**
     * The loader reads only the two cookies and never consults `req.session`, so
     * the same cookies yield the same context with or without a session record.
     */
    it('returns an identical context whether or not a session record exists', async () => {
      const tokenKey = generateTokenKey();
      const cookies = {
        [TOKEN_KEY_COOKIE]: tokenKey,
        [OPENID_USER_ID_COOKIE]: signMarker(tokenKey),
      };

      // The open result depends only on the presented key, never on the session.
      const custodyWithSession = makeCustodyStub(async ({ tokenKey: key }) => contextFor(key));
      const custodyNoSession = makeCustodyStub(async ({ tokenKey: key }) => contextFor(key));

      const reqWithSession = makeRequest(cookies, {
        openidTokens: { accessToken: 'stale-session-copy' },
        cookie: {},
      });
      const reqNoSession = makeRequest(cookies, undefined);

      const withSession = await loadOpenIDCustody(reqWithSession, { custody: custodyWithSession });
      const noSession = await loadOpenIDCustody(reqNoSession, { custody: custodyNoSession });

      expect(withSession).not.toBeNull();
      expect(noSession).not.toBeNull();
      // The record-derived fields are identical across the two requests.
      expect(noSession?.tokens).toEqual(withSession?.tokens);
      expect(noSession?.identity).toEqual(withSession?.identity);
      expect(noSession?.tokenKeyHash).toBe(withSession?.tokenKeyHash);
      expect(noSession?.rotationCounter).toBe(withSession?.rotationCounter);

      // Both requests performed exactly one store read; neither consulted the session.
      expect(custodyWithSession.openCustody).toHaveBeenCalledTimes(1);
      expect(custodyNoSession.openCustody).toHaveBeenCalledTimes(1);
      // The open call was made with the same arguments regardless of the session.
      expect(custodyNoSession.openCustody).toHaveBeenCalledWith(
        (custodyWithSession.openCustody as jest.Mock).mock.calls[0][0],
      );
    });
  });
});
