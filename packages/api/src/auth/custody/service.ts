import type {
  ITokenCustodyView,
  TokenCustodyUpsert,
  TokenCustodyRotation,
} from '@librechat/data-schemas';
import type { OpenIDLogger } from '~/auth/openid/types';
import {
  sealTokens,
  openTokens,
  CustodyOpenError,
  type CustodyTokenPayload,
  type TokenCustodyIdentity,
} from './aead';
import { generateTokenKey, hashTokenKey, parseTokenKey } from './key';

/**
 * The request-lived custody context. `openCustody` produces it, the file loader attaches it as
 * `req.openidCustody`, and rotation carries it back. The property names inside `tokens` match the
 * retired `req.session.openidTokens` field so readers change by accessor, not by shape.
 *
 * The context is never serialized and never persisted: `tokenKey` is the 32 raw AEAD bytes and
 * lives only while the request is being served.
 */
export interface OpenIDCustodyContext {
  tokens: CustodyTokenPayload;
  identity: TokenCustodyIdentity;
  tokenKeyHash: string;
  rotationCounter: number;
  /**
   * The record's TTL anchor as read — unsealed metadata, carried so a caller that re-issues the
   * token key cookie uses the value the record actually holds rather than computing one.
   */
  recordExpiresAt: Date;
  /**
   * The 32 raw bytes decoded from the cookie — the AEAD key itself; present only while the request
   * is being served.
   */
  tokenKey: Buffer;
}

/**
 * The custody service's dependencies. Everything the service needs — the custody store method set,
 * the logger, the resolved fallback refresh lifetime and an optional clock — arrives from the
 * caller. The service reads no `librechat.yaml`, no schema and no environment variable (including
 * `REFRESH_TOKEN_EXPIRY`) and imports no app singleton, so a test constructs it against a
 * `mongodb-memory-server`-backed method set with a fixed clock and a chosen fallback.
 */
export interface TokenCustodyDeps {
  db: {
    upsertTokenCustody: (data: TokenCustodyUpsert) => Promise<ITokenCustodyView>;
    /** Reads by hash alone; the record's own `tenantId` is returned, never a lookup input. */
    findTokenCustody: (query: { tokenKeyHash: string }) => Promise<ITokenCustodyView | null>;
    /** Projected read for the file-authorization paths: never returns `sealedTokens`. */
    findTokenCustodyMeta: (query: {
      tokenKeyHash: string;
    }) => Promise<{ userId: string; tenantId?: string } | null>;
    updateTokenCustodyIfCurrent: (data: TokenCustodyRotation) => Promise<ITokenCustodyView | null>;
    deleteTokenCustody: (query: { tokenKeyHash: string }) => Promise<{ deletedCount: number }>;
    deleteTokenCustodiesByUser: (query: {
      userId: string;
      tenantId?: string;
    }) => Promise<{ deletedCount: number }>;
  };
  logger: Pick<OpenIDLogger, 'warn' | 'debug' | 'info'>;
  /**
   * The already-resolved fallback refresh lifetime in milliseconds, used only for the branch where
   * the IdP's token response carries no refresh-token expiry. The caller resolves
   * `REFRESH_TOKEN_EXPIRY` and passes the number; the service reads no environment variable and no
   * configuration of its own, so a test supplies it like any other dependency.
   */
  fallbackRefreshTtlMs: number;
  now?: () => number;
}

export interface TokenCustodyService {
  /**
   * Mints a key, seals the tokens, writes the record. Returns the cookie value and the `expiresAt`
   * it computed from the token set, which is also the cookie's `expires`.
   */
  createCustody: (args: {
    tokens: CustodyTokenPayload;
    identity: TokenCustodyIdentity;
  }) => Promise<{ tokenKey: string; tokenKeyHash: string; expiresAt: Date }>;

