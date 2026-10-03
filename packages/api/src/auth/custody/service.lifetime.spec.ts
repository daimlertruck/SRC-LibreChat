import type {
  ITokenCustodyView,
  TokenCustodyUpsert,
  TokenCustodyRotation,
} from '@librechat/data-schemas';
import type { CustodyTokenPayload, TokenCustodyIdentity } from './aead';
import type { OpenIDLogger } from '~/auth/openid/types';
import { createTokenCustodyService, resolveRecordExpiry, type TokenCustodyDeps } from './service';
import { parseTokenKey } from './key';

/**
 * The custody record lifetime from `resolveRecordExpiry`: the refresh expiry (or
 * `receivedAt + fallbackRefreshTtlMs` when absent), raised only by the access expiry. The stored
 * `expiresAt` is never an input, so a stingier rotation can legitimately move the lifetime earlier.
 */

/** A fixed receipt time so every expiry the table asserts is deterministic. */
const RECEIVED_AT = 1_700_000_000_000;

/** A distinctive fallback so the fallback term is visibly `RECEIVED_AT + FALLBACK` when it applies. */
const FALLBACK_REFRESH_TTL_MS = 7_200_000;

/** The receipt time in unix seconds, the unit the IdP-supplied expiries share. */
const RECEIVED_AT_SECONDS = Math.floor(RECEIVED_AT / 1000);

/**
 * The IdP-supplied expiries are UNIX SECONDS — the unit the real callers store — so these constants
 * are seconds, and `resolveRecordExpiry` multiplies them by 1000 to place them on the millisecond
 * `Date`. The `_MS` mirrors below are the derived millisecond values the rule is expected to return.
 */

/** A refresh expiry comfortably after the receipt time (seconds). */
const REFRESH_EXPIRY = RECEIVED_AT_SECONDS + 50_000;
const REFRESH_EXPIRY_MS = REFRESH_EXPIRY * 1000;

/** An access expiry earlier than the refresh expiry — so `max` keeps the refresh term (seconds). */
const ACCESS_EXPIRY_LOW = RECEIVED_AT_SECONDS + 10_000;
const ACCESS_EXPIRY_LOW_MS = ACCESS_EXPIRY_LOW * 1000;

/**
 * An access expiry later than both the refresh expiry and the fallback term — so `max` picks it
 * (seconds).
 */
const ACCESS_EXPIRY_HIGH = RECEIVED_AT_SECONDS + 100_000;
const ACCESS_EXPIRY_HIGH_MS = ACCESS_EXPIRY_HIGH * 1000;

/** A minimal custody payload; the token strings are non-empty as `sealTokens` requires. */
function makePayload(overrides: Partial<CustodyTokenPayload> = {}): CustodyTokenPayload {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    issuedAt: RECEIVED_AT,
    ...overrides,
  };
}

