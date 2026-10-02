import type {
  AuthIdentityContext,
  AuthIdentitySource,
  AuthIdentityTuple,
  LeaseAssertion,
  OIDCTokens,
  OpenIDClaims,
  OpenIDLogger,
  OpenIDRequest,
  OpenIDResponse,
  OpenIDSessionIdentitySource,
  OpenIDTokenSet,
  OpenIDUser,
  SessionOpenIDTokens,
  TokenPreference,
} from './types';
import type { OpenIDCustodyContext, TokenCustodyService } from '~/auth/custody/service';
import type { CustodyTokenPayload } from '~/auth/custody/aead';
import type { CustodyRequest } from '~/auth/custody/loader';
import { toOpenIDLogArgument } from './errors';

interface OpenIDSessionRefreshDeps {
  jwt: {
    decode: (token: string) => (Partial<OpenIDClaims> & { exp?: number }) | string | null;
    verify: (token: string, secret: string) => { id?: string; refreshTokenHash?: string } | string;
  };
  cookies: { parse: (header: string) => Record<string, string> };
  crypto: {
    createHash: (algorithm: string) => {
      update: (value: string) => { digest: (encoding: 'hex' | 'base64url') => string };
    };
  };
  openIdClient: {
    refreshTokenGrant: (
      config: object,
      refreshToken: string,
      params: Record<string, string>,
    ) => Promise<OpenIDTokenSet>;
  };
  logger: OpenIDLogger;
  defaultRefreshTokenExpiry: number;
  isEnabled: (value?: string) => boolean;
  math: (value: string | undefined, fallback: number) => number;
  createAuthIdentityContext: (args: {
    user?: AuthIdentitySource | null;
    requestUser?: AuthIdentitySource | null;
    tenantId?: string;
    openidIssuer?: string;
  }) => AuthIdentityContext;
  isOpenIDSessionIdentityMatch: (
    session: OpenIDSessionIdentitySource,
    expected: OpenIDSessionIdentitySource,
  ) => boolean;
  createOpenIDRefreshIdentityTuple: (args: {
    user?: AuthIdentitySource | null;
    requestUser?: AuthIdentitySource | null;
  }) => AuthIdentityTuple | null;
  serializeAuthIdentityTuple: (tuple: AuthIdentityTuple) => string;
  buildOpenIDRefreshParams: () => Record<string, string>;
  normalizeExpiresIn: (value?: number | string) => number | undefined;
  getOpenIdConfig: () => object;
  /**
   * Returns the process-wide token custody service (`getTokenCustodyService` in
   * `api/server/services/AuthService.js`). It is the only component that reads or writes the
   * custody store; this module and `refreshController` share the same instance. A getter rather
   * than an instance so the service is built on first use, not when this module is wired at load.
   */
  getCustody: () => TokenCustodyService;
  /**
   * Request-scoped loader that materializes and memoizes the custody context on `req.openidCustody`.
   * However many times it is called on one request, at most one custody store read occurs, and it
   * returns null (before any read) when the token key or marker cookie check fails, which the OBO
   * path turns into an `OPENID_SESSION_MISSING` rejection with no IdP call.
   */
  loadOpenIDCustody: (
    req: CustodyRequest,
    deps: { custody: TokenCustodyService; tenantId?: string },
  ) => Promise<OpenIDCustodyContext | null>;
  /**
   * Re-issues the token key cookie with the record's derived `expires`. The value is the unchanged
   * base64url token key the browser already holds (rotation never changes it), so this only
   * refreshes the cookie's expiry after a rotation, and only when headers have not been sent.
   */
  setTokenKeyCookie: (res: OpenIDResponse, tokenKey: string, expires: Date) => void;
  /** Drops the token key cookie, used when an `invalid_grant` retires the custody record. */
  clearTokenKeyCookie: (res: OpenIDResponse) => void;
}

type MarkedOIDCTokens = OIDCTokens;

interface RefreshSessionOptions {
  forceRefresh?: boolean;
  signal?: AbortSignal;
}

interface CreateOpenIDSessionTokenProviderInput {
  req?: OpenIDRequest;
  res?: OpenIDResponse;
  user?: OpenIDUser;
  tokenPreference: TokenPreference;
  identityContext?: AuthIdentityContext;
}

export interface OpenIDSessionRefreshService {
  createOpenIDSessionTokenProvider: (
    input: CreateOpenIDSessionTokenProviderInput,
  ) => (options?: { forceRefresh?: boolean; signal?: AbortSignal }) => Promise<OIDCTokens | null>;
  refreshOpenIDSession: (
    req: OpenIDRequest,
    res: OpenIDResponse | undefined,
    user: OpenIDUser,
    tokenPreference: TokenPreference,
    identityContext?: AuthIdentityContext,
    options?: RefreshSessionOptions,
  ) => Promise<MarkedOIDCTokens | null>;
  __internals: {
    UPSTREAM_TOKEN_EXPIRY_BUFFER_SECONDS: number;
    inFlightRefreshes: Map<string, Promise<MarkedOIDCTokens | null>>;
    getSingleFlightKey: (
      req: OpenIDRequest,
      user: OpenIDUser,
      identityContext?: AuthIdentityContext,
    ) => string | null;
    isLiveSessionTokenStillValid: (
      sessionTokens: SessionOpenIDTokens,
      tokenPreference: TokenPreference,
    ) => boolean;
    getAccessTokenExp: (sessionTokens: SessionOpenIDTokens) => number | null;
  };
}

