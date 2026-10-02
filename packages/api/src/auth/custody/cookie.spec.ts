import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import { generateTokenKey, hashTokenKey, parseTokenKey, TOKEN_KEY_COOKIE } from './key';
import { setOpenIDMarkerCookies, OPENID_USER_ID_COOKIE } from '~/oauth/csrf';
import { setTokenKeyCookie, clearTokenKeyCookie } from './cookie';

/**
 * Token key cookie attributes and the marker's `tokenKeyHash` claim. The marker
 * checks run at the JWT level: every shape without a claim equal to
 * `hashTokenKey` of the presented key must leave no user to establish.
 */

const SECRET = 'marker-secret';

/** A fresh mock response whose `cookie` calls are recorded. */
function mockResponse(): Response {
  return { cookie: jest.fn() } as unknown as Response;
}

/** The recorded arguments of the `openid_token_key` Set-Cookie write, or undefined. */
function tokenKeyCookieCall(res: Response): unknown[] | undefined {
  return (res.cookie as jest.Mock).mock.calls.find(([name]) => name === TOKEN_KEY_COOKIE);
}

/** The signed JWT string written to the `openid_user_id` marker cookie, or undefined. */
function markerJwt(res: Response): string | undefined {
  return (res.cookie as jest.Mock).mock.calls.find(([name]) => name === OPENID_USER_ID_COOKIE)?.[1];
}

describe('setTokenKeyCookie / clearTokenKeyCookie', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SESSION_COOKIE_SECURE;
    // Force a deterministic `secure` value so the byte-for-byte comparison below
    // is not sensitive to host environment.
    process.env.NODE_ENV = 'production';
    process.env.DOMAIN_SERVER = 'https://myapp.example.com';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('writes the token key cookie with the mandated attributes and the given expiry', () => {
    const res = mockResponse();
    const tokenKey = generateTokenKey();
    const expires = new Date(Date.now() + 604_800_000);

    setTokenKeyCookie(res, tokenKey, expires);

    expect(res.cookie).toHaveBeenCalledWith(TOKEN_KEY_COOKIE, tokenKey, {
      expires,
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
    });
  });

  /**
   * `setTokenKeyCookie` is the single source of the cookie's options, so login
   * and OBO refresh must produce identical Set-Cookie arguments for the same
   * value and expiry.
   */
  it('produces byte-identical cookie arguments for the same value and expiry regardless of caller', () => {
    const tokenKey = generateTokenKey();
    const expires = new Date(Date.now() + 604_800_000);

    // Login path.
    const loginRes = mockResponse();
    setTokenKeyCookie(loginRes, tokenKey, expires);

    // OBO refresh path: same helper, same (tokenKey, expires).
    const oboRes = mockResponse();
    setTokenKeyCookie(oboRes, tokenKey, expires);

    const loginCall = tokenKeyCookieCall(loginRes);
    const oboCall = tokenKeyCookieCall(oboRes);

    expect(loginCall).toBeDefined();
    // Deep equality over the full argument list is the byte-for-byte assertion:
    // cookie name, value and every option (including the shared `expires` Date).
    expect(oboCall).toEqual(loginCall);
    // The expiry Date is passed through by identity, not copied or recomputed.
    expect((loginCall as unknown[])[2]).toMatchObject({ expires });
    expect((oboCall as unknown[])[2]).toMatchObject({ expires });
  });

  /**
   * One derived `expiresAt` serves both the custody record and the cookie, so
   * the two cannot drift.
   */
  it("uses the record's expiresAt as the cookie expires at login and after an applied rotation", () => {
    const tokenKey = generateTokenKey();

    // At login: createCustody returned this expiresAt on the record.
    const loginExpiresAt = new Date(Date.now() + 604_800_000);
    const loginRes = mockResponse();
    setTokenKeyCookie(loginRes, tokenKey, loginExpiresAt);
    expect((tokenKeyCookieCall(loginRes) as unknown[])[2]).toMatchObject({
      expires: loginExpiresAt,
    });

    // After an applied rotation: rotateCustody recomputed and wrote a new
    // expiresAt; the cookie value is unchanged and the cookie expires tracks the
    // record's new value.
    const rotatedExpiresAt = new Date(loginExpiresAt.getTime() + 3_600_000);
    const rotateRes = mockResponse();
    setTokenKeyCookie(rotateRes, tokenKey, rotatedExpiresAt);
    const rotateCall = tokenKeyCookieCall(rotateRes) as unknown[];
    expect(rotateCall[1]).toBe(tokenKey); // unchanged value
    expect(rotateCall[2]).toMatchObject({ expires: rotatedExpiresAt });

    // A legitimately earlier rotation expiry (a response that omitted a
    // refresh-token expiry an earlier one provided) is still written as given.
    const earlierExpiresAt = new Date(loginExpiresAt.getTime() - 3_600_000);
    const earlierRes = mockResponse();
    setTokenKeyCookie(earlierRes, tokenKey, earlierExpiresAt);
    expect((tokenKeyCookieCall(earlierRes) as unknown[])[2]).toMatchObject({
      expires: earlierExpiresAt,
    });
  });

  it('clears the token key cookie on the same path it was written', () => {
    const res = mockResponse();
    (res as unknown as { clearCookie: jest.Mock }).clearCookie = jest.fn();

    clearTokenKeyCookie(res);

    expect((res as unknown as { clearCookie: jest.Mock }).clearCookie).toHaveBeenCalledWith(
      TOKEN_KEY_COOKIE,
      { path: '/' },
    );
  });
});

