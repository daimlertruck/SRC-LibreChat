import type { OpenIDCustodyContext } from '~/auth/custody/service';
import type { OpenIDRefreshRecoveryDeps } from './recovery';
import { createOpenIDRefreshRecoveryService } from './recovery';

/**
 * `sendOpenIDAuthResponse` persists the published token set only through custody: `createCustody`
 * via `setOpenIDAuthTokens` on a fresh login, or `rotateCustody` under the same token key when the
 * request already carries a custody context. No `sessions` row and no publication flight.
 */
describe('OpenID custody-native authentication publication', () => {
  function setup() {
    const setOpenIDAuthTokens = jest.fn().mockResolvedValue('app-token');
    const rotateCustody = jest.fn();
    const setTokenKeyCookie = jest.fn();
    const deps = {
      createOpenIDRefreshFlightKey: jest.fn(),
      revokeOpenIDRefreshFlights: jest.fn(),
      getOpenIDAppAuthToken: jest.fn(() => 'app-token'),
      setOpenIDAuthTokens,
      getCustody: () =>
        ({ rotateCustody }) as unknown as ReturnType<OpenIDRefreshRecoveryDeps['getCustody']>,
      setTokenKeyCookie,
    } satisfies OpenIDRefreshRecoveryDeps;
    const service = createOpenIDRefreshRecoveryService(deps);
    const input = {
      tokenset: { access_token: 'access', id_token: 'id', refresh_token: 'refresh' },
      user: { _id: 'user' },
      existingRefreshToken: 'refresh',
      req: {} as never,
      res: {} as never,
    };
    return { deps, service, input, rotateCustody, setTokenKeyCookie, setOpenIDAuthTokens };
  }

  /** A session whose persisted record is gone: the store TTL elapsed, or an eviction removed it. */
  function missingSessionRequest() {
    return {
      session: {
        reload: (callback: (error: Error) => void) => callback(new Error('failed to load session')),
        save: (callback: (error?: Error | null) => void) => callback(null),
      },
    } as never;
  }

  it('establishes the record through setOpenIDAuthTokens on a fresh login', async () => {
    const { deps, service, input } = setup();
    await expect(service.sendOpenIDAuthResponse(input)).resolves.toBe('app-token');
    expect(deps.setOpenIDAuthTokens).toHaveBeenCalledTimes(1);
    expect(deps.setOpenIDAuthTokens).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: 'access', refresh_token: 'refresh' }),
      input.req,
      input.res,
      expect.objectContaining({ userId: 'user', existingRefreshToken: 'refresh' }),
    );
  });

  it('establishes the record only through setOpenIDAuthTokens, without any flight coordination', async () => {
    const { deps, service, input } = setup();
    await service.sendOpenIDAuthResponse(input);
    // A fresh login writes exactly one custody record via setOpenIDAuthTokens and touches no
    // publication flight.
    expect(deps.setOpenIDAuthTokens).toHaveBeenCalledTimes(1);
    expect(deps.revokeOpenIDRefreshFlights).not.toHaveBeenCalled();
  });

  it('publishes into a new record when the persisted session expired', async () => {
    const { deps, service, input } = setup();
    await expect(
      service.sendOpenIDAuthResponse({ ...input, req: missingSessionRequest() }),
    ).resolves.toBe('app-token');
    expect(deps.setOpenIDAuthTokens).toHaveBeenCalledTimes(1);
  });

  it('publishes the IdP token set at login and never reads the retired session token field', async () => {
    const { deps, service, input } = setup();
    /**
     * `req.session.openidTokens` is retired by key custody and no longer a token source. The login
     * publishes the IdP set the caller passed via `setOpenIDAuthTokens` (a fresh custody record),
     * and `discardSessionTokens` is inert. The service must not read or delete the field.
     */
    const req = {
      session: {
        openidTokens: {
          accessToken: 'stale-access',
          idToken: 'stale-id',
          refreshToken: 'stale-refresh',
        },
      },
    } as never;
    await expect(
      service.sendOpenIDAuthResponse({ ...input, req, discardSessionTokens: true }),
    ).resolves.toBe('app-token');
    expect(deps.setOpenIDAuthTokens).toHaveBeenCalledWith(
      expect.objectContaining({ access_token: 'access', refresh_token: 'refresh' }),
      req,
      input.res,
      expect.objectContaining({ existingRefreshToken: 'refresh' }),
    );
  });

  it('rotates through rotateCustody when the request already carries a custody context', async () => {
    const { deps, service, input, rotateCustody, setTokenKeyCookie } = setup();
    const tokenKey = Buffer.from('0123456789abcdef0123456789abcdef');
    const rotatedContext = {
      tokenKey,
      recordExpiresAt: new Date('2030-01-01T00:00:00Z'),
    } as unknown as OpenIDCustodyContext;
    rotateCustody.mockResolvedValue({
      outcome: 'applied',
      context: rotatedContext,
      expiresAt: new Date('2030-01-02T00:00:00Z'),
    });
    const req = {
      openidCustody: { tokenKeyHash: 'hash', rotationCounter: 3 },
      res: undefined,
    } as never;
    const res = { cookie: jest.fn(), headersSent: false } as never;

    await expect(service.sendOpenIDAuthResponse({ ...input, req, res })).resolves.toBe('app-token');

    expect(rotateCustody).toHaveBeenCalledTimes(1);
    expect(rotateCustody).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ tokenKeyHash: 'hash' }),
        tokens: expect.objectContaining({ accessToken: 'access', refreshToken: 'refresh' }),
      }),
    );
    // The unchanged token key value is re-issued with the rotation's expiry.
    expect(setTokenKeyCookie).toHaveBeenCalledWith(
      res,
      tokenKey.toString('base64url'),
      new Date('2030-01-02T00:00:00Z'),
    );
    expect(deps.setOpenIDAuthTokens).not.toHaveBeenCalled();
  });

  it('adopts the concurrent winner when rotateCustody reports outcome: superseded', async () => {
    const { service, input, rotateCustody, setTokenKeyCookie } = setup();
    const tokenKey = Buffer.from('fedcba9876543210fedcba9876543210');
    const winner = {
      tokenKey,
      recordExpiresAt: new Date('2031-06-01T00:00:00Z'),
    } as unknown as OpenIDCustodyContext;
    rotateCustody.mockResolvedValue({
      outcome: 'superseded',
      context: winner,
      expiresAt: new Date('2000-01-01T00:00:00Z'),
    });
    const req = { openidCustody: { tokenKeyHash: 'hash', rotationCounter: 1 } } as never;
    const res = { cookie: jest.fn(), headersSent: false } as never;

    await expect(service.sendOpenIDAuthResponse({ ...input, req, res })).resolves.toBe('app-token');
    // Re-issue uses the winner's record expiry, not the locally computed one.
    expect(setTokenKeyCookie).toHaveBeenCalledWith(
      res,
      tokenKey.toString('base64url'),
      new Date('2031-06-01T00:00:00Z'),
    );
  });

  it('skips the cookie re-issue on the streaming path (headers already sent)', async () => {
    const { service, input, rotateCustody, setTokenKeyCookie } = setup();
    rotateCustody.mockResolvedValue({
      outcome: 'applied',
      context: { tokenKey: Buffer.from('x'.repeat(32)) } as unknown as OpenIDCustodyContext,
      expiresAt: new Date('2030-01-02T00:00:00Z'),
    });
    const req = { openidCustody: { tokenKeyHash: 'hash', rotationCounter: 0 } } as never;
    const res = { cookie: jest.fn(), headersSent: true } as never;

    await expect(service.sendOpenIDAuthResponse({ ...input, req, res })).resolves.toBe('app-token');
    expect(setTokenKeyCookie).not.toHaveBeenCalled();
  });

  it('throws when the published token set carries no refresh token', async () => {
    const { service, input } = setup();
    await expect(
      service.sendOpenIDAuthResponse({
        tokenset: { access_token: 'access', id_token: 'id' },
        user: input.user,
        req: input.req,
        res: input.res,
      }),
    ).rejects.toThrow('no refresh token');
  });

  it('throws when no application authentication token is available', async () => {
    const { deps, service, input } = setup();
    (deps.getOpenIDAppAuthToken as jest.Mock).mockReturnValue(undefined);
    await expect(service.sendOpenIDAuthResponse(input)).rejects.toThrow(
      'no application authentication token',
    );
    expect(deps.setOpenIDAuthTokens).not.toHaveBeenCalled();
  });

  it('throws when setOpenIDAuthTokens publishes an inconsistent token', async () => {
    const { deps, service, input } = setup();
    deps.setOpenIDAuthTokens.mockResolvedValue('a-different-token');
    await expect(service.sendOpenIDAuthResponse(input)).rejects.toThrow('inconsistent token');
  });
});
