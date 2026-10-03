import type { OpenIDCustodyContext, TokenCustodyService } from '~/auth/custody/service';
import type { OpenIDRequest, OpenIDResponse, OpenIDUser } from './types';
import { createOpenIDSessionRefreshService } from './session';

/**
 * Focused coverage of the custody-backed OBO / tool-call path in `session.ts`: it sources tokens
 * only from the custody context, keys the single flight on the token key hash, rotates through
 * `rotateCustody`, re-issues the token key cookie from the rotation's `expiresAt` only when headers
 * allow, matches identity against the record, recovers from `invalid_grant`, and rejects
 * `OPENID_SESSION_MISSING` when the loader returns null, with no IdP call in that case and no
 * plaintext or session store fallback.
 */

const NOW_SECONDS = Math.floor(Date.now() / 1000);

/** A minimally-typed identity-context factory matching the deps the service destructures. */
const createAuthIdentityContext = (args: {
  user?: {
    id?: string | null;
    openidId?: string | null;
    tenantId?: string | null;
    openidIssuer?: string | null;
  } | null;
  requestUser?: { id?: string | null } | null;
  tenantId?: string;
  openidIssuer?: string;
}) => ({
  appUserId: args.user?.id ?? args.requestUser?.id ?? 'user-1',
  openidSubject: args.user?.openidId ?? 'sub-1',
  tenantId: args.tenantId ?? args.user?.tenantId ?? undefined,
  openidIssuer: args.openidIssuer ?? args.user?.openidIssuer ?? 'https://issuer.example.com',
});

const isOpenIDSessionIdentityMatch = (
  session: { appUserId?: string; openidSubject?: string },
  expected: { appUserId?: string; openidSubject?: string },
) =>
  Boolean(session.appUserId) &&
  session.appUserId === expected.appUserId &&
  session.openidSubject === expected.openidSubject;

const identityTuple = { subject: 'sub-1', tenantId: 'no-tenant', openidIssuer: 'iss' };

const makeContext = (overrides: Partial<OpenIDCustodyContext> = {}): OpenIDCustodyContext => ({
  tokens: {
    accessToken: 'access-old',
    idToken: 'id-old',
    refreshToken: 'refresh-old',
    accessTokenExpiresAt: NOW_SECONDS - 60,
    issuedAt: Date.now(),
  },
  identity: {
    userId: 'user-1',
    tenantId: undefined,
    openidIssuer: 'https://issuer.example.com',
    openidSubject: 'sub-1',
  },
  tokenKeyHash: 'hash-abc',
  rotationCounter: 7,
  recordExpiresAt: new Date(Date.now() + 3_600_000),
  tokenKey: Buffer.alloc(32, 1),
  ...overrides,
});

const makeUser = (): OpenIDUser => ({
  id: 'user-1',
  openidId: 'sub-1',
  provider: 'openid',
  openidIssuer: 'https://issuer.example.com',
});

interface Harness {
  service: ReturnType<typeof createOpenIDSessionRefreshService>;
  custody: jest.Mocked<TokenCustodyService>;
  loadOpenIDCustody: jest.Mock;
  setTokenKeyCookie: jest.Mock;
  clearTokenKeyCookie: jest.Mock;
  refreshTokenGrant: jest.Mock;
  revokeRefreshToken: jest.Mock;
}

