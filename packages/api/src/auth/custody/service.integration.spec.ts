import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { OpenIDCustodyContext, TokenCustodyDeps, TokenCustodyService } from './service';
import type { CustodyTokenPayload, TokenCustodyIdentity } from './aead';
import { createTokenCustodyService } from './service';
import { parseTokenKey } from './key';

/**
 * Custody service integration tests against the REAL data-schemas method set backed by
 * `mongodb-memory-server`, with real `node:crypto` AEAD throughout — the AEAD is never stubbed. The
 * service is constructed exactly the way the app wires it: injected database methods, an injected
 * logger, an injected `fallbackRefreshTtlMs` and an injected clock. The IdP is not in play here;
 * every token set is supplied directly.
 */

let mongoServer: MongoMemoryServer;
let db: TokenCustodyDeps['db'];
let logger: TokenCustodyDeps['logger'];
let clock: number;

/** A fixed fallback so the fallback branch of the record TTL rule is deterministic in assertions. */
const FALLBACK_REFRESH_TTL_MS = 30 * 24 * 3600_000;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);

  const methods = createMethods(mongoose);
  /**
   * `findTokenCustodyMeta` is the projected read the service's `db` type names for the
   * file-authorization paths and is not exercised here; a projection over the real read
   * satisfies the type without a stub of any custody behavior this test touches.
   */
  db = {
    upsertTokenCustody: methods.upsertTokenCustody,
    findTokenCustody: methods.findTokenCustody,
    findTokenCustodyMeta: async (query) => {
      const record = await methods.findTokenCustody(query);
      return record === null ? null : { userId: record.userId };
    },
    updateTokenCustodyIfCurrent: methods.updateTokenCustodyIfCurrent,
    deleteTokenCustody: methods.deleteTokenCustody,
    deleteTokenCustodiesByUser: methods.deleteTokenCustodiesByUser,
  };
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  /**
   * The injected clock anchors `receivedAt`/`issuedAt` for deterministic assertions, but the
   * store's `expiresAt > now` reader predicate runs against the real wall clock. So the clock is
   * anchored at real "now": absolute expiry timestamps computed from it (`clock + duration`) land
   * genuinely in the future and the reader predicate admits the record.
   */
  clock = Date.now();
  logger = { warn: jest.fn(), debug: jest.fn(), info: jest.fn() };
});

/** Builds the service with the shared real method set, the fixed clock and the chosen fallback. */
function makeService(): TokenCustodyService {
  return createTokenCustodyService({
    db,
    logger,
    fallbackRefreshTtlMs: FALLBACK_REFRESH_TTL_MS,
    now: () => clock,
  });
}

const IDENTITY: TokenCustodyIdentity = {
  userId: 'user-1',
  openidIssuer: 'https://idp.example',
  openidSubject: 'subject-1',
};

/** The current clock as unix seconds — the unit the IdP-supplied expiries are stored in. */
function clockSeconds(): number {
  return Math.floor(clock / 1000);
}

/**
 * A payload with both expiries present unless overridden. `issuedAt` tracks the current clock (ms),
 * while `accessTokenExpiresAt`/`refreshTokenExpiresAt` are UNIX SECONDS — the unit the real callers
 * store and that `resolveRecordExpiry` multiplies by 1000. Anchored a genuine hour/week ahead of
 * real "now" so the wall-clock reader predicate admits the record.
 */
function payload(overrides: Partial<CustodyTokenPayload> = {}): CustodyTokenPayload {
  return {
    accessToken: 'access-token',
    idToken: 'id-token',
    refreshToken: 'refresh-token',
    accessTokenExpiresAt: clockSeconds() + 3600,
    refreshTokenExpiresAt: clockSeconds() + 7 * 24 * 3600,
    issuedAt: clock,
    ...overrides,
  };
}

/** Decodes the returned cookie value into the 32 raw AEAD bytes, as a request would. */
function keyOf(tokenKey: string): Buffer {
  return parseTokenKey(tokenKey) as Buffer;
}

async function countRecords(): Promise<number> {
  return mongoose.models.TokenCustody.countDocuments();
}