/**
 * OpenID session refresh implementation. Runtime-only Express, model, and strategy dependencies
 * are supplied by the thin /api wrapper; the authentication and coordination logic lives here.
 */
export function createOpenIDSessionRefreshService(
  deps: OpenIDSessionRefreshDeps,
): OpenIDSessionRefreshService {
  const {
    jwt,
    crypto,
    openIdClient,
    logger,
    isEnabled,
    createAuthIdentityContext,
    isOpenIDSessionIdentityMatch,
    createOpenIDRefreshIdentityTuple,
    serializeAuthIdentityTuple,
    buildOpenIDRefreshParams,
    normalizeExpiresIn,
    getOpenIdConfig,
    getCustody,
    loadOpenIDCustody,
    setTokenKeyCookie,
    clearTokenKeyCookie,
  } = deps;

  /**
   * Shape of `req.session.openidTokens`. Established by `setOpenIDAuthTokens`
   * (`api/server/services/AuthService.js`) on login/refresh, mutated in place by
   * this module on inline refresh, and consumed by `refreshController` and
   * `LogoutController`. Distinct from the snake_case `OIDCTokens` type in
   * `@librechat/data-schemas` (which describes `IUser.federatedTokens` /
   * `IUser.openidTokens` — model fields, not the express-session field).
   *
   * Express-session's SessionData is open by design, so this contract lives in
   * comments rather than a TS interface; keep this and AuthService.js in sync
   * when the shape changes.
   *
   * @typedef {Object} SessionOpenIDTokens
   * @property {string} [accessToken]            — IdP access token (may be opaque).
   * @property {string} [idToken]                — IdP ID token (always JWT).
   * @property {string} [refreshToken]           — IdP refresh token.
   * @property {number} [expiresAt]              — SESSION cookie expiry (ms).
   * @property {number} [lastRefreshedAt]        — wall-clock ms of the last server-side rotation.
   * @property {string} [appUserId]              — LibreChat user id bound to these session tokens.
   * @property {string} [openidSubject]          — OpenID `sub` bound to these session tokens.
   * @property {string} [tenantId]               — tenant bound to these session tokens.
   * @property {string} [openidIssuer]           — normalized issuer bound to these session tokens.
   * @property {number} [accessTokenExpiresAt]   — access token expiry (unix seconds), captured
   *                                               from the IdP `tokenset.expires_in` so opaque
   *                                               access tokens can still be reused without
   *                                               redundant refreshes.
   * @property {string} [publicationFlightKey]  — durable publication key authorizing this state.
   * @property {string} [publicationFlightOwnerId] — exact completed generation for that key.
   */

  /**
   * Skew buffer for the upstream access-token expiry check. Mirrors
   * `OPENID_REUSE_EXPIRY_BUFFER_SECONDS` in `AuthController.js` so that a token
   * which the controller is about to rotate also triggers an inline refresh here.
   */
  const UPSTREAM_TOKEN_EXPIRY_BUFFER_SECONDS = 30;
  const IDENTITY_PART_SEPARATOR = '\x1f';

  /**
   * In-flight upstream refreshes keyed by `getSingleFlightKey(req, user, identityContext)` —
   * a composite of `tenantId:openidIssuer:subject:refreshTokenHash`.
   * See that helper for the rationale on why each component is needed; in short,
   * tenant+issuer keying prevents cross-tenant token crossover when distinct users
   * share an IdP `sub`, and refresh-token keying makes every request holding the same
   * rotating credential join the same logical grant across sessions and replicas.
   *
   * A fan-out of tool calls carrying the same expired credential coalesces into
   * one IdP refresh-token grant. Mirrors the
   * single-flight pattern in `OboTokenService.js`.
   *
   * Cross-worker convergence rests on `rotateCustody`'s compare-and-set: a worker that loses the
   * race adopts the winner's rotation with no second IdP grant.
   */
  const inFlightRefreshes = new Map<string, Promise<MarkedOIDCTokens | null>>();
  const flightSignals = new WeakMap<Promise<MarkedOIDCTokens | null>, AbortSignal>();

  /**
   * Returns the single-flight key for a refresh attempt, composed from the user's
   * tenant (if any), the IdP issuer + sub, and the current refresh token.
   * Tightening past `openidId` alone serves two purposes:
   *
   *  1. Same credential, multiple Express sessions: every holder joins one grant,
   *     so token rotation cannot admit duplicate IdP refreshes merely because an
   *     Express session expired or a request landed on another replica.
   *  2. Multi-tenant deployments where two distinct users share an IdP `sub`
   *     (different issuers, same sub): tenant + issuer disambiguates them so
   *     tokens never cross tenant boundaries via shared in-flight Promises.
   *
   * Concurrent tool calls inside the SAME session with the SAME refresh token
   * still coalesce — the common case the single-flight is designed for (a fan-out
   * of MCP tool calls in one agent run) is unaffected.
   *
   * Returns null when there's no usable identity at all; callers fall through
   * to a non-coalesced refresh, which is safe but missing the optimization.
   */
  function getSingleFlightKey(
    req: OpenIDRequest,
    user: OpenIDUser,
    identityContext?: AuthIdentityContext,
    custodyContext?: OpenIDCustodyContext | null,
  ): string | null {
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
    /**
     * Key on the rotation-invariant token key hash rather than a hash of the rotating refresh
     * token. Every request from the same browser session carries the same token key cookie, so its
     * hash is stable across IdP token rotation: a fan-out of tool calls coalesces into one IdP
     * grant, and a second worker that re-reads the custody record under the unchanged lookup key
     * finds the winner's rotation. A refresh-token hash moves on every rotation, so it could serve
     * neither purpose.
     */
    const tokenKeyHash = custodyContext?.tokenKeyHash;
    if (!tuple || !tokenKeyHash) {
      return null;
    }
    return [serializeAuthIdentityTuple(tuple), tokenKeyHash].join(IDENTITY_PART_SEPARATOR);
  }

  /**
   * Returns a short SHA-256 prefix of the single-flight key for use in logs.
   * Preserves correlation across "started" / "joined" / "completed" log events
   * for the same refresh attempt without leaking the underlying values:
   *
   *   - refresh-token hashes are still credential-derived and remain private.
   *   - openidId (the IdP `sub`) and openidIssuer are tenant/user fingerprints.
   *
   * 12 hex chars = 48 bits of entropy: ~7×10^14 distinct keys before a 50%
   * collision chance — more than enough for correlating concurrent refreshes.
   */
  function hashKeyForLogs(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
  }

  function resolveExpectedOpenIDSessionIdentity(
    req: OpenIDRequest,
    user: OpenIDUser,
    identityContext?: AuthIdentityContext,
  ): AuthIdentityContext {
    if (!identityContext) {
      return createAuthIdentityContext({
        user,
        requestUser: req?.user,
      });
    }

    return createAuthIdentityContext({
      user: {
        id: identityContext.appUserId,
        openidId: identityContext.openidSubject,
        tenantId: identityContext.tenantId,
        openidIssuer: identityContext.openidIssuer,
      },
      requestUser: user ?? req?.user,
      tenantId: identityContext.tenantId,
      openidIssuer: identityContext.openidIssuer,
    });
  }

  /**
   * Fails closed when the opened custody record's identity does not match the user the marker
   * cookie names. `openCustody` already rejects a record whose `userId` differs from the
   * marker's `id`, so a mismatch here is defense in depth against a marker that passed the loader
   * but disagrees with the request's resolved identity on subject, tenant or issuer.
   *
   * On mismatch it throws before any IdP call, and it neither deletes nor mutates the record and
   * clears no cookie — a request that fails identity binding must not be able to disturb a live
   * session's custody record or the browser's cookies.
   */
  function assertOpenIDSessionIdentityMatch(
    req: OpenIDRequest,
    user: OpenIDUser,
    identityContext: AuthIdentityContext | undefined,
    custodyContext: OpenIDCustodyContext,
  ): void {
    const recordIdentity: OpenIDSessionIdentitySource = {
      appUserId: custodyContext.identity.userId,
      openidSubject: custodyContext.identity.openidSubject,
      tenantId: custodyContext.identity.tenantId,
      openidIssuer: custodyContext.identity.openidIssuer,
    };

    const expectedIdentity = resolveExpectedOpenIDSessionIdentity(req, user, identityContext);
    if (isOpenIDSessionIdentityMatch(recordIdentity, expectedIdentity)) {
      return;
    }

    logger.warn('[OpenIDSessionRefresh] OpenID custody identity mismatch; refusing reuse', {
      userId: expectedIdentity.appUserId,
      has_record_user_id: Boolean(recordIdentity.appUserId),
      has_record_subject: Boolean(recordIdentity.openidSubject),
      has_record_issuer: Boolean(recordIdentity.openidIssuer),
    });
    throw new Error('OpenID session token identity mismatch');
  }

  function decodeJwtExp(token?: string): number | null {
    if (typeof token !== 'string' || token.length === 0) {
      return null;
    }
    try {
      const decoded = jwt.decode(token);
      if (!decoded || typeof decoded !== 'object') {
        return null;
      }
      return typeof decoded.exp === 'number' ? decoded.exp : null;
    } catch (error) {
      logger.debug(
        '[OpenIDSessionRefresh] JWT decode failed (non-fatal)',
        (error as Error)?.message,
      );
      return null;
    }
  }

  /**
   * Returns the access token's expiry in unix seconds, preferring the JWT `exp`
   * claim and falling back to the persisted `accessTokenExpiresAt` written from
   * the IdP's `tokenset.expires_in` on the previous refresh.
   *
   * The fallback exists because some IdPs (Microsoft Entra for Graph audiences,
   * Auth0 without a custom audience) issue OPAQUE access tokens whose expiry
   * cannot be decoded locally. Without this lookup, every OBO call would treat
   * the session as expired and burn an IdP refresh, risking refresh-token
   * rotation thrash under concurrent tool calls.
   *
   * @param {{ accessToken?: string, accessTokenExpiresAt?: number }} sessionTokens
   * @returns {number | null} unix seconds, or null when no source proves an expiry
   */
  function getAccessTokenExp(sessionTokens: SessionOpenIDTokens): number | null {
    const fromJwt = decodeJwtExp(sessionTokens?.accessToken);
    if (fromJwt != null) {
      return fromJwt;
    }
    const persisted = sessionTokens?.accessTokenExpiresAt;
    return typeof persisted === 'number' ? persisted : null;
  }

  /**
   * Returns true when the session token nominated by `tokenPreference` is still
   * valid for at least the skew buffer. Required argument (no default) so every
   * caller is explicit about which token's freshness gates this check.
   *
   * Use 'access_token' for OBO and any flow whose downstream sends the access
   * token to the IdP as an assertion (jwt-bearer / on-behalf-of) — those flows
   * fail when the access token is expired even if the id_token is still fresh.
   * Access-token expiry is read via `getAccessTokenExp`, which handles opaque
   * (non-JWT) tokens by falling back to the persisted `accessTokenExpiresAt`.
   *
   * Use 'id_token' for flows whose downstream is the LibreChat backend itself
   * (e.g. session-token reuse in `refreshController`); the id_token is the
   * standard JWT signed for the client_id audience and is the bearer the SPA
   * sends back to LibreChat.
   *
   * @param {{ accessToken?: string, idToken?: string, accessTokenExpiresAt?: number }} sessionTokens
   * @param {'access_token' | 'id_token'} tokenPreference
   */
  function isLiveSessionTokenStillValid(
    sessionTokens: SessionOpenIDTokens,
    tokenPreference: TokenPreference,
  ): boolean {
    if (tokenPreference !== 'access_token' && tokenPreference !== 'id_token') {
      throw new Error(
        `[OpenIDSessionRefresh] tokenPreference must be 'access_token' or 'id_token', got: ${tokenPreference}`,
      );
    }
    const now = Math.floor(Date.now() / 1000);
    const exp =
      tokenPreference === 'access_token'
        ? getAccessTokenExp(sessionTokens)
        : decodeJwtExp(sessionTokens?.idToken);
    return exp != null && exp > now + UPSTREAM_TOKEN_EXPIRY_BUFFER_SECONDS;
  }

  /**
   * Builds the OIDCTokens shape consumed by `resolveOboToken`. Required
   * `tokenPreference` selects which token's expiry becomes `expires_at` —
   * caller intent must match what the downstream consumer actually validates.
   * `expiresAtOverride` (unix seconds) wins when the caller has an authoritative
   * value such as the IdP's `tokenset.expires_in` from a fresh refresh response;
   * use it after refresh so we never attribute a prior token's `exp` to a freshly
   * rotated counterpart. For 'access_token', the fallback uses `getAccessTokenExp`
   * so opaque tokens are handled correctly via the persisted `accessTokenExpiresAt`.
   *
   * @param {{ accessToken?: string, idToken?: string, refreshToken?: string, accessTokenExpiresAt?: number }} sessionTokens
   * @param {'access_token' | 'id_token'} tokenPreference
   * @param {number} [expiresAtOverride] — unix seconds (preferred when present)
   */
  function buildOIDCTokensFromSession(
    sessionTokens: SessionOpenIDTokens,
    tokenPreference: TokenPreference,
    expiresAtOverride?: number,
  ): MarkedOIDCTokens {
    if (tokenPreference !== 'access_token' && tokenPreference !== 'id_token') {
      throw new Error(
        `[OpenIDSessionRefresh] tokenPreference must be 'access_token' or 'id_token', got: ${tokenPreference}`,
      );
    }
    let expiresAt = expiresAtOverride;
    if (expiresAt == null) {
      expiresAt =
        tokenPreference === 'access_token'
          ? (getAccessTokenExp(sessionTokens) ?? undefined)
          : (decodeJwtExp(sessionTokens?.idToken) ?? undefined);
    }
    return {
      access_token: sessionTokens?.accessToken,
      id_token: sessionTokens?.idToken,
      refresh_token: sessionTokens?.refreshToken,
      expires_at: expiresAt ?? undefined,
    };
  }

  /**
   * Loads the request's custody context through the injected `loadOpenIDCustody`, memoized on
   * `req.openidCustody`. Every call in a request after the first is free, so however many OBO tool
   * calls a request fans out into, at most one custody store read occurs. Returns null, with no
   * store read, when the token key or marker cookie check fails; the caller turns that into an
   * `OPENID_SESSION_MISSING` rejection.
   */
  function resolveCustodyContext(
    req: OpenIDRequest,
    identityContext?: AuthIdentityContext,
  ): Promise<OpenIDCustodyContext | null> {
    return loadOpenIDCustody(req as unknown as CustodyRequest, {
      custody: getCustody(),
      tenantId: identityContext?.tenantId,
    });
  }

  /**
   * Builds the `OIDCTokens` the OBO consumer reads from a custody payload. The payload's field
   * names match the `SessionOpenIDTokens` shape, so the `buildOIDCTokensFromSession` projection
   * serves both.
   */
  function buildOIDCTokensFromCustody(
    tokens: CustodyTokenPayload,
    tokenPreference: TokenPreference,
    expiresAtOverride?: number,
  ): MarkedOIDCTokens {
    return buildOIDCTokensFromSession(
      tokens as unknown as SessionOpenIDTokens,
      tokenPreference,
      expiresAtOverride,
    );
  }

  /**
   * Runs one IdP refresh-token grant with the refresh token from the custody context, validates the
   * response, and returns the rotated `CustodyTokenPayload` alongside the resolved access-token
   * expiry (unix seconds) that the OBO consumer attributes to the new access token. Preserves the
   * previous `id_token` / `refresh_token` when the IdP omits them on rotation, matching the login
   * path. Throws on a missing or already-expired access token, and on an `invalid_grant` the caller
   * distinguishes by message.
   */
  async function grantRotatedCustodyPayload(
    context: OpenIDCustodyContext,
    assertLeaseOwned?: LeaseAssertion,
  ): Promise<{ payload: CustodyTokenPayload; accessTokenExp: number | null }> {
    const current = context.tokens;
    const config = getOpenIdConfig();
    const refreshParams = buildOpenIDRefreshParams();
    logger.debug('[OpenIDSessionRefresh] Performing inline IdP refresh-token grant (custody)');
    const tokenset = await openIdClient.refreshTokenGrant(
      config,
      current.refreshToken,
      refreshParams,
    );

    /** A rotating grant can finish after this worker's lease was reclaimed; re-prove ownership
     * before we touch the custody store. */
    if (assertLeaseOwned) {
      await assertLeaseOwned();
    }

    if (!tokenset?.access_token) {
      throw new Error('IdP refresh returned no access_token');
    }

    const nextIdToken = tokenset.id_token || current.idToken;
    const nextRefreshToken = tokenset.refresh_token || current.refreshToken;

    /**
     * Capture the new access token's expiry from the IdP's `expires_in` (authoritative) or a JWT
     * `exp` when the token is itself a JWT. Never fall back to the id_token's exp, which is governed
     * by a different policy and is often longer. An unknown expiry is left unset so the next
     * freshness check refreshes.
     */
    let accessTokenExp: number | null = null;
    const accessTokenExpiresIn = normalizeExpiresIn(tokenset.expires_in);
    if (accessTokenExpiresIn != null) {
      accessTokenExp = Math.floor(Date.now() / 1000) + accessTokenExpiresIn;
    } else {
      accessTokenExp = decodeJwtExp(tokenset.access_token);
    }
    if (accessTokenExp != null && accessTokenExp <= Math.floor(Date.now() / 1000)) {
      throw new Error('IdP refresh returned an already-expired access_token');
    }

    /**
     * The refresh-token expiry the response states, when present. `rotateCustody` re-derives the
     * record's TTL from this and the access-token expiry at receipt time; the previous record's TTL
     * is never carried forward, so a response that drops a refresh-token expiry may legitimately
     * shorten the record.
     */
    const refreshTokenExpiresIn = normalizeExpiresIn(
      (tokenset as { refresh_expires_in?: number | string }).refresh_expires_in,
    );

    const payload: CustodyTokenPayload = {
      accessToken: tokenset.access_token,
      idToken: nextIdToken,
      refreshToken: nextRefreshToken,
      issuedAt: Date.now(),
    };
    if (accessTokenExp != null) {
      /** Custody stores the access-token expiry in unix seconds, as the login path does. */
      payload.accessTokenExpiresAt = accessTokenExp;
    }
    if (refreshTokenExpiresIn != null) {
      payload.refreshTokenExpiresAt = Math.floor(Date.now() / 1000) + refreshTokenExpiresIn;
    }

    return { payload, accessTokenExp };
  }

  /**
   * The custody-native refresh core, used by the OBO / tool-call path. It reads tokens only from
   * the custody context and never writes the session store or a bridge:
   *
   *   1. one IdP grant with the refresh token from the custody context;
   *   2. `rotateCustody` re-seals the rotated set under the same token key and runs one
   *      compare-and-set on the record's `rotationCounter`;
   *   3. on an applied rotation, the token key cookie is re-issued with the rotation's `expiresAt`
   *      when headers have not been sent; otherwise the record update stands and the next
   *      non-streaming request re-issues it;
   *   4. an `applied: false` result means a concurrent worker already rotated: adopt the winner's
   *      token set with no second grant and no write;
   *   5. an `invalid_grant` is handled by `recoverFromInvalidGrant`.
   *
   * When the custody store is unavailable the grant or rotation rejects and the tool call fails;
   * there is no plaintext or `CREDS_KEY` fallback.
   */
  async function performCustodyRefresh(
    req: OpenIDRequest,
    res: OpenIDResponse | undefined,
    context: OpenIDCustodyContext,
    tokenPreference: TokenPreference,
    assertLeaseOwned?: LeaseAssertion,
    signal?: AbortSignal,
  ): Promise<MarkedOIDCTokens | null> {
    signal?.throwIfAborted();

    let payload: CustodyTokenPayload;
    let accessTokenExp: number | null;
    try {
      ({ payload, accessTokenExp } = await grantRotatedCustodyPayload(context, assertLeaseOwned));
    } catch (error) {
      if (isInvalidGrantError(error)) {
        return recoverFromInvalidGrant(req, res, context, tokenPreference);
      }
      throw error;
    }

    signal?.throwIfAborted();
    const rotation = await getCustody().rotateCustody({ context, tokens: payload });

    if (rotation.applied) {
      reissueTokenKeyCookie(res, rotation.context.tokenKey, rotation.expiresAt);
      return buildOIDCTokensFromCustody(
        rotation.context.tokens,
        tokenPreference,
        accessTokenExp ?? undefined,
      );
    }

    /**
     * Lost the compare-and-set: a concurrent worker already rotated. The winner's record is
     * authoritative for both the token set and the lifetime, so adopt it with no second grant and
     * no write. Re-issue the cookie from the winner's `recordExpiresAt` when headers allow.
     */
    reissueTokenKeyCookie(res, rotation.context.tokenKey, rotation.context.recordExpiresAt);
    return buildOIDCTokensFromCustody(rotation.context.tokens, tokenPreference);
  }

  /**
   * Handles an `invalid_grant` from the IdP by re-reading the custody record once. A higher
   * `rotationCounter` means another worker rotated first: retry once with the reloaded set (which,
   * if it also comes back `invalid_grant` with an unchanged counter, retires the record). An
   * unchanged counter, or an absent/unopenable record, means the credential is genuinely dead:
   * delete the record, clear the token key and marker cookies and reject session-missing.
   */
  async function recoverFromInvalidGrant(
    req: OpenIDRequest,
    res: OpenIDResponse | undefined,
    context: OpenIDCustodyContext,
    tokenPreference: TokenPreference,
  ): Promise<MarkedOIDCTokens | null> {
    const reloaded = await getCustody().reloadAfterInvalidGrant({ context });

    if (reloaded && reloaded.rotationCounter > context.rotationCounter) {
      logger.info(
        '[OpenIDSessionRefresh] invalid_grant superseded by a concurrent rotation; adopting it',
      );
      reissueTokenKeyCookie(res, reloaded.tokenKey, reloaded.recordExpiresAt);
      return buildOIDCTokensFromCustody(reloaded.tokens, tokenPreference);
    }

    logger.warn(
      '[OpenIDSessionRefresh] IdP rejected the refresh token; retiring the custody record',
    );
    try {
      await getCustody().deleteCustody({ tokenKeyHash: context.tokenKeyHash });
    } catch (error) {
      logger.warn(
        '[OpenIDSessionRefresh] Failed to delete custody record after invalid_grant',
        toOpenIDLogArgument(error),
      );
    }
    clearOpenIDBrowserCookies(res);
    throw createOpenIDSessionMissingError('invalid_grant');
  }

  /** True when the IdP grant rejected with `invalid_grant`. */
  function isInvalidGrantError(error: unknown): boolean {
    if (error == null) {
      return false;
    }
    const code =
      (error as { error?: string; code?: string }).error ?? (error as { code?: string }).code;
    if (code === 'invalid_grant') {
      return true;
    }
    const message = (error as Error)?.message;
    return typeof message === 'string' && /invalid_grant/i.test(message);
  }

  /**
   * Re-issues the token key cookie with the record's derived `expires`. The token key never changes
   * on rotation, so this only refreshes the cookie's expiry, and
   * only when a cookie-capable response is available and its headers have not been sent. On the SSE
   * streaming path (`headersSent`) it is a no-op: the record update stands and the browser keeps the
   * current cookie value, which still opens the rotated record; the next non-streaming request
   * re-issues the expiry.
   */
  function reissueTokenKeyCookie(
    res: OpenIDResponse | undefined,
    tokenKey: Buffer,
    expires: Date,
  ): void {
    if (!res || typeof res.cookie !== 'function' || res.headersSent) {
      return;
    }
    setTokenKeyCookie(res, tokenKey.toString('base64url'), expires);
  }

  /** Clears the token key cookie and the OpenID marker cookies after an `invalid_grant`. */
  function clearOpenIDBrowserCookies(res: OpenIDResponse | undefined): void {
    if (!res) {
      return;
    }
    if (typeof res.clearCookie === 'function') {
      clearTokenKeyCookie(res);
      for (const name of ['openid_user_id', 'token_provider']) {
        res.clearCookie(name);
      }
    }
  }

  /** The `OPENID_SESSION_MISSING` rejection the OBO path surfaces when no live record is available. */
  function createOpenIDSessionMissingError(reason: string): Error {
    return Object.assign(new Error('OpenID session is no longer available'), {
      code: 'OPENID_SESSION_MISSING',
      reason,
    });
  }

  /**
   * Reuses the custody context's live token set when it is still valid past the skew buffer,
   * otherwise runs the custody-native refresh. Reads tokens only from the context.
   */
  async function refreshOrReuseCustody(
    req: OpenIDRequest,
    res: OpenIDResponse | undefined,
    context: OpenIDCustodyContext,
    tokenPreference: TokenPreference,
    forceRefresh = false,
    signal?: AbortSignal,
  ): Promise<MarkedOIDCTokens | null> {
    if (
      !forceRefresh &&
      isLiveSessionTokenStillValid(
        context.tokens as unknown as SessionOpenIDTokens,
        tokenPreference,
      )
    ) {
      logger.debug('[OpenIDSessionRefresh] Live custody token reused');
      return buildOIDCTokensFromCustody(context.tokens, tokenPreference);
    }

    signal?.throwIfAborted();
    return performCustodyRefresh(req, res, context, tokenPreference, undefined, signal);
  }

  /**
   * Single-flighted, custody-native entry point. Tokens come only from the request's custody
   * context; a null context is answered `OPENID_SESSION_MISSING` with no IdP call. The record's
   * identity must match the request's user before any grant.
   *
   * Concurrent OBO calls on the same request coalesce through the process-local `inFlightRefreshes`
   * map keyed on the rotation-invariant token key hash, so a fan-out of tool calls produces one IdP
   * grant. Across workers, `rotateCustody`'s compare-and-set is the guarantee: a worker that loses
   * the race adopts the winner's rotation with no second grant.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} [res] — when present and writable, the token key cookie's
   *   expiry is re-issued after a rotation.
   * @param {import('@librechat/data-schemas').IUser} user
   * @param {'access_token' | 'id_token'} tokenPreference — required; selects which token's `exp`
   *   gates the live-vs-refresh decision and populates the returned `expires_at`.
   */
  async function refreshOpenIDSession(
    req: OpenIDRequest,
    res: OpenIDResponse | undefined,
    user: OpenIDUser,
    tokenPreference: TokenPreference,
    identityContext?: AuthIdentityContext,
    options: RefreshSessionOptions = {},
  ): Promise<MarkedOIDCTokens | null> {
    options.signal?.throwIfAborted();

    const context = await resolveCustodyContext(req, identityContext);
    if (!context) {
      logger.debug('[OpenIDSessionRefresh] No custody context; session missing');
      throw createOpenIDSessionMissingError('no-custody-context');
    }

    /** Fails closed before any IdP call when the record's identity disagrees with the marker's
     * user; leaves the record and cookies untouched. */
    assertOpenIDSessionIdentityMatch(req, user, identityContext, context);
    options.signal?.throwIfAborted();

    const key = getSingleFlightKey(req, user, identityContext, context);
    if (!key) {
      return refreshOrReuseCustody(
        req,
        res,
        context,
        tokenPreference,
        options.forceRefresh,
        options.signal,
      );
    }

    const forcedKey = `${key}:forced`;
    /** A rejection-driven refresh must not join a normal flight that may merely reuse the
     * rejected-but-unexpired token; drain the normal flight, then force a distinct refresh. */
    const normalFlight = inFlightRefreshes.get(key);
    if (options.forceRefresh && normalFlight) {
      await refreshOpenIDSession(req, res, user, tokenPreference, identityContext, {
        ...options,
        forceRefresh: false,
      });
      if (inFlightRefreshes.get(key) === normalFlight) {
        inFlightRefreshes.delete(key);
      }
      return refreshOpenIDSession(req, res, user, tokenPreference, identityContext, options);
    }

    /** Normal callers may join a forced flight and receive its fresher result. */
    const inFlightKey = !options.forceRefresh && inFlightRefreshes.has(forcedKey) ? forcedKey : key;
    const ownedFlightKey = options.forceRefresh ? forcedKey : inFlightKey;
    const inFlight = inFlightRefreshes.get(ownedFlightKey);
    if (inFlight) {
      logger.debug(
        `[OpenIDSessionRefresh] Joining in-flight refresh (key=${hashKeyForLogs(ownedFlightKey)})`,
      );
      try {
        return await inFlight;
      } catch (error) {
        options.signal?.throwIfAborted();
        const leaderSignal = flightSignals.get(inFlight);
        if (!leaderSignal?.aborted || error !== leaderSignal.reason) {
          throw error;
        }
        if (inFlightRefreshes.get(ownedFlightKey) === inFlight) {
          inFlightRefreshes.delete(ownedFlightKey);
        }
        return refreshOpenIDSession(req, res, user, tokenPreference, identityContext, options);
      }
    }

    const promise = refreshOrReuseCustody(
      req,
      res,
      context,
      tokenPreference,
      options.forceRefresh,
      options.signal,
    ).finally(() => {
      if (inFlightRefreshes.get(ownedFlightKey) === promise) {
        inFlightRefreshes.delete(ownedFlightKey);
      }
    });
    inFlightRefreshes.set(ownedFlightKey, promise);
    if (options.signal) {
      flightSignals.set(promise, options.signal);
    }
    /** Swallow rejection on the cleanup chain; the original is delivered to the awaiter. */
    promise.catch(() => {});
    return promise;
  }

  /**
   * Returns true when this user is in scope for OIDC session refresh. Non-OIDC
   * users and deployments without `OPENID_REUSE_TOKENS` never had a populated
   * `req.session.openidTokens` to begin with. Bearer-authenticated remote-agent requests may use
   * their current verified bearer; browser requests whose session capability disappeared reject.
   */
  function isOIDCRefreshApplicable(user?: OpenIDUser): user is OpenIDUser {
    if (!isEnabled(process.env.OPENID_REUSE_TOKENS)) {
      return false;
    }
    if (!user) {
      return false;
    }
    return user.provider === 'openid' || Boolean(user.openidId);
  }

  /**
   * Builds the UpstreamTokenProvider closure forwarded into the MCP layer.
   * The closure closes over `req` so it reads `req.session.openidTokens` at OBO
   * call time (not at request validation), which is what makes the walk-away
   * failure mode recover without a user-visible re-authentication.
   *
   * `tokenPreference` is required and identifies which upstream token's freshness
   * gates the closure. OBO needs 'access_token' because the OBO exchange uses
   * the access token as the jwt-bearer assertion; using id_token preference here
   * would let an expired access token reach the IdP under a still-fresh id_token.
   *
   * Closure contract (matches `UpstreamTokenProvider` in obo.ts):
   *   - resolves to non-null OIDCTokens when fresh tokens are available.
   *   - resolves to null when refresh is not applicable or the request itself carries the
   *     verified upstream bearer (the remote-agent flow).
   *   - rejects when an Express session existed but its OpenID capability was cleared, so a
   *     strategy-time `user.federatedTokens` snapshot cannot bypass logout.
   *   - rejects when session identity metadata does not match the current user.
   *   - rejects when refresh was attempted and rejected by the IdP. The MCP
   *     layer wraps the rejection as `session_refresh_failed`.
   *
   * @param {object} args
   * @param {import('express').Request} [args.req]
   * @param {import('express').Response} [args.res] — forwarded so a rotated
   *   refresh token can be mirrored to the `refreshToken` cookie when the
   *   response is still writable (no-op on the streaming tool-call path).
   * @param {import('@librechat/data-schemas').IUser} [args.user]
   * @param {import('@librechat/api').AuthIdentityContext} [args.identityContext]
   * @param {'access_token' | 'id_token'} args.tokenPreference
   * @returns {(options?: { forceRefresh?: boolean, signal?: AbortSignal }) => Promise<import('@librechat/data-schemas').OIDCTokens | null>}
   */
  function createOpenIDSessionTokenProvider({
    req,
    res,
    user,
    tokenPreference,
    identityContext,
  }: CreateOpenIDSessionTokenProviderInput): (options?: {
    forceRefresh?: boolean;
    signal?: AbortSignal;
  }) => Promise<OIDCTokens | null> {
    if (tokenPreference !== 'access_token' && tokenPreference !== 'id_token') {
      throw new Error(
        `[OpenIDSessionRefresh] createOpenIDSessionTokenProvider requires tokenPreference 'access_token' or 'id_token', got: ${tokenPreference}`,
      );
    }
    return async function upstreamTokenProvider(options = {}) {
      options.signal?.throwIfAborted();
      if (!isOIDCRefreshApplicable(user)) {
        return null;
      }
      if (!req) {
        return null;
      }
      const resolvedIdentityContext =
        identityContext ??
        createAuthIdentityContext({
          user,
          requestUser: req?.user,
        });

      /**
       * Tokens come only from the custody context. `loadOpenIDCustody` performs at most one
       * custody store read for this request and memoizes the result on `req.openidCustody`, so
       * however many OBO tool calls a request fans out into, only one read happens.
       */
      const context = await resolveCustodyContext(req, resolvedIdentityContext);
      if (!context) {
        /**
         * No live custody record. A remote-agent request that carries the current verified upstream
         * bearer may still use it — that flow never had a custody record. Otherwise the request
         * cannot obtain IdP tokens: reject session-missing without contacting the IdP.
         */
        const authorization = req?.headers?.authorization;
        const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
        const carriesCurrentUpstreamBearer = Boolean(
          bearerToken && bearerToken === user?.federatedTokens?.access_token,
        );
        if (carriesCurrentUpstreamBearer) {
          logger.debug(
            '[OpenIDSessionRefresh] No custody context; request carries the current upstream bearer',
          );
          return null;
        }
        logger.debug(
          '[OpenIDSessionRefresh] No custody context available; rejecting session-missing',
        );
        throw createOpenIDSessionMissingError('no-custody-context');
      }

      return refreshOpenIDSession(req, res, user, tokenPreference, resolvedIdentityContext, {
        forceRefresh: options.forceRefresh,
        signal: options.signal,
      });
    };
  }

  return {
    createOpenIDSessionTokenProvider,
    refreshOpenIDSession,
    /** Exposed for tests; not a public API. */
    __internals: {
      UPSTREAM_TOKEN_EXPIRY_BUFFER_SECONDS,
      inFlightRefreshes,
      getSingleFlightKey,
      isLiveSessionTokenStillValid,
      getAccessTokenExp,
    },
  };
}
