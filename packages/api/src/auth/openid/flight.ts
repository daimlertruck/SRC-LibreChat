import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  AuthIdentityContext,
  LeaseContext,
  OpenIDLogger,
  OpenIDClaims,
  OpenIDTokenSet,
  RefreshFlightAcquireResult,
  RefreshFlightRecord,
  RefreshKeyInput,
} from './types';
import {
  OPENID_REFRESH_CANCELLED_BEFORE_GRANT,
  createOpenIDRefreshOwnershipError,
  isOpenIDRefreshOwnershipError,
  toOpenIDLogArgument,
} from './errors';
import {
  sealTokens,
  openTokens,
  CustodyOpenError,
  type CustodyTokenPayload,
  type TokenCustodyIdentity,
} from '~/auth/custody/aead';
import { createOpenIDRefreshIdentityTuple, serializeAuthIdentityTuple } from '~/utils/identity';
import { OPENID_EXPIRY_BUFFER_SECONDS } from '~/oauth/expiry';

/**
 * The per-request seal the flight store uses to protect a completed refresh result: the flight
 * owner's token key (the 32 raw AEAD bytes), bound to the same token key hash and identity as the
 * custody record. Every request in one browser session carries the same token key, so a waiting
 * worker opens what the owner sealed, and no plaintext token set is ever written to
 * `openidrefreshflights`.
 */
export interface CustodyFlightSeal {
  aeadKey: Buffer;
  tokenKeyHash: string;
  identity: TokenCustodyIdentity;
}

const DEFAULT_FLIGHT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_LOCK_TTL_MS = 30 * 1000;
const DEFAULT_WAIT_TIMEOUT_MS = DEFAULT_FLIGHT_TTL_MS;
const DEFAULT_WAIT_INTERVAL_MS = 100;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10 * 1000;
const INTERNAL_PREDECESSOR_REFRESH_TOKEN_FIELD = '__predecessorRefreshToken';
const INTERNAL_PREDECESSOR_ACCESS_TOKEN_FIELD = '__predecessorAccessToken';
const INTERNAL_DEFERRED_PUBLICATION_FIELD = '__deferredPublication';
const INTERNAL_FLIGHT_OWNER_FIELD = '__flightOwnerId';
const INTERNAL_FLIGHT_CREATED_AT_FIELD = '__flightCreatedAt';

export interface TokenResult extends Omit<OpenIDTokenSet, 'claims'> {
  tokenset?: OpenIDTokenSet;
  claims?: OpenIDClaims | (() => OpenIDClaims);
  openidIssuer?: string;
  __predecessorRefreshToken?: string;
  __predecessorAccessToken?: string;
  __deferredPublication?: boolean;
  __flightOwnerId?: string;
  __flightCreatedAt?: number;
  predecessorAccessToken?: string;
  acceptedIdentity?: AuthIdentityContext;
}

interface FlightAcquireData {
  key: string;
  ownerId: string;
  lockExpiresAt: Date;
  expiresAt: Date;
}

interface FlightOwnerData {
  key: string;
  ownerId: string;
  expiresAt: Date;
}

interface FlightCompleteData extends FlightOwnerData {
  sealedResult: string;
}

interface FlightRenewData extends FlightOwnerData {
  lockExpiresAt: Date;
}

interface FlightFailData extends FlightOwnerData {
  errorMessage: string;
}

