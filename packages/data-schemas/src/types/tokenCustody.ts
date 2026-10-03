import type { Document } from 'mongoose';

export interface ITokenCustody extends Document {
  /** sha256(token key), base64url. The lookup key. Unique. */
  tokenKeyHash: string;
  /** 'kc1:<iv>:<tag>:<ciphertext>' — AES-256-GCM over the serialized token set. */
  sealedTokens: string;
  /** Identity the blob is bound to; also the AEAD associated data. */
  userId: string;
  tenantId?: string;
  openidIssuer?: string;
  openidSubject?: string;
  /** Monotonic; the compare-and-set guard for rotation. */
  rotationCounter: number;
  /** Non-secret metadata readable without the key, for cheap staleness checks. */
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
  lastRefreshedAt: number;
  createdAt: Date;
  updatedAt: Date;
  /** TTL anchor; recomputed from the new token response on every successful rotation. */
  expiresAt: Date;
}

/**
 * A plain, storage-engine-agnostic view of a custody record. The method set takes and returns this
 * shape rather than the Mongoose document, so no `Document`, `FilterQuery` or `Types.ObjectId`
 * reaches a caller. Mirrors {@link ITokenCustody} without extending `Document`.
 */
export interface ITokenCustodyView {
  tokenKeyHash: string;
  sealedTokens: string;
  userId: string;
  tenantId?: string;
  openidIssuer?: string;
  openidSubject?: string;
  rotationCounter: number;
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
  lastRefreshedAt: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

/** The identity a sealed blob is bound to; the AEAD associated-data columns. */
export interface TokenCustodyIdentity {
  userId: string;
  tenantId?: string;
  openidIssuer?: string;
  openidSubject?: string;
}

/**
 * Input to `upsertTokenCustody`. `expiresAt` is the caller-derived record expiry, written as
 * given: the store derives no lifetime of its own and applies no duration to the write time.
 */
export interface TokenCustodyUpsert {
  tokenKeyHash: string;
  sealedTokens: string;
  userId: string;
  tenantId?: string;
  openidIssuer?: string;
  openidSubject?: string;
  rotationCounter: number;
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
  lastRefreshedAt: number;
  expiresAt: Date;
}

/**
 * Input to `updateTokenCustodyIfCurrent`. The compare-and-set matches on `expectedCounter`,
 * increments `rotationCounter` by exactly 1, and applies the five carried fields.
 */
export interface TokenCustodyRotation {
  tokenKeyHash: string;
  expectedCounter: number;
  sealedTokens: string;
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
  lastRefreshedAt: number;
  expiresAt: Date;
}

/**
 * Reader query: a lookup by hash alone. The unique `tokenKeyHash` index identifies at most one
 * record, and the record's own `tenantId` is returned for the caller to compare, so a tenant is not
 * a lookup input.
 */
export interface TokenCustodyQuery {
  tokenKeyHash: string;
}

/**
 * The projected result of `findTokenCustodyMeta`: the record's identity columns needed for the
 * file-authorization and existence checks, never the sealed blob. `tenantId` is present only when
 * the record carries one, so the caller can tell "no tenant" from a tenant value.
 */
export interface TokenCustodyMeta {
  userId: string;
  tenantId?: string;
}

/** `deleteTokenCustodiesByUser` query: every record for a user under the tenant filter. */
export interface TokenCustodyUserQuery {
  userId: string;
  tenantId?: string;
}
