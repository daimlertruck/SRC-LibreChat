import type { FilterQuery, Model, UpdateQuery } from 'mongoose';
import type {
  ITokenCustody,
  ITokenCustodyView,
  TokenCustodyUpsert,
  TokenCustodyRotation,
  TokenCustodyQuery,
  TokenCustodyMeta,
  TokenCustodyUserQuery,
} from '~/types';
import { createIndexesWithRetry } from '~/utils/retry';
import logger from '~/config/winston';

/**
 * The by-user delete filter: a call carrying a `tenantId` matches only records stamped with that
 * same value, and a call without one matches only records that carry no `tenantId` field. An absent
 * tenant is `{ $exists: false }`, never the value `undefined`, so the two are distinguishable. This
 * is the only method that filters on tenant: reads and the single-record delete address a record by
 * its unique `tokenKeyHash`, and the caller compares the returned `tenantId` after the read
 * (`expectedTenantId` in the custody service), so a record cannot be looked up with the wrong tenant
 * input while still being rejected cross-tenant.
 */
function tenantFilter(tenantId?: string): FilterQuery<ITokenCustody> {
  return { tenantId: tenantId ?? { $exists: false } };
}

export function createTokenCustodyMethods(mongoose: typeof import('mongoose')): {
  upsertTokenCustody: (data: TokenCustodyUpsert) => Promise<ITokenCustodyView>;
  findTokenCustody: (query: TokenCustodyQuery) => Promise<ITokenCustodyView | null>;
  findTokenCustodyMeta: (query: TokenCustodyQuery) => Promise<TokenCustodyMeta | null>;
  updateTokenCustodyIfCurrent: (data: TokenCustodyRotation) => Promise<ITokenCustodyView | null>;
  deleteTokenCustody: (query: { tokenKeyHash: string }) => Promise<{ deletedCount: number }>;
  deleteTokenCustodiesByUser: (query: TokenCustodyUserQuery) => Promise<{ deletedCount: number }>;
} {
  let indexesPromise: Promise<void> | null = null;

  const getTokenCustodyModel = () => mongoose.models.TokenCustody as Model<ITokenCustody>;

  /**
   * A custody record holds a sealed token set that only the browser's key can open, and its unique
   * `tokenKeyHash` index is what makes the upsert a single record per session while the `expiresAt`
   * TTL index is the only thing that ever reclaims one. `MONGO_AUTO_INDEX=false` is a supported
   * deployment setting, and under it Mongoose builds neither — so records would accumulate and
   * concurrent logins could leave duplicates. The indexes are therefore installed before the first
   * write, memoized after success, and retried on the next write after a failed build rather than
   * cached.
   */
  function ensureIndexes(): Promise<void> {
    if (!indexesPromise) {
      indexesPromise = createIndexesWithRetry(getTokenCustodyModel()).catch((error) => {
        indexesPromise = null;
        throw error;
      });
    }
    return indexesPromise;
  }

  /**
   * Writes a new custody record with `rotationCounter` 0 and `expiresAt` equal to the
   * caller-derived value, exactly as given. The store derives no lifetime of its own and applies
   * no duration to the write time. Keyed by `tokenKeyHash`, so a re-login under a fresh key writes
   * a distinct record and never disturbs another session's counter.
   */
  async function upsertTokenCustody(data: TokenCustodyUpsert): Promise<ITokenCustodyView> {
    try {
      await ensureIndexes();
      const TokenCustody = getTokenCustodyModel();
      const now = new Date();
      const update: UpdateQuery<ITokenCustody> = {
        $set: {
          sealedTokens: data.sealedTokens,
          userId: data.userId,
          rotationCounter: data.rotationCounter,
          lastRefreshedAt: data.lastRefreshedAt,
          expiresAt: data.expiresAt,
          updatedAt: now,
          ...(data.tenantId != null && { tenantId: data.tenantId }),
          ...(data.openidIssuer != null && { openidIssuer: data.openidIssuer }),
          ...(data.openidSubject != null && { openidSubject: data.openidSubject }),
          ...(data.accessTokenExpiresAt != null && {
            accessTokenExpiresAt: data.accessTokenExpiresAt,
          }),
          ...(data.refreshTokenExpiresAt != null && {
            refreshTokenExpiresAt: data.refreshTokenExpiresAt,
          }),
        },
        $setOnInsert: {
          tokenKeyHash: data.tokenKeyHash,
          createdAt: now,
        },
        $unset: {
          ...(data.tenantId == null && { tenantId: '' }),
          ...(data.openidIssuer == null && { openidIssuer: '' }),
          ...(data.openidSubject == null && { openidSubject: '' }),
          ...(data.accessTokenExpiresAt == null && { accessTokenExpiresAt: '' }),
          ...(data.refreshTokenExpiresAt == null && { refreshTokenExpiresAt: '' }),
        },
      };
      const record = await TokenCustody.findOneAndUpdate(
        { tokenKeyHash: data.tokenKeyHash },
        update,
        { upsert: true, new: true },
      ).lean<ITokenCustodyView>();
      /** `new: true` with `upsert: true` always returns the written document. */
      return record as ITokenCustodyView;
    } catch (error) {
      logger.debug('[upsertTokenCustody] Error storing custody record:', error);
      throw error;
    }
  }

  /**
   * Reads the record for a hash, matching only records whose `expiresAt` is strictly after the
   * current time. An unswept expired record (the TTL monitor runs on its own schedule) is therefore
   * returned as absent. The lookup is by `tokenKeyHash` alone — the unique index identifies at most
   * one record, and the record's own `tenantId` is returned for the caller to compare — so a tenant
   * is never a lookup input here.
   */
  async function findTokenCustody(query: TokenCustodyQuery): Promise<ITokenCustodyView | null> {
    try {
      const TokenCustody = getTokenCustodyModel();
      return await TokenCustody.findOne({
        tokenKeyHash: query.tokenKeyHash,
        expiresAt: { $gt: new Date() },
      }).lean<ITokenCustodyView>();
    } catch (error) {
      logger.debug('[findTokenCustody] Error finding custody record:', error);
      throw error;
    }
  }

  /**
   * The existence-and-identity read behind `verifyCustodyBinding`: projects to `userId` and
   * `tenantId` only, so a `sealedTokens` blob never leaves the store on the file-authorization
   * paths. Applies the same `expiresAt > now` reader predicate and the same lookup-by-hash as
   * `findTokenCustody`, so a revoked, logged-out or expired record reads as absent. Returns
   * `{ userId, tenantId? }` when a live record exists for the hash, or null otherwise; the caller
   * compares the returned `tenantId` against any tenant it knows.
   */
  async function findTokenCustodyMeta(query: TokenCustodyQuery): Promise<TokenCustodyMeta | null> {
    try {
      const TokenCustody = getTokenCustodyModel();
      const record = await TokenCustody.findOne(
        {
          tokenKeyHash: query.tokenKeyHash,
          expiresAt: { $gt: new Date() },
        },
        { userId: 1, tenantId: 1, _id: 0 },
      ).lean<{ userId: string; tenantId?: string }>();
      if (!record) {
        return null;
      }
      return record.tenantId != null
        ? { userId: record.userId, tenantId: record.tenantId }
        : { userId: record.userId };
    } catch (error) {
      logger.debug('[findTokenCustodyMeta] Error finding custody record:', error);
      throw error;
    }
  }

  /**
   * A single atomic compare-and-set: matches the record only when its stored `rotationCounter`
   * equals `expectedCounter` (and it is unexpired within the tenant), increments `rotationCounter`
   * by exactly 1, and applies the five carried fields. Returns the updated record when applied and
   * null when no record matched, leaving the stored record untouched. Of N concurrent calls with
   * the same hash and expected counter, exactly one matches, because the first to apply advances
   * the counter past the value the rest are still matching on.
   *
   * The optional expiry fields are `$set` when present and `$unset` when absent, so a rotation
   * whose response omits an expiry a previous one carried clears the stored value rather than
   * leaving a stale one behind.
   */
  async function updateTokenCustodyIfCurrent(
    data: TokenCustodyRotation,
  ): Promise<ITokenCustodyView | null> {
    try {
      const TokenCustody = getTokenCustodyModel();
      const update: UpdateQuery<ITokenCustody> = {
        $set: {
          sealedTokens: data.sealedTokens,
          lastRefreshedAt: data.lastRefreshedAt,
          expiresAt: data.expiresAt,
          updatedAt: new Date(),
          ...(data.accessTokenExpiresAt != null && {
            accessTokenExpiresAt: data.accessTokenExpiresAt,
          }),
          ...(data.refreshTokenExpiresAt != null && {
            refreshTokenExpiresAt: data.refreshTokenExpiresAt,
          }),
        },
        $inc: { rotationCounter: 1 },
        $unset: {
          ...(data.accessTokenExpiresAt == null && { accessTokenExpiresAt: '' }),
          ...(data.refreshTokenExpiresAt == null && { refreshTokenExpiresAt: '' }),
        },
      };
      return await TokenCustody.findOneAndUpdate(
        {
          tokenKeyHash: data.tokenKeyHash,
          rotationCounter: data.expectedCounter,
          expiresAt: { $gt: new Date() },
        },
        update,
        { new: true },
      ).lean<ITokenCustodyView>();
    } catch (error) {
      logger.debug('[updateTokenCustodyIfCurrent] Error rotating custody record:', error);
      throw error;
    }
  }

  /** Removes the record with the given hash and reports how many were removed (0 or 1). */
  async function deleteTokenCustody(query: {
    tokenKeyHash: string;
  }): Promise<{ deletedCount: number }> {
    try {
      const TokenCustody = getTokenCustodyModel();
      const result = await TokenCustody.deleteOne({ tokenKeyHash: query.tokenKeyHash });
      return { deletedCount: result.deletedCount ?? 0 };
    } catch (error) {
      logger.debug('[deleteTokenCustody] Error deleting custody record:', error);
      throw error;
    }
  }

  /**
   * Removes every record for a user under the tenant filter, leaving records of other users and
   * other tenants untouched, and reports how many were removed.
   */
  async function deleteTokenCustodiesByUser(
    query: TokenCustodyUserQuery,
  ): Promise<{ deletedCount: number }> {
    try {
      const TokenCustody = getTokenCustodyModel();
      const result = await TokenCustody.deleteMany({
        userId: query.userId,
        ...tenantFilter(query.tenantId),
      });
      return { deletedCount: result.deletedCount ?? 0 };
    } catch (error) {
      logger.debug('[deleteTokenCustodiesByUser] Error deleting custody records:', error);
      throw error;
    }
  }

  return {
    upsertTokenCustody,
    findTokenCustody,
    findTokenCustodyMeta,
    updateTokenCustodyIfCurrent,
    deleteTokenCustody,
    deleteTokenCustodiesByUser,
  };
}

export type TokenCustodyMethods = ReturnType<typeof createTokenCustodyMethods>;