describe('resolveRecordExpiry', () => {
  /**
   * The four response shapes. `expected` is a function of `fallbackRefreshTtlMs` only for the shapes
   * whose base is the fallback term; the two shapes that carry a refresh expiry ignore the fallback
   * entirely, which the "unchanged by fallback" test below pins down directly.
   */
  const cases: Array<{
    name: string;
    accessTokenExpiresAt?: number;
    refreshTokenExpiresAt?: number;
    expected: (fallbackMs: number) => number;
  }> = [
    {
      name: 'both expiries present — max(refresh, access)',
      refreshTokenExpiresAt: REFRESH_EXPIRY,
      accessTokenExpiresAt: ACCESS_EXPIRY_HIGH,
      // access is later here, so the max lifts the base to the access expiry (both converted to ms).
      expected: () => Math.max(REFRESH_EXPIRY_MS, ACCESS_EXPIRY_HIGH_MS),
    },
    {
      name: 'both expiries present — access below refresh leaves the refresh term',
      refreshTokenExpiresAt: REFRESH_EXPIRY,
      accessTokenExpiresAt: ACCESS_EXPIRY_LOW,
      expected: () => Math.max(REFRESH_EXPIRY_MS, ACCESS_EXPIRY_LOW_MS),
    },
    {
      name: 'refresh expiry only — base is the refresh expiry, access term omitted',
      refreshTokenExpiresAt: REFRESH_EXPIRY,
      accessTokenExpiresAt: undefined,
      expected: () => REFRESH_EXPIRY_MS,
    },
    {
      name: 'access expiry only — base is the fallback term, raised to the access expiry',
      refreshTokenExpiresAt: undefined,
      accessTokenExpiresAt: ACCESS_EXPIRY_HIGH,
      // The fallback term is already ms; the access expiry is seconds converted to ms.
      expected: (fallbackMs) => Math.max(RECEIVED_AT + fallbackMs, ACCESS_EXPIRY_HIGH_MS),
    },
    {
      name: 'neither expiry present — base is the fallback term alone',
      refreshTokenExpiresAt: undefined,
      accessTokenExpiresAt: undefined,
      expected: (fallbackMs) => RECEIVED_AT + fallbackMs,
    },
  ];

  it.each(cases)('$name', ({ accessTokenExpiresAt, refreshTokenExpiresAt, expected }) => {
    const tokens = makePayload({ accessTokenExpiresAt, refreshTokenExpiresAt });
    const result = resolveRecordExpiry(tokens, RECEIVED_AT, FALLBACK_REFRESH_TTL_MS);
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBe(expected(FALLBACK_REFRESH_TTL_MS));
  });

  it('never lets the access-token expiry lower the base — the access term only raises', () => {
    // Refresh expiry is later than the access expiry: the result is the refresh expiry, unmoved.
    const tokens = makePayload({
      refreshTokenExpiresAt: REFRESH_EXPIRY,
      accessTokenExpiresAt: ACCESS_EXPIRY_LOW,
    });
    const result = resolveRecordExpiry(tokens, RECEIVED_AT, FALLBACK_REFRESH_TTL_MS);
    expect(result.getTime()).toBe(REFRESH_EXPIRY_MS);
    expect(result.getTime()).toBeGreaterThan(ACCESS_EXPIRY_LOW_MS);
  });

  it('omits the access term rather than defaulting it when the response carries no access expiry', () => {
    // With no access expiry, the fallback-only shape must equal exactly the fallback term.
    // If the code defaulted the access expiry to 0 (or receivedAt), a min/max bug would surface as
    // a different value here.
    const tokens = makePayload({
      refreshTokenExpiresAt: undefined,
      accessTokenExpiresAt: undefined,
    });
    const result = resolveRecordExpiry(tokens, RECEIVED_AT, FALLBACK_REFRESH_TTL_MS);
    expect(result.getTime()).toBe(RECEIVED_AT + FALLBACK_REFRESH_TTL_MS);

    // And with a refresh expiry but no access expiry, the result is exactly the refresh expiry —
    // not raised by a defaulted access term.
    const refreshOnly = makePayload({
      refreshTokenExpiresAt: REFRESH_EXPIRY,
      accessTokenExpiresAt: undefined,
    });
    expect(resolveRecordExpiry(refreshOnly, RECEIVED_AT, FALLBACK_REFRESH_TTL_MS).getTime()).toBe(
      REFRESH_EXPIRY_MS,
    );
  });

  describe('the refresh branch is a function of the response alone', () => {
    // For every shape that carries a refresh expiry, the result is unchanged across wildly
    // different fallbacks — the fallback only ever feeds the branch that has no refresh expiry.
    const fallbacks = [0, 1, FALLBACK_REFRESH_TTL_MS, 999_999_999_999];

    it('is unchanged by any fallbackRefreshTtlMs when the response carries a refresh expiry', () => {
      const bothPresent = makePayload({
        refreshTokenExpiresAt: REFRESH_EXPIRY,
        accessTokenExpiresAt: ACCESS_EXPIRY_LOW,
      });
      const refreshOnly = makePayload({
        refreshTokenExpiresAt: REFRESH_EXPIRY,
        accessTokenExpiresAt: undefined,
      });

      for (const fallback of fallbacks) {
        expect(resolveRecordExpiry(bothPresent, RECEIVED_AT, fallback).getTime()).toBe(
          Math.max(REFRESH_EXPIRY_MS, ACCESS_EXPIRY_LOW_MS),
        );
        expect(resolveRecordExpiry(refreshOnly, RECEIVED_AT, fallback).getTime()).toBe(
          REFRESH_EXPIRY_MS,
        );
      }
    });

    it('does move with the fallback only when the response omits the refresh expiry', () => {
      const neither = makePayload({
        refreshTokenExpiresAt: undefined,
        accessTokenExpiresAt: undefined,
      });
      // Distinct fallbacks give distinct results here, proving the fallback is live on this branch.
      expect(resolveRecordExpiry(neither, RECEIVED_AT, 1000).getTime()).toBe(RECEIVED_AT + 1000);
      expect(resolveRecordExpiry(neither, RECEIVED_AT, 5000).getTime()).toBe(RECEIVED_AT + 5000);
    });
  });
});