describe('custody service integration (mongodb-memory-server, real AEAD)', () => {
  describe('create → open → rotate → open → delete on one record', () => {
    it('each open returns the most recently sealed payload, and delete removes the record', async () => {
      const service = makeService();

      // create: one record, counter 0, sealed under a minted key
      const created = await service.createCustody({ tokens: payload(), identity: IDENTITY });
      expect(await countRecords()).toBe(1);
      const key = keyOf(created.tokenKey);

      // open: returns the originally sealed payload
      const firstOpen = await service.openCustody({ tokenKey: key, expectedUserId: 'user-1' });
      expect(firstOpen).not.toBeNull();
      expect(firstOpen?.tokens.accessToken).toBe('access-token');
      expect(firstOpen?.tokens.refreshToken).toBe('refresh-token');
      expect(firstOpen?.rotationCounter).toBe(0);

      // rotate under the SAME key to a fresh token set at a later receipt time
      clock += 60_000;
      const rotatedPayload = payload({
        accessToken: 'access-token-2',
        refreshToken: 'refresh-token-2',
        idToken: 'id-token-2',
      });
      const rotation = await service.rotateCustody({
        context: firstOpen as OpenIDCustodyContext,
        tokens: rotatedPayload,
      });
      expect(rotation.outcome).toBe('applied');
      if (rotation.outcome === 'gone') {
        throw new Error('unexpected gone outcome');
      }
      expect(rotation.context.rotationCounter).toBe(1);
      // still exactly one record: rotation re-seals in place, it does not add a row
      expect(await countRecords()).toBe(1);
      // the returned expiresAt is the record's stored value, recomputed from the new payload —
      // the refresh expiry is unix seconds, so the derived ms lifetime is that value times 1000
      expect(rotation.expiresAt.getTime()).toBe(
        (rotatedPayload.refreshTokenExpiresAt as number) * 1000,
      );

      // open again: the most recently sealed payload, not the superseded one
      const secondOpen = await service.openCustody({ tokenKey: key, expectedUserId: 'user-1' });
      expect(secondOpen?.tokens.accessToken).toBe('access-token-2');
      expect(secondOpen?.tokens.refreshToken).toBe('refresh-token-2');
      expect(secondOpen?.tokens.idToken).toBe('id-token-2');
      expect(secondOpen?.rotationCounter).toBe(1);

      // delete: the record is gone and a subsequent open finds nothing
      await service.deleteCustody({ tokenKeyHash: created.tokenKeyHash });
      expect(await countRecords()).toBe(0);
      await expect(
        service.openCustody({ tokenKey: key, expectedUserId: 'user-1' }),
      ).resolves.toBeNull();
    });
  });

  describe('two concurrent rotateCustody calls on one record', () => {
    it('exactly one applies, rotationCounter advances by exactly one, and the loser adopts the winner with no write', async () => {
      const service = makeService();

      const created = await service.createCustody({ tokens: payload(), identity: IDENTITY });
      const key = keyOf(created.tokenKey);
      // both callers open the SAME counter-0 context, as two workers racing a refresh would
      const contextA = (await service.openCustody({
        tokenKey: key,
        expectedUserId: 'user-1',
      })) as OpenIDCustodyContext;
      const contextB = (await service.openCustody({
        tokenKey: key,
        expectedUserId: 'user-1',
      })) as OpenIDCustodyContext;
      expect(contextA.rotationCounter).toBe(0);
      expect(contextB.rotationCounter).toBe(0);

      clock += 60_000;
      const [resultA, resultB] = await Promise.all([
        service.rotateCustody({
          context: contextA,
          tokens: payload({ accessToken: 'from-A', refreshToken: 'refresh-A' }),
        }),
        service.rotateCustody({
          context: contextB,
          tokens: payload({ accessToken: 'from-B', refreshToken: 'refresh-B' }),
        }),
      ]);

      // neither racer finds a deleted record, so both carry a context
      if (resultA.outcome === 'gone' || resultB.outcome === 'gone') {
        throw new Error('unexpected gone outcome');
      }
      // exactly one applied, one superseded
      const applied = [resultA, resultB].filter((r) => r.outcome === 'applied');
      const superseded = [resultA, resultB].filter((r) => r.outcome === 'superseded');
      expect(applied).toHaveLength(1);
      expect(superseded).toHaveLength(1);

      // rotationCounter advanced by exactly one, and still one record
      expect(applied[0].context.rotationCounter).toBe(1);
      expect(await countRecords()).toBe(1);
      const stored = await db.findTokenCustody({ tokenKeyHash: created.tokenKeyHash });
      expect(stored?.rotationCounter).toBe(1);

      // the loser adopted the winner's context: same counter, same token set as the stored record
      const winnerAccess = applied[0].context.tokens.accessToken;
      expect(superseded[0].context.rotationCounter).toBe(1);
      expect(superseded[0].context.tokens.accessToken).toBe(winnerAccess);
      // the loser's returned expiresAt is the winner's record lifetime, not its own computation
      expect(superseded[0].expiresAt.getTime()).toBe(
        superseded[0].context.recordExpiresAt.getTime(),
      );
      expect(superseded[0].expiresAt.getTime()).toBe(stored?.expiresAt.getTime());

      // the loser performed no IdP grant (none available here) and no extra write: opening the
      // record still yields exactly the winner's payload
      const reopened = await service.openCustody({ tokenKey: key, expectedUserId: 'user-1' });
      expect(reopened?.tokens.accessToken).toBe(winnerAccess);
      expect(await countRecords()).toBe(1);
    });
  });

  describe('expired and unopenable records', () => {
    it('treats an unswept expired record as not found', async () => {
      const service = makeService();

      // seal a record whose expiresAt is already in the past (a refresh expiry an hour ago, in
      // unix seconds) so the derived ms lifetime is behind the wall-clock reader predicate
      const created = await service.createCustody({
        tokens: payload({
          refreshTokenExpiresAt: clockSeconds() - 3600,
          accessTokenExpiresAt: undefined,
        }),
        identity: IDENTITY,
      });
      const key = keyOf(created.tokenKey);

      // the document is physically present; the TTL monitor has not swept it
      expect(await countRecords()).toBe(1);
      // yet the expiresAt > now reader predicate treats it as absent
      await expect(
        service.openCustody({ tokenKey: key, expectedUserId: 'user-1' }),
      ).resolves.toBeNull();
    });

    it('reloadAfterInvalidGrant returns null for an absent record without deleting anything', async () => {
      const service = makeService();

      const created = await service.createCustody({ tokens: payload(), identity: IDENTITY });
      const key = keyOf(created.tokenKey);
      const context = (await service.openCustody({
        tokenKey: key,
        expectedUserId: 'user-1',
      })) as OpenIDCustodyContext;

      // remove the record out from under the context, as a concurrent logout would
      await service.deleteCustody({ tokenKeyHash: created.tokenKeyHash });
      expect(await countRecords()).toBe(0);

      await expect(service.reloadAfterInvalidGrant({ context })).resolves.toBeNull();
      // the reload deleted nothing (there was nothing to delete, and it issues no delete)
      expect(await countRecords()).toBe(0);
    });

    it('reloadAfterInvalidGrant returns null for an expired record and leaves it in place', async () => {
      const service = makeService();

      const created = await service.createCustody({ tokens: payload(), identity: IDENTITY });
      const key = keyOf(created.tokenKey);
      const context = (await service.openCustody({
        tokenKey: key,
        expectedUserId: 'user-1',
      })) as OpenIDCustodyContext;

      // expire the record directly so the reader predicate excludes it while it is still present
      await mongoose.models.TokenCustody.updateOne(
        { tokenKeyHash: created.tokenKeyHash },
        { $set: { expiresAt: new Date(clock - 1000) } },
      );
      expect(await countRecords()).toBe(1);

      await expect(service.reloadAfterInvalidGrant({ context })).resolves.toBeNull();
      // the expired record is treated as not found but is NOT deleted by the reload
      expect(await countRecords()).toBe(1);
    });

    it('reloadAfterInvalidGrant returns null for an unopenable record and leaves it in place', async () => {
      const service = makeService();

      const created = await service.createCustody({ tokens: payload(), identity: IDENTITY });
      const key = keyOf(created.tokenKey);
      const context = (await service.openCustody({
        tokenKey: key,
        expectedUserId: 'user-1',
      })) as OpenIDCustodyContext;

      // corrupt the sealed blob in place so real GCM verification fails on reload
      await mongoose.models.TokenCustody.updateOne(
        { tokenKeyHash: created.tokenKeyHash },
        { $set: { sealedTokens: 'kc1:AAAA:BBBB:CCCC' } },
      );
      expect(await countRecords()).toBe(1);

      await expect(service.reloadAfterInvalidGrant({ context })).resolves.toBeNull();
      // an unopenable record is not destroyed by the reload
      expect(await countRecords()).toBe(1);
    });
  });
});
