import type {
  AuthIdentityContext,
  OpenIDRequest,
  OpenIDResponse,
  OpenIDTokenSet,
  OpenIDUser,
} from './types';
import type { TokenCustodyService } from '~/auth/custody/service';
import type { CustodyFlightSeal, TokenResult } from './flight';
import type { CustodyTokenPayload } from '~/auth/custody/aead';
import type { CustodyRequest } from '~/auth/custody/loader';
import { reloadOpenIDSessionIfPersisted } from './errors';

interface RecoveryUser extends OpenIDUser {
  _id: string | number | { toString(): string };
}

interface RevokeOpenIDRefreshTokenChainInput {
  req: OpenIDRequest;
  user: OpenIDUser;
  identityContext: AuthIdentityContext;
  refreshTokens: string[];
  ttl: number;
}

interface SendOpenIDAuthResponseInput {
  tokenset: OpenIDTokenSet;
  user: RecoveryUser;
  existingRefreshToken?: string;
  openidSubject?: string;
  openidIssuer?: string;
  req: OpenIDRequest;
  res: OpenIDResponse;
  /**
   * Retained on the input for the admin exchange caller (`oauth.js`), but inert since key custody
   * retired `req.session.openidTokens`: there is no stale session token set to discard. A fresh
   * login publishes over the request's own custody context, so the carried id_token comes from
   * there rather than from the session.
   */
  discardSessionTokens?: boolean;
}

export interface OpenIDRefreshRecoveryService {
  sendOpenIDAuthResponse: (input: SendOpenIDAuthResponseInput) => Promise<string | undefined>;
  revokeOpenIDRefreshTokenChain: (input: RevokeOpenIDRefreshTokenChainInput) => Promise<string[]>;
}

export interface OpenIDRefreshRecoveryDeps {
  /**
   * Establishes the request's custody record for a fresh authorization-code login and returns the
   * app auth token. It seals the IdP token set under a freshly generated token key via
   * `createCustody` and writes the token key and marker cookies, so this module must `await` it.
   * It writes no session store row and no bridge.
   */
  setOpenIDAuthTokens: (
    tokens: OpenIDTokenSet,
    req: OpenIDRequest,
    res: OpenIDResponse,
    identity: {
      userId: string;
      existingRefreshToken?: string;
      tenantId?: string;
      openidSubject?: string;
      openidIssuer?: string;
    },
  ) => Promise<string | undefined>;
  getOpenIDAppAuthToken: (tokens: OpenIDTokenSet, sessionIdToken?: string) => string | undefined;
  createOpenIDRefreshFlightKey: (args: {
    req: OpenIDRequest;
    user: OpenIDUser;
    refreshToken: string;
    identityContext: AuthIdentityContext;
  }) => string | null;
  revokeOpenIDRefreshFlights: (args: {
    keys: Array<string | null>;
    seal: CustodyFlightSeal;
    ttl: number;
  }) => Promise<Array<TokenResult | null>>;
  /**
   * Returns the process-wide token custody service (`getTokenCustodyService` in `AuthService.js`).
   * It is the only component that reads or writes the custody store; this module, `session.ts`
   * and `refreshController` share the same instance. A getter so the service is built on first
   * use, not when this module is wired at load.
   */
  getCustody: () => TokenCustodyService;
  /**
   * Re-issues the token key cookie with the record's derived `expires`. Rotation never changes the
   * token key value, so this only refreshes the cookie's expiry after a `rotateCustody`, and only
   * when a cookie-capable response is available whose headers have not been sent.
   */
  setTokenKeyCookie: (res: OpenIDResponse, tokenKey: string, expires: Date) => void;
}