  /**
   * Opens the record a request's cookie points at. Reads by hash alone and compares the record's
   * own `tenantId` against `expectedTenantId` after the read: `undefined` makes no tenant check
   * (an unauthenticated refresh with no trusted tenant), `null` requires the record to carry no
   * tenant, a string must equal the record's tenant.
   */
  openCustody: (args: {
    tokenKey: Buffer;
    expectedUserId?: string;
    expectedTenantId?: string | null;
  }) => Promise<OpenIDCustodyContext | null>;

  /**
   * Existence-and-identity check for the file-authorization paths and the Graph pre-send recheck:
   * same expiry predicate and the same post-read user and tenant comparison as `openCustody`, no
   * AEAD, no key material. This is the revocation check.
   */
  custodyExists: (args: {
    tokenKeyHash: string;
    expectedUserId?: string;
    expectedTenantId?: string | null;
  }) => Promise<boolean>;

  /**
   * Re-seals under the SAME key; compare-and-set on `rotationCounter`. Recomputes `expiresAt` from
   * the new token set and returns it, so the caller re-issues the cookie with the record's value
   * rather than deriving one.
   *
   * `applied` is a fresh rotation this call wrote; `superseded` is a lost race adopted from the
   * winner's record. `gone` means the compare-and-set matched nothing AND the reload found no live
   * record: the session was deleted (logout, ban) while this request worked, and the caller must
   * fail closed rather than fall back to the pre-rotation context.
   */
  rotateCustody: (args: {
    context: OpenIDCustodyContext;
    tokens: CustodyTokenPayload;
  }) => Promise<
    | { outcome: 'applied' | 'superseded'; context: OpenIDCustodyContext; expiresAt: Date }
    | { outcome: 'gone' }
  >;

  /** Re-reads after an `invalid_grant`, in place of the removed bridge lookup. */
  reloadAfterInvalidGrant: (args: {
    context: OpenIDCustodyContext;
  }) => Promise<OpenIDCustodyContext | null>;

  deleteCustody: (args: { tokenKeyHash: string }) => Promise<void>;
  deleteAllForUser: (args: { userId: string; tenantId?: string }) => Promise<void>;
}

/**
 * The single place the record lifetime rule lives. Computes a custody record's absolute
 * `expiresAt` from a token set and the local time that token set was received, and nothing else —
 * no previously stored `expiresAt` is ever an input, so no absolute value is carried forward
 * across a rotation.
 *
 * When the response carries a refresh-token expiry, the base is that expiry; otherwise the base is
 * `receivedAt + fallbackRefreshTtlMs`. The access-token expiry only ever raises the base through a
 * `max`: when it is absent the term drops out entirely rather than being defaulted, so the result
 * is `>=` every expiry the response stated and `>= receivedAt` whenever the fallback branch applies.
 *
 * Unit note: `accessTokenExpiresAt` and `refreshTokenExpiresAt` are IdP-supplied UNIX *seconds* —
 * the unit `setOpenIDAuthTokens` and the rotation payload builder store — so both are converted to
 * milliseconds here before they enter the `max`. Only `receivedAt + fallbackRefreshTtlMs` is
 * already milliseconds and is used as-is. The result is a millisecond `Date`, and the stored
 * numeric columns keep their seconds unit untouched.
 */
export function resolveRecordExpiry(
  tokens: CustodyTokenPayload,
  receivedAt: number,
  fallbackRefreshTtlMs: number,
): Date {
  const base =
    tokens.refreshTokenExpiresAt !== undefined
      ? tokens.refreshTokenExpiresAt * 1000
      : receivedAt + fallbackRefreshTtlMs;

  if (tokens.accessTokenExpiresAt === undefined) {
    return new Date(base);
  }

  return new Date(Math.max(base, tokens.accessTokenExpiresAt * 1000));
}

/**
 * Constructs the custody service from its injected dependencies. The service is the only component
 * that touches `tokencustodies` and the only one that holds an opened token set; it carries no app
 * singleton and no process state, so it is constructible in a test with a fixed clock.
 */
