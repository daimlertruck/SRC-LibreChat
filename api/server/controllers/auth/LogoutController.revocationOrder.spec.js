/**
 * Logout revokes the IdP refresh token held in the stored custody record before it deletes that
 * record, so the only copy of the token still exists when revocation runs. A revocation that
 * throws, rejects or times out is caught: the record is still deleted and the cookies cleared.
 */
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

function buildRes() {
  const clearedCookies = [];
  const res = {
    clearedCookies,
    statusCode: undefined,
    status: jest.fn(function (code) {
      this.statusCode = code;
      return this;
    }),
    send: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    clearCookie: jest.fn((name) => clearedCookies.push(name)),
  };
  return res;
}

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = {
    ...ORIGINAL_ENV,
    OPENID_USE_END_SESSION_ENDPOINT: 'true',
    OPENID_ISSUER: 'https://idp.example.com',
    OPENID_CLIENT_ID: 'my-client-id',
    DOMAIN_CLIENT: 'https://app.example.com',
  };
  mockIsEnabled.mockReturnValue(true);
  mockGetOpenIdConfig.mockReturnValue({
    serverMetadata: () => ({ end_session_endpoint: 'https://idp.example.com/logout' }),
  });
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

const REFRESH_TOKEN = 'record-refresh-token';
const REVOCATION_FAILURE = new Error('idp failure');

function configureRevocation(outcome) {
  switch (outcome) {
    case 'success':
      mockRevokeOpenIDRefreshTokenChain.mockResolvedValue([REFRESH_TOKEN]);
      break;
    case 'reject':
      mockRevokeOpenIDRefreshTokenChain.mockRejectedValue(REVOCATION_FAILURE);
      break;
    case 'timeout':
      // A timeout surfaces to the controller as a rejected promise.
      mockRevokeOpenIDRefreshTokenChain.mockRejectedValue(new Error('idp timeout'));
      break;
    case 'throw':
      mockRevokeOpenIDRefreshTokenChain.mockImplementation(() => {
        throw REVOCATION_FAILURE;
      });
      break;
    default:
      throw new Error(`unknown outcome ${outcome}`);
  }
}

/** Cookies the controller must always clear on a completed logout. */
const REQUIRED_CLEARED_COOKIES = [
  'refreshToken',
  'openid_access_token',
  'openid_id_token',
  'openid_user_id',
  'token_provider',
];

/**
 * Every revocation outcome, with and without a tenant (passed through to the delete) and an
 * id_token (switches the end-session redirect between the hint and no-hint branches).
 */
const cases = ['success', 'reject', 'throw', 'timeout'].flatMap((outcome) =>
  [undefined, 'tenant-a'].flatMap((tenantId) =>
    [undefined, 'record-id-token'].map((idToken) => ({ outcome, tenantId, idToken })),
  ),
);

describe('logoutController revocation order', () => {
  it.each(cases)(
    'revokes the record token before deleting the record (outcome=$outcome, tenantId=$tenantId, idToken=$idToken)',
    async ({ outcome, tenantId, idToken }) => {
      mockLogoutUser.mockResolvedValue({ status: 200, message: 'Logout successful' });
      mockDeleteAllForUser.mockResolvedValue(undefined);
      mockLoadOpenIDCustody.mockResolvedValue({
        tokens: { refreshToken: REFRESH_TOKEN, idToken, accessToken: 'at' },
        identity: {},
        tokenKeyHash: 'hash-1',
      });
      configureRevocation(outcome);

      const req = {
        user: { _id: 'user-1', openidId: 'openid-sub-1', provider: 'openid', tenantId },
        headers: {},
        cookies: { openid_token_key: 'the-token-key' },
        session: { openidTokens: { refreshToken: 'session-rt' }, destroy: jest.fn() },
      };
      const res = buildRes();

      await logoutController(req, res);

      // The token comes from the record, never from the session or cookies.
      expect(mockRevokeOpenIDRefreshTokenChain).toHaveBeenCalledTimes(1);
      const revokeArgs = mockRevokeOpenIDRefreshTokenChain.mock.calls[0][0];
      expect(revokeArgs.refreshTokens).toEqual([REFRESH_TOKEN]);
      expect(revokeArgs.refreshTokens).not.toContain('session-rt');

      expect(mockDeleteAllForUser).toHaveBeenCalledTimes(1);
      expect(mockDeleteAllForUser).toHaveBeenCalledWith({ userId: 'user-1', tenantId });

      const revokeOrder = mockRevokeOpenIDRefreshTokenChain.mock.invocationCallOrder[0];
      const deleteOrder = mockDeleteAllForUser.mock.invocationCallOrder[0];
      expect(revokeOrder).toBeLessThan(deleteOrder);

      // A failing IdP never turns logout into a 500.
      expect(mockClearTokenKeyCookie).toHaveBeenCalledWith(res);
      for (const cookie of REQUIRED_CLEARED_COOKIES) {
        expect(res.clearedCookies).toContain(cookie);
      }
      expect(res.statusCode).toBe(200);
    },
  );
});