export interface OpenIDRefreshFlightService {
  acquireOpenIDRefreshFlight: (args: {
    key?: string | null;
    ownerId?: string;
    ttl?: number;
    lockTtl?: number;
  }) => Promise<RefreshFlightAcquireResult>;
  completeOpenIDRefreshFlight: (args: {
    key?: string | null;
    ownerId?: string;
    tokens?: TokenResult | null;
    seal: CustodyFlightSeal;
    ttl?: number;
    onWriteStart?: () => void;
  }) => Promise<RefreshFlightRecord | null>;
  createOpenIDRefreshFlightKey: (input: RefreshKeyInput) => string | null;
  failOpenIDRefreshFlight: (args: {
    key?: string | null;
    ownerId?: string;
    error?: Error | { message?: string } | null;
    ttl?: number;
  }) => Promise<RefreshFlightRecord | null>;
  renewOpenIDRefreshFlight: (args: {
    key?: string | null;
    ownerId?: string;
    lockTtl?: number;
    ttl?: number;
  }) => Promise<RefreshFlightRecord | null>;
  assertOpenIDRefreshFlightAvailable: (args: {
    key?: string | null;
    ownerId?: string;
  }) => Promise<RefreshFlightRecord | boolean>;
  revokeOpenIDRefreshFlights: (args: {
    keys?: Array<string | null | undefined>;
    seal: CustodyFlightSeal;
    ttl?: number;
  }) => Promise<Array<TokenResult | null>>;
  waitForOpenIDRefreshFlight: (args: {
    key?: string | null;
    seal: CustodyFlightSeal;
    timeoutMs?: number;
    intervalMs?: number;
    requirePublication?: boolean;
    signal?: AbortSignal;
  }) => Promise<TokenResult | null>;
  withOpenIDRefreshFlightLease: <T>(args: {
    key?: string | null;
    ownerId?: string;
    operation: (context: LeaseContext) => Promise<T>;
    heartbeatInterval?: number;
    lockTtl?: number;
    ttl?: number;
  }) => Promise<T>;
  __internals: {
    sha256: (value: string) => string;
    readCompletedFlight: (
      flight: RefreshFlightRecord | null,
      seal: CustodyFlightSeal,
    ) => Promise<TokenResult | null>;
    DEFAULT_FLIGHT_TTL_MS: number;
    DEFAULT_LOCK_TTL_MS: number;
    DEFAULT_WAIT_TIMEOUT_MS: number;
    DEFAULT_WAIT_INTERVAL_MS: number;
    DEFAULT_HEARTBEAT_INTERVAL_MS: number;
    INTERNAL_PREDECESSOR_REFRESH_TOKEN_FIELD: string;
    getRenewedWaitDeadline: (deadline: number, flight: RefreshFlightRecord | null) => number;
  };
}

export interface OpenIDRefreshFlightDeps {
  db: {
    acquireOpenIDRefreshFlight: (
      data: FlightAcquireData,
    ) => Promise<{ acquired: boolean; flight?: RefreshFlightRecord | null }>;
    completeOpenIDRefreshFlight: (data: FlightCompleteData) => Promise<RefreshFlightRecord | null>;
    renewOpenIDRefreshFlight: (data: FlightRenewData) => Promise<RefreshFlightRecord | null>;
    failOpenIDRefreshFlight: (data: FlightFailData) => Promise<RefreshFlightRecord | null>;
    revokeOpenIDRefreshFlight: (data: {
      key: string;
      expiresAt: Date;
    }) => Promise<RefreshFlightRecord | null>;
    findOpenIDRefreshFlight: (data: { key: string }) => Promise<RefreshFlightRecord | null>;
  };
  logger: Pick<OpenIDLogger, 'warn'>;
}