function buildHarness(context: OpenIDCustodyContext | null): Harness {
  const custody = {
    createCustody: jest.fn(),
    openCustody: jest.fn(),
    custodyExists: jest.fn(),
    rotateCustody: jest.fn(),
    reloadAfterInvalidGrant: jest.fn(),
    deleteCustody: jest.fn().mockResolvedValue(undefined),
    deleteAllForUser: jest.fn(),
  } as unknown as jest.Mocked<TokenCustodyService>;

  const loadOpenIDCustody = jest.fn().mockResolvedValue(context);
  const setTokenKeyCookie = jest.fn();
  const clearTokenKeyCookie = jest.fn();
  const refreshTokenGrant = jest.fn();
  const revokeRefreshToken = jest.fn().mockResolvedValue(undefined);

  const service = createOpenIDSessionRefreshService({
    jwt: { decode: () => null, verify: () => ({}) },
    cookies: { parse: () => ({}) },
    crypto: {
      createHash: () => ({ update: () => ({ digest: () => 'loghash' }) }),
    },
    openIdClient: { refreshTokenGrant },
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    defaultRefreshTokenExpiry: 1000 * 60 * 60 * 24 * 7,
    isEnabled: () => true,
    math: (_value, fallback) => fallback,
    createAuthIdentityContext: createAuthIdentityContext as never,
    isOpenIDSessionIdentityMatch: isOpenIDSessionIdentityMatch as never,
    createOpenIDRefreshIdentityTuple: () => identityTuple as never,
    serializeAuthIdentityTuple: (tuple) =>
      `${(tuple as typeof identityTuple).tenantId}:${(tuple as typeof identityTuple).subject}`,
    buildOpenIDRefreshParams: () => ({ scope: 'openid' }),
    normalizeExpiresIn: (value) =>
      typeof value === 'number' && Number.isFinite(value) ? value : undefined,
    getOpenIdConfig: () => ({}),
    getCustody: () => custody,
    loadOpenIDCustody,
    setTokenKeyCookie,
    clearTokenKeyCookie,
    revokeRefreshToken,
  });

  return {
    service,
    custody,
    loadOpenIDCustody,
    setTokenKeyCookie,
    clearTokenKeyCookie,
    refreshTokenGrant,
    revokeRefreshToken,
  };
}

const makeReq = (): OpenIDRequest => ({ cookies: {}, headers: {} });
const makeRes = (headersSent = false): OpenIDResponse => ({
  headersSent,
  cookie: jest.fn(),
  clearCookie: jest.fn(),
});