/** A silent logger — these tests assert on records and returned values, not on log lines. */
const logger = {
  warn: () => {},
  debug: () => {},
  info: () => {},
} as unknown as Pick<OpenIDLogger, 'warn' | 'debug' | 'info'>;

/**
 * An in-memory custody store keyed by `tokenKeyHash`, modelling the parts of the real method set
 * the service depends on: the `expiresAt > now` reader predicate, the tenant filter and the atomic
 * compare-and-set on `rotationCounter`. It writes `expiresAt` exactly as handed to it — the store
 * derives no lifetime of its own — so a read-back of `expiresAt` is the value the service computed.
 */
function createInMemoryCustodyStore(now: () => number): TokenCustodyDeps['db'] {
  const records = new Map<string, ITokenCustodyView>();

  const tenantMatches = (record: ITokenCustodyView, tenantId?: string): boolean =>
    (record.tenantId ?? undefined) === (tenantId ?? undefined);

  const readable = (record: ITokenCustodyView): boolean => record.expiresAt.getTime() > now();

  return {
    upsertTokenCustody: async (data: TokenCustodyUpsert): Promise<ITokenCustodyView> => {
      const timestamp = new Date(now());
      const existing = records.get(data.tokenKeyHash);
      const record: ITokenCustodyView = {
        tokenKeyHash: data.tokenKeyHash,
        sealedTokens: data.sealedTokens,
        userId: data.userId,
        tenantId: data.tenantId,
        openidIssuer: data.openidIssuer,
        openidSubject: data.openidSubject,
        rotationCounter: data.rotationCounter,
        accessTokenExpiresAt: data.accessTokenExpiresAt,
        refreshTokenExpiresAt: data.refreshTokenExpiresAt,
        lastRefreshedAt: data.lastRefreshedAt,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        expiresAt: data.expiresAt,
      };
      records.set(data.tokenKeyHash, record);
      return { ...record };
    },

    findTokenCustody: async (query: {
      tokenKeyHash: string;
      tenantId?: string;
    }): Promise<ITokenCustodyView | null> => {
      const record = records.get(query.tokenKeyHash);
      if (record === undefined || !tenantMatches(record, query.tenantId) || !readable(record)) {
        return null;
      }
      return { ...record };
    },

    findTokenCustodyMeta: async (query: {
      tokenKeyHash: string;
      tenantId?: string;
    }): Promise<{ userId: string } | null> => {
      const record = records.get(query.tokenKeyHash);
      if (record === undefined || !tenantMatches(record, query.tenantId) || !readable(record)) {
        return null;
      }
      return { userId: record.userId };
    },

    updateTokenCustodyIfCurrent: async (
      data: TokenCustodyRotation,
    ): Promise<ITokenCustodyView | null> => {
      const record = records.get(data.tokenKeyHash);
      if (
        record === undefined ||
        !readable(record) ||
        record.rotationCounter !== data.expectedCounter
      ) {
        return null;
      }
      const updated: ITokenCustodyView = {
        ...record,
        sealedTokens: data.sealedTokens,
        accessTokenExpiresAt: data.accessTokenExpiresAt,
        refreshTokenExpiresAt: data.refreshTokenExpiresAt,
        lastRefreshedAt: data.lastRefreshedAt,
        expiresAt: data.expiresAt,
        rotationCounter: record.rotationCounter + 1,
        updatedAt: new Date(now()),
      };
      records.set(data.tokenKeyHash, updated);
      return { ...updated };
    },

    deleteTokenCustody: async (query: {
      tokenKeyHash: string;
    }): Promise<{ deletedCount: number }> => {
      return { deletedCount: records.delete(query.tokenKeyHash) ? 1 : 0 };
    },

    deleteTokenCustodiesByUser: async (query: {
      userId: string;
      tenantId?: string;
    }): Promise<{ deletedCount: number }> => {
      let deletedCount = 0;
      for (const [hash, record] of records) {
        if (record.userId === query.userId && tenantMatches(record, query.tenantId)) {
          records.delete(hash);
          deletedCount += 1;
        }
      }
      return { deletedCount };
    },
  };
}

const identity: TokenCustodyIdentity = { userId: 'user-1' };

