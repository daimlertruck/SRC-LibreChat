import crypto from 'node:crypto';
import { createOpenIDRefreshFlightService, type CustodyFlightSeal } from './flight';

jest.mock('../../utils/identity', () => ({
  createOpenIDRefreshIdentityTuple: jest.fn(),
  serializeAuthIdentityTuple: jest.fn(),
}));

/** A well-formed seal: a 32-byte AEAD key, a hash and an identity, so `sealTokens` succeeds. */
function validSeal(): CustodyFlightSeal {
  return {
    aeadKey: crypto.randomBytes(32),
    tokenKeyHash: 'a'.repeat(43),
    identity: { userId: 'user-1' },
  };
}

/** A malformed seal whose key is the wrong length, so `sealTokens` throws before any write. */
function invalidSeal(): CustodyFlightSeal {
  return {
    aeadKey: crypto.randomBytes(16),
    tokenKeyHash: 'a'.repeat(43),
    identity: { userId: 'user-1' },
  };
}

describe('OpenID completion write boundary', () => {
  it.each([true, false])('marks dispatch only after sealing (sealing fails: %s)', async (fails) => {
    const onWriteStart = jest.fn();
    const complete = jest.fn(async () => {
      expect(onWriteStart).toHaveBeenCalledTimes(1);
      return null;
    });
    const service = createOpenIDRefreshFlightService({
      db: {
        acquireOpenIDRefreshFlight: jest.fn(),
        completeOpenIDRefreshFlight: complete,
        renewOpenIDRefreshFlight: jest.fn(),
        failOpenIDRefreshFlight: jest.fn(),
        revokeOpenIDRefreshFlight: jest.fn(),
        findOpenIDRefreshFlight: jest.fn(),
      },
      logger: { warn: jest.fn() },
    });
    const result = service.completeOpenIDRefreshFlight({
      key: 'publication',
      ownerId: 'owner',
      tokens: { access_token: 'access' },
      seal: fails ? invalidSeal() : validSeal(),
      onWriteStart,
    });
    if (fails) {
      await expect(result).rejects.toThrow();
      expect(onWriteStart).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toBeNull();
      expect(complete).toHaveBeenCalledTimes(1);
    }
  });
});

describe('sealed flight round-trip', () => {
  it('seals a completed result and opens it with the same seal', async () => {
    const seal = validSeal();
    let stored: string | undefined;
    const flightDoc = {
      status: 'completed' as const,
      ownerId: 'owner',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      get sealedResult() {
        return stored;
      },
    };
    const service = createOpenIDRefreshFlightService({
      db: {
        acquireOpenIDRefreshFlight: jest.fn(),
        completeOpenIDRefreshFlight: jest.fn(async (data: { sealedResult: string }) => {
          stored = data.sealedResult;
          return flightDoc as never;
        }),
        renewOpenIDRefreshFlight: jest.fn(),
        failOpenIDRefreshFlight: jest.fn(),
        revokeOpenIDRefreshFlight: jest.fn(),
        findOpenIDRefreshFlight: jest.fn(async () => flightDoc as never),
      },
      logger: { warn: jest.fn() },
    });

    const tokens = {
      access_token: 'access',
      refresh_token: 'refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
    await service.completeOpenIDRefreshFlight({
      key: 'k',
      ownerId: 'owner',
      tokens,
      seal,
    });

    // No plaintext token value survives in the stored blob.
    expect(stored).toBeDefined();
    expect(stored).toEqual(expect.stringMatching(/^kc1:/));
    expect(stored).not.toContain('access');
    expect(stored).not.toContain('refresh');

    const opened = await service.__internals.readCompletedFlight(flightDoc as never, seal);
    expect(opened).toMatchObject({ access_token: 'access', refresh_token: 'refresh' });
  });

  it('returns no token set when a waiter opens with a different key', async () => {
    const ownerSeal = validSeal();
    let stored: string | undefined;
    const flightDoc = {
      status: 'completed' as const,
      ownerId: 'owner',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      get sealedResult() {
        return stored;
      },
    };
    const warn = jest.fn();
    const service = createOpenIDRefreshFlightService({
      db: {
        acquireOpenIDRefreshFlight: jest.fn(),
        completeOpenIDRefreshFlight: jest.fn(async (data: { sealedResult: string }) => {
          stored = data.sealedResult;
          return flightDoc as never;
        }),
        renewOpenIDRefreshFlight: jest.fn(),
        failOpenIDRefreshFlight: jest.fn(),
        revokeOpenIDRefreshFlight: jest.fn(),
        findOpenIDRefreshFlight: jest.fn(async () => flightDoc as never),
      },
      logger: { warn },
    });

    await service.completeOpenIDRefreshFlight({
      key: 'k',
      ownerId: 'owner',
      tokens: {
        access_token: 'access',
        refresh_token: 'refresh',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
      seal: ownerSeal,
    });

    // A foreign key cannot open the blob: waitForOpenIDRefreshFlight yields null and leaves the
    // record in place (no throw propagates to the caller).
    const foreignSeal: CustodyFlightSeal = {
      aeadKey: crypto.randomBytes(32),
      tokenKeyHash: ownerSeal.tokenKeyHash,
      identity: ownerSeal.identity,
    };
    const resolved = await service.waitForOpenIDRefreshFlight({
      key: 'k',
      seal: foreignSeal,
      timeoutMs: 50,
    });
    expect(resolved).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