describe('session.ts custody refresh', () => {
  describe('token provider sources tokens only from the custody context', () => {
    it('rejects OPENID_SESSION_MISSING without an IdP call when the loader returns null', async () => {
      const h = buildHarness(null);
      const provider = h.service.createOpenIDSessionTokenProvider({
        req: makeReq(),
        user: makeUser(),
        tokenPreference: 'access_token',
      });

      await expect(provider()).rejects.toMatchObject({ code: 'OPENID_SESSION_MISSING' });
      expect(h.refreshTokenGrant).not.toHaveBeenCalled();
      expect(h.custody.rotateCustody).not.toHaveBeenCalled();
    });

    it('reuses a live custody token set without an IdP call and without rotating', async () => {
      const context = makeContext({
        tokens: {
          accessToken: 'access-live',
          idToken: 'id-live',
          refreshToken: 'refresh-live',
          accessTokenExpiresAt: NOW_SECONDS + 600,
          issuedAt: Date.now(),
        },
      });
      const h = buildHarness(context);
      const provider = h.service.createOpenIDSessionTokenProvider({
        req: makeReq(),
        user: makeUser(),
        tokenPreference: 'access_token',
      });

      const result = await provider();

      expect(result).toMatchObject({ access_token: 'access-live' });
      expect(h.refreshTokenGrant).not.toHaveBeenCalled();
      expect(h.custody.rotateCustody).not.toHaveBeenCalled();
    });

    it('performs at most one custody store read across repeated provider calls', async () => {
      const context = makeContext({
        tokens: {
          accessToken: 'access-live',
          refreshToken: 'refresh-live',
          accessTokenExpiresAt: NOW_SECONDS + 600,
          issuedAt: Date.now(),
        },
      });
      const req = makeReq();
      const h = buildHarness(context);
      /**
       * Emulate the real `loadOpenIDCustody`, which memoizes on `req.openidCustody` and reads the
       * store (here, `openCustody`) at most once per request however many times it is called.
       */
      let storeReads = 0;
      h.loadOpenIDCustody.mockImplementation(
        async (r: OpenIDRequest & { openidCustody?: unknown }) => {
          if (r.openidCustody !== undefined) {
            return r.openidCustody as OpenIDCustodyContext | null;
          }
          storeReads += 1;
          r.openidCustody = context;
          return context;
        },
      );
      const provider = h.service.createOpenIDSessionTokenProvider({
        req,
        user: makeUser(),
        tokenPreference: 'access_token',
      });

      await provider();
      await provider();

      expect(storeReads).toBe(1);
      expect(h.custody.rotateCustody).not.toHaveBeenCalled();
    });
  });

  describe('performCustodyRefresh rotates through rotateCustody', () => {
    it('grants once, rotates, and re-issues the token key cookie with the rotation expiresAt', async () => {
      const context = makeContext();
      const h = buildHarness(context);
      h.refreshTokenGrant.mockResolvedValue({
        access_token: 'access-new',
        id_token: 'id-new',
        refresh_token: 'refresh-new',
        expires_in: 3600,
      });
      const rotatedExpiresAt = new Date(Date.now() + 7_200_000);
      const rotatedContext = makeContext({
        tokens: {
          accessToken: 'access-new',
          idToken: 'id-new',
          refreshToken: 'refresh-new',
          accessTokenExpiresAt: NOW_SECONDS + 3600,
          issuedAt: Date.now(),
        },
        rotationCounter: 8,
        recordExpiresAt: rotatedExpiresAt,
      });
      h.custody.rotateCustody.mockResolvedValue({
        outcome: 'applied',
        context: rotatedContext,
        expiresAt: rotatedExpiresAt,
      });

      const res = makeRes(false);
      const result = await h.service.refreshOpenIDSession(
        makeReq(),
        res,
        makeUser(),
        'access_token',
      );

      expect(h.refreshTokenGrant).toHaveBeenCalledTimes(1);
      expect(h.custody.rotateCustody).toHaveBeenCalledTimes(1);
      const rotateArgs = h.custody.rotateCustody.mock.calls[0][0];
      expect(rotateArgs.tokens).toMatchObject({
        accessToken: 'access-new',
        refreshToken: 'refresh-new',
      });
      expect(h.setTokenKeyCookie).toHaveBeenCalledTimes(1);
      const [, cookieValue, cookieExpires] = h.setTokenKeyCookie.mock.calls[0];
      expect(cookieValue).toBe(context.tokenKey.toString('base64url'));
      expect(cookieExpires).toBe(rotatedExpiresAt);
      expect(result).toMatchObject({ access_token: 'access-new' });
    });

    it('skips the token key cookie re-issue when headers were already sent', async () => {
      const context = makeContext();
      const h = buildHarness(context);
      h.refreshTokenGrant.mockResolvedValue({
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        expires_in: 3600,
      });
      const rotatedExpiresAt = new Date(Date.now() + 7_200_000);
      h.custody.rotateCustody.mockResolvedValue({
        outcome: 'applied',
        context: makeContext({ rotationCounter: 8, recordExpiresAt: rotatedExpiresAt }),
        expiresAt: rotatedExpiresAt,
      });

      const res = makeRes(true);
      await h.service.refreshOpenIDSession(makeReq(), res, makeUser(), 'access_token');

      expect(h.custody.rotateCustody).toHaveBeenCalledTimes(1);
      expect(h.setTokenKeyCookie).not.toHaveBeenCalled();
    });

    it('adopts the winner without a second grant when rotateCustody reports applied:false', async () => {
      const context = makeContext();
      const h = buildHarness(context);
      h.refreshTokenGrant.mockResolvedValue({
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        expires_in: 3600,
      });
      const winnerExpiresAt = new Date(Date.now() + 5_400_000);
      const winnerContext = makeContext({
        tokens: {
          accessToken: 'access-winner',
          refreshToken: 'refresh-winner',
          accessTokenExpiresAt: NOW_SECONDS + 3600,
          issuedAt: Date.now(),
        },
        rotationCounter: 9,
        recordExpiresAt: winnerExpiresAt,
      });
      h.custody.rotateCustody.mockResolvedValue({
        outcome: 'superseded',
        context: winnerContext,
        expiresAt: winnerExpiresAt,
      });

      const res = makeRes(false);
      const result = await h.service.refreshOpenIDSession(
        makeReq(),
        res,
        makeUser(),
        'access_token',
      );

      expect(h.refreshTokenGrant).toHaveBeenCalledTimes(1);
      expect(h.custody.rotateCustody).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ access_token: 'access-winner' });
      const [, , cookieExpires] = h.setTokenKeyCookie.mock.calls[0];
      expect(cookieExpires).toBe(winnerExpiresAt);
    });

    it('fails closed and revokes the just-granted token when rotateCustody reports gone', async () => {
      const context = makeContext();
      const h = buildHarness(context);
      h.refreshTokenGrant.mockResolvedValue({
        access_token: 'access-new',
        id_token: 'id-new',
        refresh_token: 'refresh-new',
        expires_in: 3600,
      });
      /** The record was deleted (logout/ban) while the grant was in flight. */
      h.custody.rotateCustody.mockResolvedValue({ outcome: 'gone' });

      const res = makeRes(false);

      await expect(
        h.service.refreshOpenIDSession(makeReq(), res, makeUser(), 'access_token'),
      ).rejects.toMatchObject({ code: 'OPENID_SESSION_MISSING' });

      // One grant, one rotation attempt; no cookie re-issued, no winner adopted.
      expect(h.refreshTokenGrant).toHaveBeenCalledTimes(1);
      expect(h.custody.rotateCustody).toHaveBeenCalledTimes(1);
      expect(h.setTokenKeyCookie).not.toHaveBeenCalled();
      // Exactly one best-effort revocation, carrying the refresh token the IdP just granted.
      expect(h.revokeRefreshToken).toHaveBeenCalledTimes(1);
      expect(h.revokeRefreshToken.mock.calls[0][0]).toMatchObject({ refreshToken: 'refresh-new' });
    });

    it('still fails closed when the orphan-token revocation itself rejects', async () => {
      const context = makeContext();
      const h = buildHarness(context);
      h.refreshTokenGrant.mockResolvedValue({
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        expires_in: 3600,
      });
      h.custody.rotateCustody.mockResolvedValue({ outcome: 'gone' });
      h.revokeRefreshToken.mockRejectedValue(new Error('IdP unreachable'));

      await expect(
        h.service.refreshOpenIDSession(makeReq(), makeRes(false), makeUser(), 'access_token'),
      ).rejects.toMatchObject({ code: 'OPENID_SESSION_MISSING' });
      expect(h.revokeRefreshToken).toHaveBeenCalledTimes(1);
    });

    it('does not revoke the token on a superseded rotation (reuse-detection safety)', async () => {
      const context = makeContext();
      const h = buildHarness(context);
      h.refreshTokenGrant.mockResolvedValue({
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        expires_in: 3600,
      });
      const winnerExpiresAt = new Date(Date.now() + 5_400_000);
      h.custody.rotateCustody.mockResolvedValue({
        outcome: 'superseded',
        context: makeContext({ rotationCounter: 9, recordExpiresAt: winnerExpiresAt }),
        expiresAt: winnerExpiresAt,
      });

      await h.service.refreshOpenIDSession(makeReq(), makeRes(false), makeUser(), 'access_token');

      expect(h.revokeRefreshToken).not.toHaveBeenCalled();
    });
  });

  describe('invalid_grant recovery', () => {
    it('adopts a higher-counter reload without deleting the record', async () => {
      const context = makeContext();
      const h = buildHarness(context);
      h.refreshTokenGrant.mockRejectedValue(
        Object.assign(new Error('bad'), { error: 'invalid_grant' }),
      );
      const reloadedExpiresAt = new Date(Date.now() + 4_000_000);
      h.custody.reloadAfterInvalidGrant.mockResolvedValue(
        makeContext({
          tokens: {
            accessToken: 'access-concurrent',
            refreshToken: 'refresh-concurrent',
            accessTokenExpiresAt: NOW_SECONDS + 3600,
            issuedAt: Date.now(),
          },
          rotationCounter: 8,
          recordExpiresAt: reloadedExpiresAt,
        }),
      );

      const res = makeRes(false);
      const result = await h.service.refreshOpenIDSession(
        makeReq(),
        res,
        makeUser(),
        'access_token',
      );

      expect(result).toMatchObject({ access_token: 'access-concurrent' });
      expect(h.custody.deleteCustody).not.toHaveBeenCalled();
      expect(h.custody.rotateCustody).not.toHaveBeenCalled();
    });

    it('deletes the record and clears the cookies on an unchanged-counter reload', async () => {
      const context = makeContext();
      const h = buildHarness(context);
      h.refreshTokenGrant.mockRejectedValue(
        Object.assign(new Error('bad'), { error: 'invalid_grant' }),
      );
      h.custody.reloadAfterInvalidGrant.mockResolvedValue(makeContext({ rotationCounter: 7 }));

      const res = makeRes(false);
      await expect(
        h.service.refreshOpenIDSession(makeReq(), res, makeUser(), 'access_token'),
      ).rejects.toMatchObject({ code: 'OPENID_SESSION_MISSING' });

      expect(h.custody.deleteCustody).toHaveBeenCalledWith({ tokenKeyHash: context.tokenKeyHash });
      expect(h.clearTokenKeyCookie).toHaveBeenCalledTimes(1);
    });
  });

  describe('identity match against the custody record', () => {
    it('throws and never calls the IdP or mutates the record when the record identity mismatches', async () => {
      const context = makeContext({
        identity: {
          userId: 'user-1',
          openidSubject: 'sub-OTHER',
          openidIssuer: 'https://issuer.example.com',
        },
      });
      const h = buildHarness(context);

      await expect(
        h.service.refreshOpenIDSession(makeReq(), makeRes(), makeUser(), 'access_token'),
      ).rejects.toThrow(/identity mismatch/i);
      expect(h.refreshTokenGrant).not.toHaveBeenCalled();
      expect(h.custody.rotateCustody).not.toHaveBeenCalled();
      expect(h.custody.deleteCustody).not.toHaveBeenCalled();
      expect(h.clearTokenKeyCookie).not.toHaveBeenCalled();
    });
  });

  describe('single-flight keyed on the token key hash', () => {
    it('coalesces concurrent refreshes on one request into a single IdP grant', async () => {
      const context = makeContext();
      const h = buildHarness(context);
      let resolveGrant: (v: unknown) => void = () => {};
      h.refreshTokenGrant.mockReturnValue(
        new Promise((resolve) => {
          resolveGrant = resolve;
        }),
      );
      const rotatedExpiresAt = new Date(Date.now() + 7_200_000);
      h.custody.rotateCustody.mockResolvedValue({
        outcome: 'applied',
        context: makeContext({ rotationCounter: 8, recordExpiresAt: rotatedExpiresAt }),
        expiresAt: rotatedExpiresAt,
      });

      const user = makeUser();
      const req = makeReq();
      const res = makeRes(false);
      const first = h.service.refreshOpenIDSession(req, res, user, 'access_token');
      const second = h.service.refreshOpenIDSession(req, res, user, 'access_token');

      resolveGrant({
        access_token: 'access-new',
        refresh_token: 'refresh-new',
        expires_in: 3600,
      });
      await Promise.all([first, second]);

      expect(h.refreshTokenGrant).toHaveBeenCalledTimes(1);
      expect(h.custody.rotateCustody).toHaveBeenCalledTimes(1);
    });
  });
});