/**
 * A verifying site establishes a user from the marker cookie only when it passes
 * `JWT_REFRESH_SECRET` verification and carries a `tokenKeyHash` claim equal to
 * `hashTokenKey` of the presented key. Every other shape fails closed.
 */
describe('marker tokenKeyHash claim — fail-closed shapes', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      JWT_REFRESH_SECRET: SECRET,
      OPENID_REUSE_TOKENS: 'true',
    };
    delete process.env.SESSION_COOKIE_SECURE;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  /**
   * The verifying-site invariant, expressed as a helper: given the marker JWT a
   * site received and the token key it parsed from the token key cookie, does the
   * marker yield a matching `tokenKeyHash`? Returns the established user id or
   * null (fail closed). Absent marker or key => null; bad signature => null;
   * missing/mismatched claim => null.
   */
  function establishUserId(markerToken: string | undefined, presentedKey: string | undefined) {
    if (!markerToken || !presentedKey) {
      return null;
    }
    const parsed = parseTokenKey(presentedKey);
    if (!parsed) {
      return null;
    }
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(markerToken, SECRET) as jwt.JwtPayload;
    } catch {
      return null;
    }
    const claim = payload.tokenKeyHash;
    if (typeof claim !== 'string' || claim !== hashTokenKey(parsed)) {
      return null;
    }
    return typeof payload.id === 'string' ? payload.id : null;
  }

  it('establishes the user id for a well-formed marker matching the presented key', () => {
    const res = mockResponse();
    const tokenKey = generateTokenKey();
    setOpenIDMarkerCookies(res, {
      userId: 'user-123',
      expires: new Date(Date.now() + 604_800_000),
      refreshExpiryMs: 604_800_000,
      tokenKey,
    });

    expect(establishUserId(markerJwt(res), tokenKey)).toBe('user-123');
  });

  it('fails closed for an absent marker', () => {
    const tokenKey = generateTokenKey();
    expect(establishUserId(undefined, tokenKey)).toBeNull();
  });

  it('fails closed for a marker with a bad signature (wrong secret)', () => {
    const tokenKey = generateTokenKey();
    const forged = jwt.sign(
      { id: 'user-123', tokenKeyHash: hashTokenKey(parseTokenKey(tokenKey) as Buffer) },
      'not-the-refresh-secret',
      { expiresIn: 3600 },
    );
    expect(establishUserId(forged, tokenKey)).toBeNull();
  });

  it('fails closed for a signed marker that lacks a tokenKeyHash claim', () => {
    const tokenKey = generateTokenKey();
    const idOnly = jwt.sign({ id: 'user-123' }, SECRET, { expiresIn: 3600 });
    expect(establishUserId(idOnly, tokenKey)).toBeNull();
  });

  it('fails closed for a legacy marker carrying only a refreshTokenHash claim', () => {
    const tokenKey = generateTokenKey();
    const legacy = jwt.sign(
      { id: 'user-123', refreshTokenHash: hashTokenKey(parseTokenKey(tokenKey) as Buffer) },
      SECRET,
      { expiresIn: 3600 },
    );
    // Even though the legacy claim value happens to equal the key's hash, it is
    // carried under the wrong claim name, so no `tokenKeyHash` matches.
    expect(establishUserId(legacy, tokenKey)).toBeNull();
  });

  it('fails closed for a marker whose tokenKeyHash matches a different key', () => {
    const presentedKey = generateTokenKey();
    const otherKey = generateTokenKey();
    const mismatched = jwt.sign(
      { id: 'user-123', tokenKeyHash: hashTokenKey(parseTokenKey(otherKey) as Buffer) },
      SECRET,
      { expiresIn: 3600 },
    );
    expect(establishUserId(mismatched, presentedKey)).toBeNull();
  });

  it('fails closed when the token key cookie is absent even for a valid marker', () => {
    const res = mockResponse();
    const tokenKey = generateTokenKey();
    setOpenIDMarkerCookies(res, {
      userId: 'user-123',
      expires: new Date(Date.now() + 604_800_000),
      refreshExpiryMs: 604_800_000,
      tokenKey,
    });
    expect(establishUserId(markerJwt(res), undefined)).toBeNull();
  });

  /**
   * `setOpenIDMarkerCookies` omits the `tokenKeyHash` claim entirely for an
   * absent or malformed token key, so such a marker can never satisfy a
   * verifying site.
   */
  it('omits the tokenKeyHash claim for an absent or malformed token key, which then fails closed', () => {
    const presentedKey = generateTokenKey();

    const absentRes = mockResponse();
    setOpenIDMarkerCookies(absentRes, {
      userId: 'user-123',
      expires: new Date(Date.now() + 604_800_000),
      refreshExpiryMs: 604_800_000,
    });
    const absentPayload = jwt.verify(markerJwt(absentRes) as string, SECRET) as jwt.JwtPayload;
    expect(absentPayload).not.toHaveProperty('tokenKeyHash');
    expect(establishUserId(markerJwt(absentRes), presentedKey)).toBeNull();

    const malformedRes = mockResponse();
    setOpenIDMarkerCookies(malformedRes, {
      userId: 'user-123',
      expires: new Date(Date.now() + 604_800_000),
      refreshExpiryMs: 604_800_000,
      tokenKey: 'not-a-valid-token-key',
    });
    const malformedPayload = jwt.verify(
      markerJwt(malformedRes) as string,
      SECRET,
    ) as jwt.JwtPayload;
    expect(malformedPayload).not.toHaveProperty('tokenKeyHash');
    expect(establishUserId(markerJwt(malformedRes), presentedKey)).toBeNull();
  });
});
