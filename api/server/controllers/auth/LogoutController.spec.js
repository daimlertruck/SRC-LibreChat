const mockLogoutUser = jest.fn();
const mockLogger = { warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockIsEnabled = jest.fn();
const mockGetOpenIdConfig = jest.fn();
const mockClearCloudFrontCookies = jest.fn();
const mockClearTokenKeyCookie = jest.fn();
const mockLoadOpenIDCustody = jest.fn();
const mockDeleteAllForUser = jest.fn();
const mockRevokeOpenIDRefreshTokenChain = jest.fn();

jest.mock('@librechat/api', () => ({
  isEnabled: (...args) => mockIsEnabled(...args),
  math: (_value, fallback) => fallback,
  clearCloudFrontCookies: (...args) => mockClearCloudFrontCookies(...args),
  clearTokenKeyCookie: (...args) => mockClearTokenKeyCookie(...args),
  loadOpenIDCustody: (...args) => mockLoadOpenIDCustody(...args),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
  DEFAULT_REFRESH_TOKEN_EXPIRY: 7 * 24 * 60 * 60 * 1000,
}));
jest.mock('~/server/services/AuthService', () => ({
  logoutUser: (...args) => mockLogoutUser(...args),
  getTokenCustodyService: () => ({ deleteAllForUser: (...args) => mockDeleteAllForUser(...args) }),
}));
jest.mock('~/server/services/OpenIDRefreshRecovery', () => ({
  revokeOpenIDRefreshTokenChain: (...args) => mockRevokeOpenIDRefreshTokenChain(...args),
}));
jest.mock('~/strategies', () => ({ getOpenIdConfig: () => mockGetOpenIdConfig() }));

const { logoutController } = require('./LogoutController');

function buildReq(overrides = {}) {
  return {
    user: { _id: 'user1', openidId: 'oid1', provider: 'openid' },
    headers: {},
    cookies: { openid_token_key: 'the-token-key' },
    session: { destroy: jest.fn() },
    ...overrides,
  };
}

/** Builds an opened custody record context, the single source of the tokens the controller uses. */
function buildCustody(overrides = {}) {
  return {
    tokens: { refreshToken: 'srt', idToken: 'small-id-token', accessToken: 'at' },
    identity: {},
    tokenKeyHash: 'hash-1',
    ...overrides,
  };
}

function buildRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    clearCookie: jest.fn(),
  };
  return res;
}

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = {
    ...ORIGINAL_ENV,
    OPENID_USE_END_SESSION_ENDPOINT: 'true',
    OPENID_ISSUER: 'https://idp.example.com',
    OPENID_CLIENT_ID: 'my-client-id',
    DOMAIN_CLIENT: 'https://app.example.com',
  };
  mockLogoutUser.mockResolvedValue({ status: 200, message: 'Logout successful' });
  mockLoadOpenIDCustody.mockResolvedValue(buildCustody());
  mockDeleteAllForUser.mockResolvedValue(undefined);
  mockRevokeOpenIDRefreshTokenChain.mockResolvedValue(['srt']);
  mockIsEnabled.mockReturnValue(true);
  mockGetOpenIdConfig.mockReturnValue({
    serverMetadata: () => ({
      end_session_endpoint: 'https://idp.example.com/logout',
    }),
  });
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('LogoutController', () => {
  describe('id_token_hint from session', () => {
    it('sets id_token_hint when session has idToken', async () => {
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      expect(body.redirect).toContain('id_token_hint=small-id-token');
      expect(body.redirect).not.toContain('client_id=');
    });
  });

  describe('id_token_hint sourced from the custody record', () => {
    it('uses the id_token from the opened custody record', async () => {
      mockLoadOpenIDCustody.mockResolvedValue(
        buildCustody({
          tokens: { refreshToken: 'srt', idToken: 'record-id-token', accessToken: 'at' },
        }),
      );
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      expect(body.redirect).toContain('id_token_hint=record-id-token');
    });
  });

  describe('client_id fallback', () => {
    it('falls back to client_id when no custody record is opened', async () => {
      mockLoadOpenIDCustody.mockResolvedValue(null);
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      expect(body.redirect).toContain('client_id=my-client-id');
      expect(body.redirect).not.toContain('id_token_hint=');
    });

    it('does not produce client_id=undefined when OPENID_CLIENT_ID is unset', async () => {
      delete process.env.OPENID_CLIENT_ID;
      mockLoadOpenIDCustody.mockResolvedValue(null);
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      expect(body.redirect).not.toContain('client_id=');
      expect(body.redirect).not.toContain('undefined');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Neither id_token_hint nor OPENID_CLIENT_ID'),
      );
    });
  });

  describe('OPENID_USE_END_SESSION_ENDPOINT disabled', () => {
    it('does not include redirect when disabled', async () => {
      mockIsEnabled.mockReturnValue(false);
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      expect(body.redirect).toBeUndefined();
    });
  });

  describe('OPENID_ISSUER unset', () => {
    it('does not include redirect when OPENID_ISSUER is missing', async () => {
      delete process.env.OPENID_ISSUER;
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      expect(body.redirect).toBeUndefined();
    });
  });

  describe('non-OpenID user', () => {
    it('does not include redirect for non-OpenID users', async () => {
      const req = buildReq({
        user: { _id: 'user1', provider: 'local' },
      });
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      expect(body.redirect).toBeUndefined();
    });
  });

  describe('post_logout_redirect_uri', () => {
    it('uses OPENID_POST_LOGOUT_REDIRECT_URI when set', async () => {
      process.env.OPENID_POST_LOGOUT_REDIRECT_URI = 'https://custom.example.com/logged-out';
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      const url = new URL(body.redirect);
      expect(url.searchParams.get('post_logout_redirect_uri')).toBe(
        'https://custom.example.com/logged-out',
      );
    });

    it('defaults to DOMAIN_CLIENT/login when OPENID_POST_LOGOUT_REDIRECT_URI is unset', async () => {
      delete process.env.OPENID_POST_LOGOUT_REDIRECT_URI;
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      const url = new URL(body.redirect);
      expect(url.searchParams.get('post_logout_redirect_uri')).toBe(
        'https://app.example.com/login',
      );
    });
  });

  describe('OpenID config not available', () => {
    it('warns and returns no redirect when getOpenIdConfig throws', async () => {
      mockGetOpenIdConfig.mockImplementation(() => {
        throw new Error('OpenID configuration has not been initialized');
      });
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      expect(body.redirect).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('OpenID config not available'),
        'OpenID configuration has not been initialized',
      );
    });
  });

  describe('end_session_endpoint not in metadata', () => {
    it('warns and returns no redirect when end_session_endpoint is missing', async () => {
      mockGetOpenIdConfig.mockReturnValue({
        serverMetadata: () => ({}),
      });
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      expect(body.redirect).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('end_session_endpoint not found'),
      );
    });
  });

  describe('error handling', () => {
    it('returns 500 on logoutUser error', async () => {
      mockLogoutUser.mockRejectedValue(new Error('session error'));
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ message: 'session error' });
    });
  });

  describe('custody revocation (revoke before delete)', () => {
    it('revokes the IdP token from the opened record, then deletes every record for the user', async () => {
      const req = buildReq({
        user: {
          _id: 'user1',
          openidId: 'oid1',
          provider: 'openid',
          tenantId: 'tenantA',
        },
      });
      const res = buildRes();

      await logoutController(req, res);

      expect(mockLoadOpenIDCustody).toHaveBeenCalledWith(
        req,
        expect.objectContaining({ expectedTenantId: 'tenantA' }),
      );
      expect(mockDeleteAllForUser).toHaveBeenCalledWith({
        userId: 'user1',
        tenantId: 'tenantA',
      });
      expect(mockRevokeOpenIDRefreshTokenChain).toHaveBeenCalledWith({
        req,
        user: req.user,
        identityContext: {
          appUserId: 'user1',
          openidSubject: 'oid1',
          tenantId: 'tenantA',
          openidIssuer: undefined,
        },
        refreshTokens: ['srt'],
        ttl: 7 * 24 * 60 * 60 * 1000,
      });
      /** Open, revoke, THEN delete: deleting first would discard the only copy of the token to revoke. */
      expect(mockRevokeOpenIDRefreshTokenChain.mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteAllForUser.mock.invocationCallOrder[0],
      );
      expect(mockLogoutUser).toHaveBeenCalledWith(req, 'srt');
    });

    it('sources the revoked token only from the record, not from cookies or the session', async () => {
      mockLoadOpenIDCustody.mockResolvedValue(
        buildCustody({ tokens: { refreshToken: 'record-only-rt', accessToken: 'at' } }),
      );
      const req = buildReq({
        headers: { cookie: 'refreshToken=cookie-rt' },
        session: { openidTokens: { refreshToken: 'session-rt' }, destroy: jest.fn() },
      });
      const res = buildRes();

      await logoutController(req, res);

      const { refreshTokens } = mockRevokeOpenIDRefreshTokenChain.mock.calls[0][0];
      expect(refreshTokens).toEqual(['record-only-rt']);
      expect(refreshTokens).not.toContain('cookie-rt');
      expect(refreshTokens).not.toContain('session-rt');
    });

    it('skips the IdP chain when no custody record is opened', async () => {
      mockLoadOpenIDCustody.mockResolvedValue(null);
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      expect(mockRevokeOpenIDRefreshTokenChain).not.toHaveBeenCalled();
      expect(mockDeleteAllForUser).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('still deletes and clears cookies when the IdP revocation fails', async () => {
      mockRevokeOpenIDRefreshTokenChain.mockRejectedValue(new Error('idp unreachable'));
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      expect(mockDeleteAllForUser).toHaveBeenCalled();
      expect(mockClearTokenKeyCookie).toHaveBeenCalledWith(res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('IdP revocation failed at logout'),
        'idp unreachable',
      );
    });

    it('fails closed before logout when deleteAllForUser rejects', async () => {
      mockDeleteAllForUser.mockRejectedValue(new Error('custody delete failed'));
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      expect(mockLogoutUser).not.toHaveBeenCalled();
      expect(mockClearTokenKeyCookie).not.toHaveBeenCalled();
      expect(res.clearCookie).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('cookie clearing', () => {
    it('clears all auth cookies on successful logout', async () => {
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      expect(res.clearCookie).toHaveBeenCalledWith('refreshToken');
      expect(res.clearCookie).toHaveBeenCalledWith('openid_access_token');
      expect(res.clearCookie).toHaveBeenCalledWith('openid_id_token');
      expect(res.clearCookie).toHaveBeenCalledWith('openid_user_id');
      expect(res.clearCookie).toHaveBeenCalledWith('token_provider');
      expect(mockClearTokenKeyCookie).toHaveBeenCalledWith(res);
    });

    it('calls clearCloudFrontCookies on successful logout', async () => {
      const req = buildReq({ user: { _id: 'user1', tenantId: 'tenantA' } });
      const res = buildRes();

      await logoutController(req, res);

      expect(mockClearCloudFrontCookies).toHaveBeenCalledWith(res, {
        userId: 'user1',
        tenantId: 'tenantA',
      });
    });
  });

  describe('URL length limit and logout_hint fallback', () => {
    /** The id_token travels in the sealed custody record, so tests set it there. */
    const withRecordIdToken = (idToken) =>
      mockLoadOpenIDCustody.mockResolvedValue(
        buildCustody({ tokens: { refreshToken: 'srt', idToken, accessToken: 'at' } }),
      );

    it('uses logout_hint when id_token makes URL exceed default limit (2000 chars)', async () => {
      withRecordIdToken('a'.repeat(3000));
      const req = buildReq({
        user: { _id: 'user1', openidId: 'oid1', provider: 'openid', email: 'user@example.com' },
      });
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      expect(body.redirect).not.toContain('id_token_hint=');
      expect(body.redirect).toContain('logout_hint=user%40example.com');
      expect(body.redirect).toContain('client_id=my-client-id');
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('Logout URL too long'));
    });

    it('uses id_token_hint when URL is within default limit', async () => {
      withRecordIdToken('short-token');
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      expect(body.redirect).toContain('id_token_hint=short-token');
      expect(body.redirect).not.toContain('logout_hint=');
      expect(body.redirect).not.toContain('client_id=');
    });

    it('respects custom OPENID_MAX_LOGOUT_URL_LENGTH', async () => {
      process.env.OPENID_MAX_LOGOUT_URL_LENGTH = '500';
      withRecordIdToken('a'.repeat(600));
      const req = buildReq({
        user: { _id: 'user1', openidId: 'oid1', provider: 'openid', email: 'user@example.com' },
      });
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      expect(body.redirect).not.toContain('id_token_hint=');
      expect(body.redirect).toContain('logout_hint=user%40example.com');
    });

    it('uses username as logout_hint when email is not available', async () => {
      withRecordIdToken('a'.repeat(3000));
      const req = buildReq({
        user: {
          _id: 'user1',
          openidId: 'oid1',
          provider: 'openid',
          username: 'testuser',
        },
      });
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      expect(body.redirect).toContain('logout_hint=testuser');
    });

    it('uses openidId as logout_hint when email and username are not available', async () => {
      withRecordIdToken('a'.repeat(3000));
      const req = buildReq({
        user: { _id: 'user1', openidId: 'unique-oid-123', provider: 'openid' },
      });
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      expect(body.redirect).toContain('logout_hint=unique-oid-123');
    });

    it('uses openidId as logout_hint when email and username are explicitly null', async () => {
      withRecordIdToken('a'.repeat(3000));
      const req = buildReq({
        user: {
          _id: 'user1',
          openidId: 'oid-without-email',
          provider: 'openid',
          email: null,
          username: null,
        },
      });
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      expect(body.redirect).not.toContain('id_token_hint=');
      expect(body.redirect).toContain('logout_hint=oid-without-email');
      expect(body.redirect).toContain('client_id=my-client-id');
    });

    it('uses only client_id when absolutely no hint is available', async () => {
      withRecordIdToken('a'.repeat(3000));
      const req = buildReq({
        user: {
          _id: 'user1',
          openidId: '',
          provider: 'openid',
          email: '',
          username: '',
        },
      });
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      expect(body.redirect).not.toContain('id_token_hint=');
      expect(body.redirect).not.toContain('logout_hint=');
      expect(body.redirect).toContain('client_id=my-client-id');
    });

    it('warns about missing OPENID_CLIENT_ID when URL is too long', async () => {
      delete process.env.OPENID_CLIENT_ID;
      withRecordIdToken('a'.repeat(3000));
      const req = buildReq({
        user: { _id: 'user1', openidId: 'oid1', provider: 'openid', email: 'user@example.com' },
      });
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      expect(body.redirect).not.toContain('id_token_hint=');
      expect(body.redirect).toContain('logout_hint=');
      expect(body.redirect).not.toContain('client_id=');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('OPENID_CLIENT_ID is not set'),
      );
    });

    it('keeps id_token_hint when projected URL length equals the max', async () => {
      const baseUrl = new URL('https://idp.example.com/logout');
      baseUrl.searchParams.set('post_logout_redirect_uri', 'https://app.example.com/login');
      const baseLength = baseUrl.toString().length;
      const tokenLength = 2000 - baseLength - '&id_token_hint='.length;
      withRecordIdToken('a'.repeat(tokenLength));

      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      expect(body.redirect).toContain('id_token_hint=');
      expect(body.redirect).not.toContain('logout_hint=');
    });

    it('falls back to logout_hint when projected URL is one char over the max', async () => {
      const baseUrl = new URL('https://idp.example.com/logout');
      baseUrl.searchParams.set('post_logout_redirect_uri', 'https://app.example.com/login');
      const baseLength = baseUrl.toString().length;
      const tokenLength = 2000 - baseLength - '&id_token_hint='.length + 1;
      withRecordIdToken('a'.repeat(tokenLength));

      const req = buildReq({
        user: { _id: 'user1', openidId: 'oid1', provider: 'openid', email: 'user@example.com' },
      });
      const res = buildRes();

      await logoutController(req, res);

      const body = res.send.mock.calls[0][0];
      expect(body.redirect).not.toContain('id_token_hint=');
      expect(body.redirect).toContain('logout_hint=');
    });
  });

  describe('invalid OPENID_MAX_LOGOUT_URL_LENGTH values', () => {
    it('silently uses default when value is empty', async () => {
      process.env.OPENID_MAX_LOGOUT_URL_LENGTH = '';
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('Invalid OPENID_MAX_LOGOUT_URL_LENGTH'),
      );
      const body = res.send.mock.calls[0][0];
      expect(body.redirect).toContain('id_token_hint=small-id-token');
    });

    it('warns and uses default for partial numeric string', async () => {
      process.env.OPENID_MAX_LOGOUT_URL_LENGTH = '500abc';
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid OPENID_MAX_LOGOUT_URL_LENGTH'),
      );
      const body = res.send.mock.calls[0][0];
      expect(body.redirect).toContain('id_token_hint=small-id-token');
    });

    it('warns and uses default for zero value', async () => {
      process.env.OPENID_MAX_LOGOUT_URL_LENGTH = '0';
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid OPENID_MAX_LOGOUT_URL_LENGTH'),
      );
      const body = res.send.mock.calls[0][0];
      expect(body.redirect).toContain('id_token_hint=small-id-token');
    });

    it('warns and uses default for negative value', async () => {
      process.env.OPENID_MAX_LOGOUT_URL_LENGTH = '-1';
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid OPENID_MAX_LOGOUT_URL_LENGTH'),
      );
      const body = res.send.mock.calls[0][0];
      expect(body.redirect).toContain('id_token_hint=small-id-token');
    });

    it('warns and uses default for non-numeric string', async () => {
      process.env.OPENID_MAX_LOGOUT_URL_LENGTH = 'abc';
      const req = buildReq();
      const res = buildRes();

      await logoutController(req, res);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Invalid OPENID_MAX_LOGOUT_URL_LENGTH'),
      );
      const body = res.send.mock.calls[0][0];
      expect(body.redirect).toContain('id_token_hint=small-id-token');
    });
  });
});