export function createTokenCustodyService(deps: TokenCustodyDeps): TokenCustodyService {
  const { db, fallbackRefreshTtlMs } = deps;
  const now = deps.now ?? (() => Date.now());

  /**
   * The post-read cross-tenant guard. `expected` is what the caller knows: `undefined` means the
   * caller knows no tenant (an unauthenticated refresh without a trusted `X-Tenant-Id`), so no
   * comparison is made; `null` means the subject has no tenant, so the record must carry none; a
   * string must equal the record's stored tenant. `recordTenantId` is the record's own column
   * (absent → `undefined`). A record copied onto another tenant by a database editor is rejected
   * here, and would also fail to open because the AAD is built from the record's stored columns.
   */
  function tenantMatches(expected: string | null | undefined, recordTenantId?: string): boolean {
    if (expected === undefined) {
      return true;
    }
    if (expected === null) {
      return recordTenantId == null;
    }
    return recordTenantId === expected;
  }

  /**
   * Mints one token key, computes its hash, seals the token set under the AAD for that hash and
   * identity, and writes exactly one custody record with `rotationCounter` 0. The record's
   * `expiresAt` comes from `resolveRecordExpiry` against the mint time, and that same value is
   * returned as the cookie's `expires` — one value, two uses, no second computation.
   *
   * The key exists only in the returned value: it is written to no record, no flight, no session,
   * no log and no process-level state.
   */
  async function createCustody(args: {
    tokens: CustodyTokenPayload;
    identity: TokenCustodyIdentity;
  }): Promise<{ tokenKey: string; tokenKeyHash: string; expiresAt: Date }> {
    const { tokens, identity } = args;

    const tokenKey = generateTokenKey();
    /** `generateTokenKey` produces a valid 43-char base64url string, so this never returns null. */
    const key = parseTokenKey(tokenKey) as Buffer;
    const tokenKeyHash = hashTokenKey(key);

    const receivedAt = now();
    const expiresAt = resolveRecordExpiry(tokens, receivedAt, fallbackRefreshTtlMs);
    const sealedTokens = sealTokens(key, tokens, tokenKeyHash, identity);

    await db.upsertTokenCustody({
      tokenKeyHash,
      sealedTokens,
      userId: identity.userId,
      tenantId: identity.tenantId,
      openidIssuer: identity.openidIssuer,
      openidSubject: identity.openidSubject,
      rotationCounter: 0,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      lastRefreshedAt: receivedAt,
      expiresAt,
    });

    return { tokenKey, tokenKeyHash, expiresAt };
  }

  /**
   * Opens the one record a request's cookie points at. Reads by hash under the tenant filter (which
   * already excludes an expired record), fails closed on an identity mismatch, and treats a
   * `CustodyOpenError` as an unopenable record. Every failure returns null so the caller answers
   * `OPENID_SESSION_MISSING`; no branch deletes or writes a record, so a wrong or forged key cannot
   * destroy a session, and no branch returns a token set that did not pass GCM verification.
   */
  async function openCustody(args: {
    tokenKey: Buffer;
    expectedUserId?: string;
    expectedTenantId?: string | null;
  }): Promise<OpenIDCustodyContext | null> {
    const { tokenKey, expectedUserId, expectedTenantId } = args;

    const tokenKeyHash = hashTokenKey(tokenKey);
    const record = await db.findTokenCustody({ tokenKeyHash });

    if (record === null) {
      deps.logger.debug('[openCustody] custody record absent or expired');
      return null;
    }

    if (expectedUserId !== undefined && record.userId !== expectedUserId) {
      deps.logger.warn('[openCustody] custody identity mismatch');
      return null;
    }

    if (!tenantMatches(expectedTenantId, record.tenantId)) {
      deps.logger.warn('[openCustody] custody tenant mismatch');
      return null;
    }

    const identity: TokenCustodyIdentity = {
      userId: record.userId,
      tenantId: record.tenantId,
      openidIssuer: record.openidIssuer,
      openidSubject: record.openidSubject,
    };

    let tokens: CustodyTokenPayload;
    try {
      tokens = openTokens(tokenKey, record.sealedTokens, tokenKeyHash, identity);
    } catch (error) {
      if (error instanceof CustodyOpenError) {
        deps.logger.warn('[openCustody] custody record failed to open', {
          reason: error.reason,
          tokenKeyHash,
        });
        return null;
      }
      throw error;
    }

    return {
      tokens,
      identity,
      tokenKeyHash,
      rotationCounter: record.rotationCounter,
      recordExpiresAt: record.expiresAt,
      tokenKey,
    };
  }

  /**
   * The existence-and-identity check behind `verifyCustodyBinding`, for the file-authorization
   * paths. Performs exactly one projected read — `findTokenCustodyMeta`, which never returns
   * `sealedTokens` — under the same `expiresAt > now` and tenant predicates as `openCustody`, so a
   * revoked, logged-out or expired record reads as absent. No AEAD, no key material, no record
   * mutation: it opens nothing and writes nothing, so a forged cookie cannot revoke a live session.
   * Returns false when no live record exists for the hash within the tenant, or when the record's
   * `userId` does not match `expectedUserId`; true otherwise.
   */
  async function custodyExists(args: {
    tokenKeyHash: string;
    expectedUserId?: string;
    expectedTenantId?: string | null;
  }): Promise<boolean> {
    const { tokenKeyHash, expectedUserId, expectedTenantId } = args;
    const record = await db.findTokenCustodyMeta({ tokenKeyHash });
    if (record === null) {
      return false;
    }
    if (expectedUserId !== undefined && record.userId !== expectedUserId) {
      return false;
    }
    if (!tenantMatches(expectedTenantId, record.tenantId)) {
      deps.logger.warn('[custodyExists] custody tenant mismatch');
      return false;
    }
    return true;
  }

  /**
   * Re-seals the new token set under the SAME key, hash and identity the context was opened with,
   * then runs one compare-and-set on the context's `rotationCounter`. `expiresAt` is recomputed by
   * `resolveRecordExpiry` from the new response at its receipt time — the stored value is never an
   * input, so it may legitimately land earlier than it was — and the value the record now carries
   * is returned so the caller re-issues the cookie with the record's `expires` rather than a second
   * computation.
   *
   * A null compare-and-set means either a concurrent writer advanced the counter or the record is
   * gone. The reload tells them apart: a live record is a lost race (`superseded`) whose context is
   * authoritative for both the token set and the lifetime, adopted with no IdP grant, no retry and
   * no other write; no live record means the session was deleted (logout, ban) or expired while
   * this request worked, reported as `gone` so the caller fails closed rather than reviving the
   * pre-rotation context. The locally computed `expiresAt` is discarded in both cases. A store
   * error rejects with the underlying error rather than reporting a success, and no fallback copy
   * is written anywhere.
   */
  async function rotateCustody(args: {
    context: OpenIDCustodyContext;
    tokens: CustodyTokenPayload;
  }): Promise<
    | { outcome: 'applied' | 'superseded'; context: OpenIDCustodyContext; expiresAt: Date }
    | { outcome: 'gone' }
  > {
    const { context, tokens } = args;

    const receivedAt = now();
    const expiresAt = resolveRecordExpiry(tokens, receivedAt, fallbackRefreshTtlMs);
    const sealedTokens = sealTokens(
      context.tokenKey,
      tokens,
      context.tokenKeyHash,
      context.identity,
    );

    const updated = await db.updateTokenCustodyIfCurrent({
      tokenKeyHash: context.tokenKeyHash,
      expectedCounter: context.rotationCounter,
      sealedTokens,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      lastRefreshedAt: receivedAt,
      expiresAt,
    });

    if (updated === null) {
      const fresh = await reloadCustody(context);
      if (fresh === null) {
        deps.logger.info('[rotateCustody] custody record gone during rotation; failing closed');
        return { outcome: 'gone' };
      }
      deps.logger.info('[rotateCustody] custody rotation superseded; adopting the winner');
      return { outcome: 'superseded', context: fresh, expiresAt: fresh.recordExpiresAt };
    }

    return {
      outcome: 'applied',
      context: {
        ...context,
        tokens,
        rotationCounter: updated.rotationCounter,
        recordExpiresAt: updated.expiresAt,
      },
      expiresAt: updated.expiresAt,
    };
  }

  /**
   * The reload body, reused after a rotation loses the compare-and-set and after an `invalid_grant`.
   * One read by the context's hash, opened with the context's key without re-reading the cookie.
   * Returns null on an absent, expired or unopenable record without deleting anything, and carries
   * the read record's `expiresAt` as the reloaded context's `recordExpiresAt`.
   */
  async function reloadCustody(
    context: OpenIDCustodyContext,
  ): Promise<OpenIDCustodyContext | null> {
    const record = await db.findTokenCustody({ tokenKeyHash: context.tokenKeyHash });

    if (record === null) {
      deps.logger.debug('[reloadCustody] custody record absent or expired');
      return null;
    }

    const identity: TokenCustodyIdentity = {
      userId: record.userId,
      tenantId: record.tenantId,
      openidIssuer: record.openidIssuer,
      openidSubject: record.openidSubject,
    };

    let tokens: CustodyTokenPayload;
    try {
      tokens = openTokens(context.tokenKey, record.sealedTokens, context.tokenKeyHash, identity);
    } catch (error) {
      if (error instanceof CustodyOpenError) {
        deps.logger.warn('[reloadCustody] custody record failed to open', {
          reason: error.reason,
          tokenKeyHash: context.tokenKeyHash,
        });
        return null;
      }
      throw error;
    }

    return {
      ...context,
      tokens,
      identity,
      rotationCounter: record.rotationCounter,
      recordExpiresAt: record.expiresAt,
    };
  }

  /**
   * Re-reads the record after an `invalid_grant`, in place of the removed bridge lookup: one read by
   * the context's hash, opened with the context's key. Returns null on an absent, expired or
   * unopenable record without deleting anything.
   */
  function reloadAfterInvalidGrant(args: {
    context: OpenIDCustodyContext;
  }): Promise<OpenIDCustodyContext | null> {
    return reloadCustody(args.context);
  }

  /**
   * Removes at most the one custody record with the given token key hash. Delegates to
   * `deleteTokenCustody`, which removes 0 or 1 records; the returned count is discarded, so a hash
   * that matches nothing resolves without error rather than signalling a failure. Deletes by hash
   * alone — no tenant filter — because the hash already identifies exactly one record.
   */
  async function deleteCustody(args: { tokenKeyHash: string }): Promise<void> {
    await db.deleteTokenCustody({ tokenKeyHash: args.tokenKeyHash });
  }

  /**
   * Removes exactly the custody records for one `userId` under the tenant filter, leaving other
   * users and other tenants untouched. Delegates to `deleteTokenCustodiesByUser`; the removed count
   * is discarded, so a `userId`/`tenantId` pair that matches nothing resolves without error. This
   * is the custody store counterpart to `deleteAllUserSessions`, called on logout, ban and account
   * deletion.
   */
  async function deleteAllForUser(args: { userId: string; tenantId?: string }): Promise<void> {
    await db.deleteTokenCustodiesByUser({ userId: args.userId, tenantId: args.tenantId });
  }

  return {
    createCustody,
    openCustody,
    custodyExists,
    rotateCustody,
    reloadAfterInvalidGrant,
    deleteCustody,
    deleteAllForUser,
  };
}
