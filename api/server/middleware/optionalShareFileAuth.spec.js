const mockVerify = jest.fn();
const mockGetUserById = jest.fn();
const mockFindSession = jest.fn();
const mockRunAsSystem = jest.fn((fn) => fn());
const mockVerifyCustodyBinding = jest.fn();
const mockCustodyService = { id: 'custody-service' };
const mockGetTokenCustodyService = jest.fn(() => mockCustodyService);

jest.mock('jsonwebtoken', () => ({ verify: (...args) => mockVerify(...args) }));
jest.mock(
  '@librechat/api',
  () => ({
    isEnabled: (v) => v === 'true' || v === true,
    verifyCustodyBinding: (...args) => mockVerifyCustodyBinding(...args),
  }),
  {
    virtual: true,
  },
);
jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: { warn: jest.fn(), error: jest.fn() },
    runAsSystem: (...args) => mockRunAsSystem(...args),
  }),
  { virtual: true },
);
jest.mock('librechat-data-provider', () => ({ SystemRoles: { USER: 'USER' } }), {
  virtual: true,
});
jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
  findSession: (...args) => mockFindSession(...args),
}));
jest.mock('~/server/services/AuthService', () => ({
  getTokenCustodyService: (...args) => mockGetTokenCustodyService(...args),
}));

const optionalShareFileAuth = require('./optionalShareFileAuth');

const run = async (req) => {
  const next = jest.fn();
  await optionalShareFileAuth(req, {}, next);
  return next;
};

describe('optionalShareFileAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_REFRESH_SECRET = 'test-secret';
    mockVerifyCustodyBinding.mockResolvedValue(null);
    mockGetTokenCustodyService.mockReturnValue(mockCustodyService);
  });

  it('short-circuits when a bearer user is already set (no cookie work)', async () => {
    const req = { user: { id: 'u1' }, headers: { cookie: 'refreshToken=x' } };
    const next = await run(req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockGetUserById).not.toHaveBeenCalled();
    expect(mockFindSession).not.toHaveBeenCalled();
  });

  it('resolves the viewer from a valid refreshToken cookie with a live session', async () => {
    mockVerify.mockReturnValue({ id: 'viewer-1' });
    mockFindSession.mockResolvedValue({ _id: 'session-1' });
    mockGetUserById.mockResolvedValue({ _id: 'viewer-1', role: 'USER' });
    const req = { headers: { cookie: 'refreshToken=good.jwt' } };
    const next = await run(req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockVerify).toHaveBeenCalledWith('good.jwt', 'test-secret');
    expect(mockFindSession).toHaveBeenCalledWith({ userId: 'viewer-1', refreshToken: 'good.jwt' });
    expect(mockRunAsSystem).toHaveBeenCalledTimes(2);
    expect(req.user).toMatchObject({ id: 'viewer-1', role: 'USER' });
  });

  it('defaults the role to USER when the record has none', async () => {
    mockVerify.mockReturnValue({ id: 'viewer-2' });
    mockFindSession.mockResolvedValue({ _id: 'session-2' });
    mockGetUserById.mockResolvedValue({ _id: 'viewer-2' });
    const req = { headers: { cookie: 'refreshToken=good.jwt' } };
    await run(req);
    expect(req.user.role).toBe('USER');
  });

  it('leaves req.user unset when there is no cookie', async () => {
    const req = { headers: {} };
    const next = await run(req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it('leaves req.user unset when the refresh token has no live session', async () => {
    mockVerify.mockReturnValue({ id: 'viewer-3' });
    mockFindSession.mockResolvedValue(null);
    const req = { headers: { cookie: 'refreshToken=revoked.jwt' } };
    const next = await run(req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
    expect(mockFindSession).toHaveBeenCalledWith({
      userId: 'viewer-3',
      refreshToken: 'revoked.jwt',
    });
    expect(mockRunAsSystem).toHaveBeenCalledTimes(1);
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it('leaves req.user unset when the token is invalid', async () => {
    mockVerify.mockImplementation(() => {
      throw new Error('bad token');
    });
    const req = { headers: { cookie: 'refreshToken=bad' } };
    const next = await run(req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  it('resolves the viewer through verifyCustodyBinding on the OpenID-reuse path', async () => {
    process.env.OPENID_REUSE_TOKENS = 'true';
    mockVerifyCustodyBinding.mockResolvedValue({ userId: 'oidc-1', tokenKeyHash: 'hash' });
    mockGetUserById.mockResolvedValue({ _id: 'oidc-1', role: 'USER' });
    const req = {
      headers: {
        cookie: 'token_provider=openid; openid_token_key=key; openid_user_id=signed.jwt',
      },
      cookies: { token_provider: 'openid', openid_token_key: 'key', openid_user_id: 'signed.jwt' },
    };
    await run(req);
    expect(mockVerifyCustodyBinding).toHaveBeenCalledWith(req, { custody: mockCustodyService });
    // The binding check owns the whole OpenID decision: no legacy session read, no JWT verify here.
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockFindSession).not.toHaveBeenCalled();
    expect(req.user).toMatchObject({ id: 'oidc-1' });
    delete process.env.OPENID_REUSE_TOKENS;
  });

  it('leaves req.user unset when the binding check fails and never blocks', async () => {
    process.env.OPENID_REUSE_TOKENS = 'true';
    mockVerifyCustodyBinding.mockResolvedValue(null);
    const req = {
      headers: {
        cookie: 'token_provider=openid; openid_token_key=key; openid_user_id=signed.jwt',
      },
      cookies: { token_provider: 'openid', openid_token_key: 'key', openid_user_id: 'signed.jwt' },
    };
    const next = await run(req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockVerifyCustodyBinding).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
    expect(mockGetUserById).not.toHaveBeenCalled();
    delete process.env.OPENID_REUSE_TOKENS;
  });

  it('skips the binding check when the request is not on the OpenID-reuse path', async () => {
    process.env.OPENID_REUSE_TOKENS = 'true';
    mockVerify.mockReturnValue({ id: 'viewer-4' });
    mockFindSession.mockResolvedValue({ _id: 'session-4' });
    mockGetUserById.mockResolvedValue({ _id: 'viewer-4', role: 'USER' });
    // No token_provider=openid, so the local-auth branch handles it and the binding check is untouched.
    const req = { headers: { cookie: 'refreshToken=good.jwt' } };
    await run(req);
    expect(mockVerifyCustodyBinding).not.toHaveBeenCalled();
    expect(req.user).toMatchObject({ id: 'viewer-4' });
    delete process.env.OPENID_REUSE_TOKENS;
  });

  it('does not run the binding check when OpenID reuse is disabled', async () => {
    delete process.env.OPENID_REUSE_TOKENS;
    mockVerify.mockReturnValue({ id: 'viewer-5' });
    mockFindSession.mockResolvedValue({ _id: 'session-5' });
    mockGetUserById.mockResolvedValue({ _id: 'viewer-5', role: 'USER' });
    const req = {
      headers: { cookie: 'token_provider=openid; refreshToken=good.jwt' },
    };
    await run(req);
    expect(mockVerifyCustodyBinding).not.toHaveBeenCalled();
    // Falls through to the unchanged local-auth branch.
    expect(mockFindSession).toHaveBeenCalledWith({ userId: 'viewer-5', refreshToken: 'good.jwt' });
    expect(req.user).toMatchObject({ id: 'viewer-5' });
  });
});
