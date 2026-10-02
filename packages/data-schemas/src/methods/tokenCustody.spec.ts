import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type * as t from '~/types';
import { createTokenCustodyMethods } from './tokenCustody';
import tokenCustodySchema from '~/schema/tokenCustody';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createTokenCustodyMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  if (!mongoose.models.TokenCustody) {
    mongoose.model<t.ITokenCustody>('TokenCustody', tokenCustodySchema);
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  methods = createTokenCustodyMethods(mongoose);
});

/** A complete upsert payload with `expiresAt` an hour out unless overridden. */
function upsertData(overrides: Partial<t.TokenCustodyUpsert> = {}): t.TokenCustodyUpsert {
  return {
    tokenKeyHash: 'hash-1',
    sealedTokens: 'kc1:iv:tag:ciphertext',
    userId: 'user-1',
    rotationCounter: 0,
    lastRefreshedAt: Date.now(),
    expiresAt: new Date(Date.now() + 3600_000),
    ...overrides,
  };
}

describe('TokenCustody Methods', () => {
  describe('index installation', () => {
    it('installs the unique, TTL and lookup indexes before the first write', async () => {
      await methods.upsertTokenCustody(upsertData());

      const indexes = await mongoose.models.TokenCustody.listIndexes();
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: { tokenKeyHash: 1 }, unique: true }),
          expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
          expect.objectContaining({ key: { userId: 1, tenantId: 1 } }),
        ]),
      );
    });

    it('installs indexes on a connection that disables auto-indexing (MONGO_AUTO_INDEX=false)', async () => {
      /**
       * Under `autoIndex: false` Mongoose builds no index at compile time, so the unique and TTL
       * indexes exist only because the methods build them explicitly on the first write.
       */
      const database = new mongoose.Mongoose();
      database.set('autoIndex', false);
      database.set('autoCreate', false);
      await database.connect(mongoServer.getUri(), { dbName: 'no-auto-index' });
      try {
        database.model<t.ITokenCustody>('TokenCustody', tokenCustodySchema);
        const disabledMethods = createTokenCustodyMethods(database);

        // with autoCreate/autoIndex off the collection does not even exist before the first write
        await disabledMethods.upsertTokenCustody(upsertData());

        const after = await database.models.TokenCustody.listIndexes();
        expect(after).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ key: { tokenKeyHash: 1 }, unique: true }),
            expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
            expect.objectContaining({ key: { userId: 1, tenantId: 1 } }),
          ]),
        );
      } finally {
        await database.disconnect();
      }
    });

    it('memoizes the index build after success and issues it only once per process', async () => {
      const spy = jest.spyOn(mongoose.models.TokenCustody, 'createIndexes');
      const freshMethods = createTokenCustodyMethods(mongoose);

      await freshMethods.upsertTokenCustody(upsertData({ tokenKeyHash: 'hash-a' }));
      await freshMethods.upsertTokenCustody(upsertData({ tokenKeyHash: 'hash-b' }));

      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('retries the index build on the next write after a failed installation', async () => {
      const spy = jest
        .spyOn(mongoose.models.TokenCustody, 'createIndexes')
        .mockRejectedValueOnce(new Error('index build failed'));
      const freshMethods = createTokenCustodyMethods(mongoose);

      await expect(
        freshMethods.upsertTokenCustody(upsertData({ tokenKeyHash: 'hash-fail' })),
      ).rejects.toThrow('index build failed');

      // the failed build was not cached: the next write attempts installation again
      await freshMethods.upsertTokenCustody(upsertData({ tokenKeyHash: 'hash-ok' }));

      expect(spy).toHaveBeenCalledTimes(2);
      spy.mockRestore();
    });
  });

  describe('unique index on tokenKeyHash', () => {
    it('keeps one record per token key hash across repeated upserts', async () => {
      await methods.upsertTokenCustody(upsertData({ sealedTokens: 'kc1:first' }));
      const second = await methods.upsertTokenCustody(upsertData({ sealedTokens: 'kc1:second' }));

      expect(second.sealedTokens).toBe('kc1:second');
      expect(await mongoose.models.TokenCustody.countDocuments()).toBe(1);
    });

    it('rejects a second raw insert of the same hash under the real unique index', async () => {
      await methods.upsertTokenCustody(upsertData());

      await expect(
        mongoose.models.TokenCustody.create({
          tokenKeyHash: 'hash-1',
          sealedTokens: 'kc1:other',
          userId: 'user-2',
          rotationCounter: 0,
          lastRefreshedAt: Date.now(),
          expiresAt: new Date(Date.now() + 3600_000),
        }),
      ).rejects.toThrow(/duplicate key/i);
    });
  });

  describe('reader predicate and TTL index', () => {
    it('maintains the TTL index with expireAfterSeconds 0', async () => {
      await methods.upsertTokenCustody(upsertData());
      const indexes = await mongoose.models.TokenCustody.listIndexes();
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
        ]),
      );
    });

    it('finds an unexpired record by hash and tenant', async () => {
      await methods.upsertTokenCustody(
        upsertData({
          tenantId: 'tenant-1',
          openidIssuer: 'https://idp.example',
          sealedTokens: 'kc1:live',
        }),
      );

      const found = await methods.findTokenCustody({
        tokenKeyHash: 'hash-1',
        tenantId: 'tenant-1',
      });
      expect(found?.sealedTokens).toBe('kc1:live');
      expect(found?.openidIssuer).toBe('https://idp.example');
    });

    it('treats an unswept expired record as absent via the expiresAt > now predicate', async () => {
      await methods.upsertTokenCustody(upsertData({ expiresAt: new Date(Date.now() - 1000) }));

      // the document is still physically present; the TTL monitor has not swept it
      expect(await mongoose.models.TokenCustody.countDocuments()).toBe(1);
      await expect(methods.findTokenCustody({ tokenKeyHash: 'hash-1' })).resolves.toBeNull();
    });
  });

  describe('tenant filter', () => {
    it('matches only the record for the requested tenant', async () => {
      await methods.upsertTokenCustody(
        upsertData({ tokenKeyHash: 'hash-t1', tenantId: 'tenant-1', sealedTokens: 'kc1:t1' }),
      );
      await methods.upsertTokenCustody(
        upsertData({ tokenKeyHash: 'hash-t2', tenantId: 'tenant-2', sealedTokens: 'kc1:t2' }),
      );

      const t1 = await methods.findTokenCustody({ tokenKeyHash: 'hash-t1', tenantId: 'tenant-1' });
      expect(t1?.sealedTokens).toBe('kc1:t1');

      // a wrong-tenant read finds nothing
      await expect(
        methods.findTokenCustody({ tokenKeyHash: 'hash-t1', tenantId: 'tenant-2' }),
      ).resolves.toBeNull();
    });

    it('a no-tenant call matches only records without a tenantId field', async () => {
      await methods.upsertTokenCustody(
        upsertData({ tokenKeyHash: 'hash-none', sealedTokens: 'kc1:none' }),
      );
      await methods.upsertTokenCustody(
        upsertData({
          tokenKeyHash: 'hash-tenant',
          tenantId: 'tenant-1',
          sealedTokens: 'kc1:tenant',
        }),
      );

      const none = await methods.findTokenCustody({ tokenKeyHash: 'hash-none' });
      expect(none?.sealedTokens).toBe('kc1:none');
      // the field must be genuinely absent, not stored as undefined
      expect(none).not.toHaveProperty('tenantId');

      // a no-tenant read never matches a tenant-stamped record
      await expect(methods.findTokenCustody({ tokenKeyHash: 'hash-tenant' })).resolves.toBeNull();
    });
  });

  describe('updateTokenCustodyIfCurrent compare-and-set', () => {
    it('applies the five carried fields and increments the counter by one when current', async () => {
      await methods.upsertTokenCustody(upsertData({ sealedTokens: 'kc1:v0' }));

      const nextExpiresAt = new Date(Date.now() + 7200_000);
      const updated = await methods.updateTokenCustodyIfCurrent({
        tokenKeyHash: 'hash-1',
        expectedCounter: 0,
        sealedTokens: 'kc1:v1',
        accessTokenExpiresAt: 111,
        refreshTokenExpiresAt: 222,
        lastRefreshedAt: 999,
        expiresAt: nextExpiresAt,
      });

      expect(updated?.rotationCounter).toBe(1);
      expect(updated?.sealedTokens).toBe('kc1:v1');
      expect(updated?.accessTokenExpiresAt).toBe(111);
      expect(updated?.refreshTokenExpiresAt).toBe(222);
      expect(updated?.lastRefreshedAt).toBe(999);
      expect(updated?.expiresAt.getTime()).toBe(nextExpiresAt.getTime());
    });

    it('returns null and leaves the record unchanged when the counter does not match', async () => {
      await methods.upsertTokenCustody(upsertData({ sealedTokens: 'kc1:v0' }));

      const stale = await methods.updateTokenCustodyIfCurrent({
        tokenKeyHash: 'hash-1',
        expectedCounter: 5,
        sealedTokens: 'kc1:stale',
        lastRefreshedAt: 999,
        expiresAt: new Date(Date.now() + 3600_000),
      });

      expect(stale).toBeNull();
      const current = await methods.findTokenCustody({ tokenKeyHash: 'hash-1' });
      expect(current?.rotationCounter).toBe(0);
      expect(current?.sealedTokens).toBe('kc1:v0');
    });

    it('unsets an expiry the previous rotation carried when the new one omits it', async () => {
      await methods.upsertTokenCustody(
        upsertData({ accessTokenExpiresAt: 111, refreshTokenExpiresAt: 222 }),
      );

      const updated = await methods.updateTokenCustodyIfCurrent({
        tokenKeyHash: 'hash-1',
        expectedCounter: 0,
        sealedTokens: 'kc1:v1',
        accessTokenExpiresAt: 333,
        lastRefreshedAt: 999,
        expiresAt: new Date(Date.now() + 3600_000),
      });

      expect(updated?.accessTokenExpiresAt).toBe(333);
      expect(updated).not.toHaveProperty('refreshTokenExpiresAt');
    });

    it('lets exactly one of N concurrent callers apply', async () => {
      await methods.upsertTokenCustody(upsertData({ sealedTokens: 'kc1:v0' }));

      const callers = Array.from({ length: 10 }, (_, i) =>
        methods.updateTokenCustodyIfCurrent({
          tokenKeyHash: 'hash-1',
          expectedCounter: 0,
          sealedTokens: `kc1:caller-${i}`,
          lastRefreshedAt: Date.now(),
          expiresAt: new Date(Date.now() + 3600_000),
        }),
      );

      const results = await Promise.all(callers);
      const winners = results.filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.rotationCounter).toBe(1);

      const record = await methods.findTokenCustody({ tokenKeyHash: 'hash-1' });
      expect(record?.rotationCounter).toBe(1);
      expect(record?.sealedTokens).toBe(winners[0]?.sealedTokens);
    });
  });

  describe('deleteTokenCustody', () => {
    it('removes the record for a hash and reports one deletion', async () => {
      await methods.upsertTokenCustody(upsertData());

      const result = await methods.deleteTokenCustody({ tokenKeyHash: 'hash-1' });
      expect(result.deletedCount).toBe(1);
      expect(await mongoose.models.TokenCustody.countDocuments()).toBe(0);
    });

    it('reports zero deletions when no record matches', async () => {
      const result = await methods.deleteTokenCustody({ tokenKeyHash: 'absent-hash' });
      expect(result.deletedCount).toBe(0);
    });
  });

  describe('deleteTokenCustodiesByUser', () => {
    it('removes only the requested user under the tenant filter', async () => {
      await methods.upsertTokenCustody(
        upsertData({ tokenKeyHash: 'h-a', userId: 'user-1', tenantId: 'tenant-1' }),
      );
      await methods.upsertTokenCustody(
        upsertData({ tokenKeyHash: 'h-b', userId: 'user-1', tenantId: 'tenant-1' }),
      );
      await methods.upsertTokenCustody(
        upsertData({ tokenKeyHash: 'h-c', userId: 'user-2', tenantId: 'tenant-1' }),
      );
      await methods.upsertTokenCustody(
        upsertData({ tokenKeyHash: 'h-d', userId: 'user-1', tenantId: 'tenant-2' }),
      );

      const result = await methods.deleteTokenCustodiesByUser({
        userId: 'user-1',
        tenantId: 'tenant-1',
      });

      expect(result.deletedCount).toBe(2);
      // user-2 same tenant and user-1 other tenant are untouched
      expect(await mongoose.models.TokenCustody.countDocuments()).toBe(2);
    });

    it('a no-tenant delete removes only records without a tenantId field', async () => {
      await methods.upsertTokenCustody(upsertData({ tokenKeyHash: 'h-none', userId: 'user-1' }));
      await methods.upsertTokenCustody(
        upsertData({ tokenKeyHash: 'h-tenant', userId: 'user-1', tenantId: 'tenant-1' }),
      );

      const result = await methods.deleteTokenCustodiesByUser({ userId: 'user-1' });

      expect(result.deletedCount).toBe(1);
      const remaining = await methods.findTokenCustody({
        tokenKeyHash: 'h-tenant',
        tenantId: 'tenant-1',
      });
      expect(remaining?.userId).toBe('user-1');
    });

    it('reports zero deletions when no record matches', async () => {
      const result = await methods.deleteTokenCustodiesByUser({ userId: 'nobody' });
      expect(result.deletedCount).toBe(0);
    });
  });
});