export function createOpenIDRefreshRecoveryService(
  deps: OpenIDRefreshRecoveryDeps,
): OpenIDRefreshRecoveryService {
  const {
    setOpenIDAuthTokens,
    getOpenIDAppAuthToken,
    createOpenIDRefreshFlightKey,
    revokeOpenIDRefreshFlights,
    getCustody,
    setTokenKeyCookie,
  } = deps;

  /**
   * Builds the {@link CustodyFlightSeal} the flight store uses to seal and open a refresh result,
   * from the request's custody context (`req.openidCustody`, materialized by the request-scoped
   * loader). Every flight in one session's chain is sealed under the same token key, so a single
   * seal opens them all. Throws when the request carries no custody context, since without the
   * key the flight result can neither be sealed nor opened, and there is no plaintext or
   * `CREDS_KEY` fallback.
   */
  function resolveFlightSeal(req: OpenIDRequest): CustodyFlightSeal {
    const context = (req as CustodyRequest).openidCustody;
    if (!context) {
      throw new Error('OpenID refresh coordination requires a custody context');
    }
    return {
      aeadKey: context.tokenKey,
      tokenKeyHash: context.tokenKeyHash,
      identity: context.identity,
    };
  }

  const MAX_LOGOUT_REFRESH_CHAIN_DEPTH = 16;
  const MAX_LOGOUT_REFRESH_TARGETS = 128;

  async function revokeOpenIDRefreshTokenChain({
    req,
    user,
    identityContext,
    refreshTokens,
    ttl,
  }: RevokeOpenIDRefreshTokenChainInput): Promise<string[]> {
    const userId = identityContext.appUserId;
    if (!userId) {
      throw new Error('OpenID logout identity is unavailable');
    }
    const identityKey = (identity: AuthIdentityContext): string =>
      [
        identity.appUserId ?? '',
        identity.tenantId ?? '',
        identity.openidIssuer ?? '',
        identity.openidSubject ?? '',
      ].join('\x1f');
    const discovered = new Set(refreshTokens.filter(Boolean));
    const scheduled = new Set<string>();
    let frontier = [...discovered].map((refreshToken) => ({
      refreshToken,
      identity: identityContext,
    }));
    for (const target of frontier) {
      scheduled.add(`${target.refreshToken}\x1e${identityKey(target.identity)}`);
    }
    let directPublicationKeys: string[] = [];

    for (let depth = 0; frontier.length > 0 || directPublicationKeys.length > 0; depth++) {
      if (depth >= MAX_LOGOUT_REFRESH_CHAIN_DEPTH) {
        throw new Error('OpenID logout refresh chain exceeded the safety limit');
      }
      const keys = [
        ...directPublicationKeys,
        ...frontier.map(({ refreshToken, identity }) =>
          createOpenIDRefreshFlightKey({ req, user, refreshToken, identityContext: identity }),
        ),
      ];
      directPublicationKeys = [];
      const revoked = await revokeOpenIDRefreshFlights({ keys, seal: resolveFlightSeal(req), ttl });
      const inheritedIdentities = frontier.map(({ identity }) => identity);
      const acceptedIdentities = revoked.flatMap((result) => {
        if (result?.acceptedIdentity) return [result.acceptedIdentity];
        const claims = result?.__identityClaims;
        if (!claims?.sub) return [];
        return [
          {
            ...identityContext,
            openidSubject: claims.sub,
            openidIssuer: result?.openidIssuer ?? claims.iss ?? identityContext.openidIssuer,
          },
        ];
      });
      const identities = [...inheritedIdentities, ...acceptedIdentities].filter(
        (identity, index, all) =>
          all.findIndex((candidate) => identityKey(candidate) === identityKey(identity)) === index,
      );
      const successors = revoked.flatMap((result) =>
        [result?.refresh_token, result?.tokenset?.refresh_token].filter((token): token is string =>
          Boolean(token),
        ),
      );
      frontier = successors.flatMap((refreshToken) => {
        discovered.add(refreshToken);
        return identities.flatMap((identity) => {
          const targetKey = `${refreshToken}\x1e${identityKey(identity)}`;
          if (scheduled.has(targetKey)) return [];
          if (scheduled.size >= MAX_LOGOUT_REFRESH_TARGETS) {
            throw new Error('OpenID logout refresh chain exceeded the target safety limit');
          }
          scheduled.add(targetKey);
          return [{ refreshToken, identity }];
        });
      });
    }

    return [...discovered];
  }

  /**
   * Builds the `CustodyTokenPayload` from a published IdP token set. `rotateCustody` re-derives the
   * record's TTL from the payload's absolute expiries at receipt time, so any `_in` duration on the
   * response is converted here and the previous record's TTL is never carried forward.
   */
  function toCustodyPayload(published: OpenIDTokenSet, refreshToken: string): CustodyTokenPayload {
    const payload: CustodyTokenPayload = {
      accessToken: published.access_token as string,
      idToken: published.id_token,
      refreshToken,
      issuedAt: Date.now(),
    };
    if (typeof published.expires_at === 'number' && Number.isFinite(published.expires_at)) {
      payload.accessTokenExpiresAt = published.expires_at;
    }
    const refreshExpiresIn = (published as { refresh_expires_in?: number | string })
      .refresh_expires_in;
    let parsedRefreshExpiresIn: number | undefined;
    if (typeof refreshExpiresIn === 'number') {
      parsedRefreshExpiresIn = refreshExpiresIn;
    } else if (typeof refreshExpiresIn === 'string') {
      parsedRefreshExpiresIn = Number(refreshExpiresIn);
    }
    if (parsedRefreshExpiresIn != null && Number.isFinite(parsedRefreshExpiresIn)) {
      payload.refreshTokenExpiresAt = Math.floor(Date.now() / 1000) + parsedRefreshExpiresIn;
    }
    return payload;
  }

  /**
   * Re-issues the token key cookie with the record's derived `expires` after a rotation. The value
   * is unchanged by rotation, so this only refreshes the cookie's expiry, and only on a
   * cookie-capable response whose headers have not been sent.
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

  /**
   * Publishes an already-obtained OpenID token set, persisting it only through the custody store
   * (never a `sessions` row or legacy recovery document):
   *
   *   - When the request already carries a custody context (`req.openidCustody`), the set is a
   *     rotation of that record under the same token key through `rotateCustody`. An applied
   *     rotation re-issues the token key cookie from the returned `expiresAt`; an `applied: false`
   *     result adopts the concurrent winner's record and re-issues from the winner's expiry.
   *   - Otherwise this is a fresh authorization-code login: `setOpenIDAuthTokens` generates a token
   *     key, seals the set through `createCustody`, and writes the token key and marker cookies.
   *
   * With `discardSessionTokens` set, the stale Express-session token set is dropped so the set the
   * caller passed is the one published. Cross-worker convergence and `invalid_grant` handling live
   * on the refresh path (`session.ts`), since this function publishes rather than grants.
   */
  async function sendOpenIDAuthResponse({
    tokenset,
    user,
    existingRefreshToken,
    openidSubject,
    openidIssuer,
    req,
    res,
  }: SendOpenIDAuthResponseInput): Promise<string | undefined> {
    const userId = user._id.toString();

    await reloadOpenIDSessionIfPersisted(req?.session);

    const nextRefreshToken = tokenset.refresh_token || existingRefreshToken;
    if (!nextRefreshToken) {
      throw new Error('OpenID refresh returned no refresh token');
    }

    let authTokenset = tokenset;
    const effectiveExpiresAt = tokenset.expires_at;
    if (tokenset.expires_in == null && Number.isFinite(effectiveExpiresAt)) {
      authTokenset = {
        ...tokenset,
        expires_in: Math.max(0, Math.floor((effectiveExpiresAt as number) - Date.now() / 1000)),
      };
    }

    /**
     * A request that already opened a custody record publishes over it as a rotation under the same
     * token key, never as a fresh record. The carried id_token used to select the app auth token
     * comes from that opened context (the retired `req.session.openidTokens` no longer holds it);
     * `discardSessionTokens` is now moot because no session token set is kept.
     */
    const context = (req as CustodyRequest).openidCustody;
    const carriedIdToken = context?.tokens?.idToken;
    const preparedAppAuthToken = getOpenIDAppAuthToken(authTokenset, carriedIdToken);
    if (!preparedAppAuthToken) {
      throw new Error('OpenID refresh returned no application authentication token');
    }

    if (context) {
      const rotation = await getCustody().rotateCustody({
        context,
        tokens: toCustodyPayload(authTokenset, nextRefreshToken),
      });
      /**
       * This is a fresh authorization-code login publishing over the request's own just-opened
       * record, so a `gone` outcome (the record vanished between open and rotate) is treated like a
       * superseded one here: re-issue from whatever context the rotation reports and let the record
       * stand. The refresh path owns the fail-closed-and-revoke behavior; this login path has no
       * stale credential to strand.
       */
      if (rotation.outcome !== 'gone') {
        reissueTokenKeyCookie(
          res,
          rotation.context.tokenKey,
          rotation.outcome === 'applied' ? rotation.expiresAt : rotation.context.recordExpiresAt,
        );
      }
      return preparedAppAuthToken;
    }

    /**
     * Fresh login: establish the custody record and its cookies. `setOpenIDAuthTokens` is
     * asynchronous (it calls `createCustody`), so it must be awaited.
     */
    const publishedAppAuthToken = await setOpenIDAuthTokens(authTokenset, req, res, {
      userId,
      existingRefreshToken,
      tenantId: user.tenantId,
      openidSubject: openidSubject ?? user.openidId ?? userId,
      openidIssuer: openidIssuer ?? user.openidIssuer,
    });
    if (publishedAppAuthToken !== preparedAppAuthToken) {
      throw new Error('OpenID authentication publication returned an inconsistent token');
    }
    return publishedAppAuthToken;
  }

  return {
    revokeOpenIDRefreshTokenChain,
    sendOpenIDAuthResponse,
  };
}