describe('the derived lifetime through createCustody and rotateCustody', () => {
  it('sets the login expiresAt from the first response at its receipt time', async () => {
    const clock = RECEIVED_AT;
    const db = createInMemoryCustodyStore(() => clock);
    const service = createTokenCustodyService({
      db,
      logger,
      fallbackRefreshTtlMs: FALLBACK_REFRESH_TTL_MS,
      now: () => clock,
    });

    const tokens = makePayload({
      refreshTokenExpiresAt: REFRESH_EXPIRY,
      accessTokenExpiresAt: ACCESS_EXPIRY_LOW,
    });
    const created = await service.createCustody({ tokens, identity });

    const expected = resolveRecordExpiry(tokens, RECEIVED_AT, FALLBACK_REFRESH_TTL_MS);
    // The returned value, the value written on the record, and the pure rule all agree.
    expect(created.expiresAt.getTime()).toBe(expected.getTime());
    const stored = await db.findTokenCustody({ tokenKeyHash: created.tokenKeyHash });
    expect(stored!.expiresAt.getTime()).toBe(expected.getTime());
  });

  it('recomputes expiresAt on rotation from the new response, with the stored value as no input', async () => {
    let clock = RECEIVED_AT;
    const db = createInMemoryCustodyStore(() => clock);
    const service = createTokenCustodyService({
      db,
      logger,
      fallbackRefreshTtlMs: FALLBACK_REFRESH_TTL_MS,
      now: () => clock,
    });

    // Login with a generous refresh expiry.
    const loginTokens = makePayload({
      refreshTokenExpiresAt: REFRESH_EXPIRY,
      accessTokenExpiresAt: ACCESS_EXPIRY_LOW,
    });
    const created = await service.createCustody({ tokens: loginTokens, identity });
    const key = parseTokenKey(created.tokenKey) as Buffer;
    const context = await service.openCustody({ tokenKey: key, expectedUserId: identity.userId });
    expect(context).not.toBeNull();

    // Rotate later in time with a response that carries a *later* refresh expiry: the new value is
    // a function of the new response, not the old stored one.
    const rotateAt = RECEIVED_AT + 1_000_000;
    clock = rotateAt;
    const rotatedRefreshExpiry = REFRESH_EXPIRY + 30_000;
    const rotatedTokens = makePayload({
      refreshTokenExpiresAt: rotatedRefreshExpiry,
      accessTokenExpiresAt: undefined,
    });
    const result = await service.rotateCustody({ context: context!, tokens: rotatedTokens });
    expect(result.outcome).toBe('applied');
    if (result.outcome === 'gone') {
      throw new Error('unexpected gone outcome');
    }

    const expected = resolveRecordExpiry(rotatedTokens, rotateAt, FALLBACK_REFRESH_TTL_MS);
    expect(result.expiresAt.getTime()).toBe(expected.getTime());
    // The rotated response has no access expiry: the value is exactly its refresh expiry converted
    // to ms, proving the receipt time and the new response — not the old expiresAt — drove it.
    expect(result.expiresAt.getTime()).toBe(rotatedRefreshExpiry * 1000);
    const stored = await db.findTokenCustody({ tokenKeyHash: created.tokenKeyHash });
    expect(stored!.expiresAt.getTime()).toBe(expected.getTime());
  });

  it('lets expiresAt move earlier when a rotation omits a refresh expiry the previous one provided', async () => {
    let clock = RECEIVED_AT;
    const db = createInMemoryCustodyStore(() => clock);
    const service = createTokenCustodyService({
      db,
      logger,
      fallbackRefreshTtlMs: FALLBACK_REFRESH_TTL_MS,
      now: () => clock,
    });

    // Login with a far-future refresh expiry (seconds), so the record's initial lifetime is
    // generous — well past the fallback term the omitting rotation will fall back to.
    const loginRefreshExpiry = RECEIVED_AT_SECONDS + 500_000;
    const loginTokens = makePayload({
      refreshTokenExpiresAt: loginRefreshExpiry,
      accessTokenExpiresAt: undefined,
    });
    const created = await service.createCustody({ tokens: loginTokens, identity });
    const loginExpiry = created.expiresAt.getTime();
    expect(loginExpiry).toBe(loginRefreshExpiry * 1000);

    const key = parseTokenKey(created.tokenKey) as Buffer;
    const context = await service.openCustody({ tokenKey: key, expectedUserId: identity.userId });

    // Rotate with a response that OMITS the refresh expiry entirely — the base falls back to
    // receivedAt + fallback, which is far earlier than the stored expiresAt.
    const rotateAt = RECEIVED_AT + 1_000;
    clock = rotateAt;
    const rotatedTokens = makePayload({
      refreshTokenExpiresAt: undefined,
      accessTokenExpiresAt: undefined,
    });
    const result = await service.rotateCustody({ context: context!, tokens: rotatedTokens });
    expect(result.outcome).toBe('applied');
    if (result.outcome === 'gone') {
      throw new Error('unexpected gone outcome');
    }

    // The new lifetime is the fallback term at the rotation's receipt time, earlier than before.
    expect(result.expiresAt.getTime()).toBe(rotateAt + FALLBACK_REFRESH_TTL_MS);
    expect(result.expiresAt.getTime()).toBeLessThan(loginExpiry);
    const stored = await db.findTokenCustody({ tokenKeyHash: created.tokenKeyHash });
    expect(stored!.expiresAt.getTime()).toBe(rotateAt + FALLBACK_REFRESH_TTL_MS);
  });
});