export function createOpenIDRefreshFlightService({
  db,
  logger,
}: OpenIDRefreshFlightDeps): OpenIDRefreshFlightService {
  const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

  /**
   * Seals a flight's completed token set under the owner's token key with the custody AEAD. The
   * serialized `TokenResult`, including the coordination markers already promoted to own fields,
   * is sealed whole as an opaque payload; the AAD binds the blob to the owner's token key hash and
   * identity.
   */
  function sealFlightResult(tokens: TokenResult, seal: CustodyFlightSeal): string {
    return sealTokens(
      seal.aeadKey,
      tokens as unknown as CustodyTokenPayload,
      seal.tokenKeyHash,
      seal.identity,
    );
  }

  /**
   * Opens a `sealedResult` blob with the waiting worker's own token key. A `CustodyOpenError`
   * propagates so the caller uses no token set from that flight and leaves the custody record in
   * place.
   */
  function openFlightResult(sealed: string, seal: CustodyFlightSeal): TokenResult {
    return openTokens(
      seal.aeadKey,
      sealed,
      seal.tokenKeyHash,
      seal.identity,
    ) as unknown as TokenResult;
  }

  function createOpenIDRefreshFlightKey({
    req,
    user,
    refreshToken,
    identityContext,
  }: RefreshKeyInput): string | null {
    const identitySource = identityContext
      ? {
          id: identityContext.appUserId,
          openidId: identityContext.openidSubject,
          tenantId: identityContext.tenantId,
          openidIssuer: identityContext.openidIssuer,
        }
      : user;
    const tuple = createOpenIDRefreshIdentityTuple({
      user: identitySource,
      requestUser: req?.user,
    });
    if (!tuple || !refreshToken) return null;
    return sha256([serializeAuthIdentityTuple(tuple), sha256(refreshToken)].join('\x1f'));
  }

  async function acquireOpenIDRefreshFlight({
    key,
    ownerId = crypto.randomUUID(),
    ttl = DEFAULT_FLIGHT_TTL_MS,
    lockTtl = DEFAULT_LOCK_TTL_MS,
  }: {
    key?: string | null;
    ownerId?: string;
    ttl?: number;
    lockTtl?: number;
  }): Promise<RefreshFlightAcquireResult> {
    if (!key) return { acquired: true, key: null, ownerId, flight: null };
    const acquired = await db.acquireOpenIDRefreshFlight({
      key,
      ownerId,
      lockExpiresAt: new Date(Date.now() + lockTtl),
      expiresAt: new Date(Date.now() + ttl),
    });
    return { ...acquired, key, ownerId };
  }

  async function completeOpenIDRefreshFlight({
    key,
    ownerId,
    tokens,
    seal,
    ttl = DEFAULT_FLIGHT_TTL_MS,
    onWriteStart,
  }: {
    key?: string | null;
    ownerId?: string;
    tokens?: TokenResult | null;
    seal: CustodyFlightSeal;
    ttl?: number;
    onWriteStart?: () => void;
  }): Promise<RefreshFlightRecord | null> {
    if (!key || !ownerId || !tokens) return null;
    const serializedTokens: TokenResult = { ...tokens };
    if (tokens.__predecessorRefreshToken) {
      serializedTokens.__predecessorRefreshToken = tokens.__predecessorRefreshToken;
    }
    if (tokens.__predecessorAccessToken) {
      serializedTokens.__predecessorAccessToken = tokens.__predecessorAccessToken;
    }
    if (tokens.__deferredPublication) {
      serializedTokens.__deferredPublication = true;
    }
    const accessTokenExpiresAt = Number(tokens.expires_at) * 1000;
    const usableTokenTtl = Number.isFinite(accessTokenExpiresAt)
      ? Math.max(1, accessTokenExpiresAt - Date.now() - OPENID_EXPIRY_BUFFER_SECONDS * 1000)
      : ttl;
    const sealedResult = sealFlightResult(serializedTokens, seal);
    onWriteStart?.();
    return db.completeOpenIDRefreshFlight({
      key,
      ownerId,
      sealedResult,
      expiresAt: new Date(Date.now() + Math.min(ttl, usableTokenTtl)),
    });
  }

  async function renewOpenIDRefreshFlight({
    key,
    ownerId,
    lockTtl = DEFAULT_LOCK_TTL_MS,
    ttl = DEFAULT_FLIGHT_TTL_MS,
  }: {
    key?: string | null;
    ownerId?: string;
    lockTtl?: number;
    ttl?: number;
  }): Promise<RefreshFlightRecord | null> {
    if (!key || !ownerId) return null;
    return db.renewOpenIDRefreshFlight({
      key,
      ownerId,
      lockExpiresAt: new Date(Date.now() + lockTtl),
      expiresAt: new Date(Date.now() + ttl),
    });
  }

  async function assertOpenIDRefreshFlightAvailable({
    key,
    ownerId,
  }: {
    key?: string | null;
    ownerId?: string;
  }): Promise<RefreshFlightRecord | boolean> {
    if (!key) return true;
    const flight = await db.findOpenIDRefreshFlight({ key });
    if (
      flight?.status === 'completed' &&
      ownerId &&
      flight.ownerId === ownerId &&
      !flight.revocationRequestedAt
    ) {
      return flight;
    }
    throw createOpenIDRefreshOwnershipError(
      'OpenID refresh result is no longer available for publication',
    );
  }

  async function withOpenIDRefreshFlightLease<T>({
    key,
    ownerId,
    operation,
    heartbeatInterval = DEFAULT_HEARTBEAT_INTERVAL_MS,
    lockTtl = DEFAULT_LOCK_TTL_MS,
    ttl = DEFAULT_FLIGHT_TTL_MS,
  }: {
    key?: string | null;
    ownerId?: string;
    operation: (context: LeaseContext) => Promise<T>;
    heartbeatInterval?: number;
    lockTtl?: number;
    ttl?: number;
  }): Promise<T> {
    if (!key || !ownerId)
      return operation({ assertLeaseOwned: async () => true, markLeaseSettled: () => {} });
    let renewalPromise: Promise<RefreshFlightRecord | null> | null = null;
    let ownershipLost = false;
    let settled = false;
    const ownershipError = () =>
      createOpenIDRefreshOwnershipError(
        'OpenID refresh coordination ownership was lost before completion',
      );
    const renewLease = async () => {
      if (ownershipLost) throw ownershipError();
      if (!renewalPromise)
        renewalPromise = renewOpenIDRefreshFlight({ key, ownerId, lockTtl, ttl }).finally(() => {
          renewalPromise = null;
        });
      const flight = await renewalPromise;
      if (!flight) {
        if (settled) return null;
        const terminalFlight = await db.findOpenIDRefreshFlight({ key });
        if (terminalFlight?.ownerId === ownerId && terminalFlight?.status === 'completed') {
          return terminalFlight;
        }
        ownershipLost = true;
        throw ownershipError();
      }
      return flight;
    };
    const heartbeat = setInterval(() => {
      renewLease().catch((error) =>
        logger.warn('[OpenIDRefreshFlight] Refresh flight lease renewal failed', {
          key,
          error: error?.message,
        }),
      );
    }, heartbeatInterval);
    heartbeat.unref?.();
    let result: T;
    try {
      result = await operation({
        assertLeaseOwned: renewLease,
        markLeaseSettled: () => {
          settled = true;
        },
      });
      if (ownershipLost) throw ownershipError();
    } catch (error) {
      clearInterval(heartbeat);
      if (renewalPromise) {
        try {
          await renewalPromise;
        } catch (cleanupError) {
          logger.warn('[OpenIDRefreshFlight] Lease cleanup also failed after the operation', {
            key,
            error: toOpenIDLogArgument(cleanupError),
          });
        }
      }
      throw error;
    }
    clearInterval(heartbeat);
    if (renewalPromise) {
      try {
        await renewalPromise;
      } catch (error) {
        if (!settled || isOpenIDRefreshOwnershipError(error)) {
          throw error;
        }
      }
    }
    if (ownershipLost) {
      throw ownershipError();
    }
    return result;
  }

  async function failOpenIDRefreshFlight({
    key,
    ownerId,
    error,
    ttl = DEFAULT_FLIGHT_TTL_MS,
  }: {
    key?: string | null;
    ownerId?: string;
    error?: Error | { message?: string } | null;
    ttl?: number;
  }): Promise<RefreshFlightRecord | null> {
    if (!key || !ownerId) return null;
    const errorMessage =
      typeof error?.message === 'string' && error.message ? error.message : 'OpenID refresh failed';
    return db.failOpenIDRefreshFlight({
      key,
      ownerId,
      errorMessage,
      expiresAt: new Date(Date.now() + ttl),
    });
  }

  async function revokeOpenIDRefreshFlights({
    keys,
    seal,
    ttl = DEFAULT_FLIGHT_TTL_MS,
  }: {
    keys?: Array<string | null | undefined>;
    seal: CustodyFlightSeal;
    ttl?: number;
  }): Promise<Array<TokenResult | null>> {
    const uniqueKeys = [...new Set<string>((keys ?? []).filter((key): key is string => !!key))];
    if (uniqueKeys.length === 0) return [];
    const expiresAt = new Date(Date.now() + ttl);
    const revoked = await Promise.all(
      uniqueKeys.map((key) => db.revokeOpenIDRefreshFlight({ key, expiresAt })),
    );
    return revoked.map((flight) => {
      if (!flight?.sealedResult) return null;
      try {
        return restoreInternalTokenFields(openFlightResult(flight.sealedResult, seal));
      } catch (error) {
        if (error instanceof CustodyOpenError) {
          logger.warn('[OpenIDRefreshFlight] Revoked flight result failed to open', {
            reason: error.reason,
          });
          return null;
        }
        throw error;
      }
    });
  }

  function restoreInternalTokenFields(tokens: TokenResult): TokenResult {
    for (const [field, value] of [
      [INTERNAL_PREDECESSOR_REFRESH_TOKEN_FIELD, tokens.__predecessorRefreshToken],
      [INTERNAL_PREDECESSOR_ACCESS_TOKEN_FIELD, tokens.__predecessorAccessToken],
      [INTERNAL_DEFERRED_PUBLICATION_FIELD, tokens.__deferredPublication],
    ] as const) {
      if (value) {
        delete tokens[field];
        Object.defineProperty(tokens, field, { value, enumerable: false, configurable: true });
      }
    }
    return tokens;
  }

  function attachFlightOwner(
    tokens: TokenResult,
    ownerId?: string,
    createdAt?: Date | string,
  ): TokenResult {
    if (!ownerId) return tokens;
    Object.defineProperty(tokens, INTERNAL_FLIGHT_OWNER_FIELD, {
      value: ownerId,
      enumerable: false,
      configurable: true,
    });
    const createdAtMs = createdAt ? new Date(createdAt).getTime() : NaN;
    if (Number.isFinite(createdAtMs)) {
      Object.defineProperty(tokens, INTERNAL_FLIGHT_CREATED_AT_FIELD, {
        value: createdAtMs,
        enumerable: false,
        configurable: true,
      });
    }
    return tokens;
  }

  async function readCompletedFlight(
    flight: RefreshFlightRecord | null,
    seal: CustodyFlightSeal,
  ): Promise<TokenResult | null> {
    if (!flight) return null;
    if (
      flight.status === 'failed' &&
      flight.errorMessage === OPENID_REFRESH_CANCELLED_BEFORE_GRANT
    ) {
      throw Object.assign(new Error('OpenID refresh owner stopped before starting the grant'), {
        status: 503,
        retryable: true,
      });
    }
    if (flight.status === 'revoked')
      throw new Error(flight.errorMessage || 'OpenID refresh was revoked by logout');
    if (flight.status === 'failed')
      throw new Error(flight.errorMessage || 'OpenID refresh failed in another worker');
    if (flight.status !== 'completed' || flight.revocationRequestedAt || !flight.sealedResult)
      return null;
    const tokens = openFlightResult(flight.sealedResult, seal);
    const accessTokenExpiresAt = Number(tokens.expires_at) * 1000;
    if (
      Number.isFinite(accessTokenExpiresAt) &&
      accessTokenExpiresAt <= Date.now() + OPENID_EXPIRY_BUFFER_SECONDS * 1000
    ) {
      return null;
    }
    return attachFlightOwner(restoreInternalTokenFields(tokens), flight.ownerId, flight.createdAt);
  }

  function getRenewedWaitDeadline(deadline: number, flight: RefreshFlightRecord | null): number {
    const renewedExpiry = flight?.expiresAt ? new Date(flight.expiresAt).getTime() : NaN;
    return Number.isFinite(renewedExpiry) ? Math.max(deadline, renewedExpiry) : deadline;
  }

  async function waitForOpenIDRefreshFlight({
    key,
    seal,
    timeoutMs,
    intervalMs = DEFAULT_WAIT_INTERVAL_MS,
    requirePublication = false,
    signal,
  }: {
    key?: string | null;
    seal: CustodyFlightSeal;
    timeoutMs?: number;
    intervalMs?: number;
    requirePublication?: boolean;
    signal?: AbortSignal;
  }): Promise<TokenResult | null> {
    signal?.throwIfAborted();
    if (!key) return null;
    const followRenewals = timeoutMs == null && !requirePublication;
    let deadline = Date.now() + (timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
    while (Date.now() <= deadline) {
      signal?.throwIfAborted();
      const flight = await db.findOpenIDRefreshFlight({ key });
      signal?.throwIfAborted();
      let completed: TokenResult | null;
      try {
        completed = await readCompletedFlight(flight, seal);
      } catch (error) {
        if (error instanceof CustodyOpenError) {
          /**
           * The waiter's token key could not open this flight's `sealedResult`. Use no token set
           * from this flight and leave the custody record in place; the caller answers
           * session-missing without touching the record.
           */
          logger.warn('[OpenIDRefreshFlight] Sealed flight result failed to open', {
            key,
            reason: error.reason,
          });
          return null;
        }
        throw error;
      }
      signal?.throwIfAborted();
      const awaitingPublication = requirePublication && completed?.__deferredPublication;
      if (completed && !awaitingPublication) return completed;
      if (flight?.status === 'completed' && !awaitingPublication) return null;
      if (!flight && !requirePublication) return null;
      if (followRenewals) {
        deadline = getRenewedWaitDeadline(deadline, flight);
      }
      try {
        await delay(intervalMs, undefined, { signal });
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
    }
    logger.warn('[OpenIDRefreshFlight] Timed out waiting for refresh flight', { key });
    return null;
  }

  return {
    acquireOpenIDRefreshFlight,
    assertOpenIDRefreshFlightAvailable,
    completeOpenIDRefreshFlight,
    createOpenIDRefreshFlightKey,
    failOpenIDRefreshFlight,
    renewOpenIDRefreshFlight,
    revokeOpenIDRefreshFlights,
    waitForOpenIDRefreshFlight,
    withOpenIDRefreshFlightLease,
    __internals: {
      sha256,
      readCompletedFlight,
      DEFAULT_FLIGHT_TTL_MS,
      DEFAULT_LOCK_TTL_MS,
      DEFAULT_WAIT_TIMEOUT_MS,
      DEFAULT_WAIT_INTERVAL_MS,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      INTERNAL_PREDECESSOR_REFRESH_TOKEN_FIELD,
      getRenewedWaitDeadline,
    },
  };
}