describe('the rule reads only its injected fallback — no environment, no librechat.yaml', () => {
  /**
   * The fallback arrives only as the injected `fallbackRefreshTtlMs`. With lifetime-related env vars
   * set to different values, the derived lifetime must track the injected number and ignore them.
   */
  const LIFETIME_ENV_KEYS = [
    'REFRESH_TOKEN_EXPIRY',
    'SESSION_EXPIRY',
    'OPENID_REUSE_MAX_SESSION_AGE_MS',
  ] as const;

  it('derives the fallback branch from the injected number, not process.env', async () => {
    const saved = new Map<string, string | undefined>();
    for (const k of LIFETIME_ENV_KEYS) {
      saved.set(k, process.env[k]);
    }
    // Set env to values that would be visible if the service read them — and different from both
    // the injected fallback and the derived answer.
    process.env.REFRESH_TOKEN_EXPIRY = String(123_456_789);
    process.env.SESSION_EXPIRY = String(987_654_321);
    process.env.OPENID_REUSE_MAX_SESSION_AGE_MS = String(555_000_000);

    try {
      const injectedFallback = FALLBACK_REFRESH_TTL_MS;
      // Pure rule: the fallback-only shape equals receivedAt + the INJECTED fallback.
      const neither = makePayload({
        refreshTokenExpiresAt: undefined,
        accessTokenExpiresAt: undefined,
      });
      const pure = resolveRecordExpiry(neither, RECEIVED_AT, injectedFallback);
      expect(pure.getTime()).toBe(RECEIVED_AT + injectedFallback);
      // It is not the env value under any interpretation.
      expect(pure.getTime()).not.toBe(RECEIVED_AT + 123_456_789);
      expect(pure.getTime()).not.toBe(123_456_789);

      // And through the service: the written expiresAt follows the injected fallback.
      const clock = RECEIVED_AT;
      const db = createInMemoryCustodyStore(() => clock);
      const service = createTokenCustodyService({
        db,
        logger,
        fallbackRefreshTtlMs: injectedFallback,
        now: () => clock,
      });
      const created = await service.createCustody({ tokens: neither, identity });
      expect(created.expiresAt.getTime()).toBe(RECEIVED_AT + injectedFallback);

      // A second service with a DIFFERENT injected fallback but the identical environment produces a
      // different lifetime — the injected number is the only lever, the environment is inert.
      const otherFallback = injectedFallback * 2;
      const db2 = createInMemoryCustodyStore(() => clock);
      const service2 = createTokenCustodyService({
        db: db2,
        logger,
        fallbackRefreshTtlMs: otherFallback,
        now: () => clock,
      });
      const created2 = await service2.createCustody({ tokens: neither, identity });
      expect(created2.expiresAt.getTime()).toBe(RECEIVED_AT + otherFallback);
      expect(created2.expiresAt.getTime()).not.toBe(created.expiresAt.getTime());
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  });

  it('leaves the response-driven branch independent of any environment value', () => {
    // A response that provides a refresh expiry yields a lifetime that is a function of the
    // response alone. No environment value participates: the refresh branch never
    // touches the fallback, and the service never reads env for the lifetime regardless.
    const saved = process.env.REFRESH_TOKEN_EXPIRY;
    process.env.REFRESH_TOKEN_EXPIRY = String(42);
    try {
      const tokens = makePayload({
        refreshTokenExpiresAt: REFRESH_EXPIRY,
        accessTokenExpiresAt: ACCESS_EXPIRY_HIGH,
      });
      expect(resolveRecordExpiry(tokens, RECEIVED_AT, FALLBACK_REFRESH_TTL_MS).getTime()).toBe(
        Math.max(REFRESH_EXPIRY_MS, ACCESS_EXPIRY_HIGH_MS),
      );
    } finally {
      if (saved === undefined) {
        delete process.env.REFRESH_TOKEN_EXPIRY;
      } else {
        process.env.REFRESH_TOKEN_EXPIRY = saved;
      }
    }
  });
});
