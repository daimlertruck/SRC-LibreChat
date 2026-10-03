import type { IUser, OIDCTokens } from '@librechat/data-schemas';
import type { OpenIDRequest, OpenIDResponse, OpenIDLogger } from './types';
import type { TokenCustodyService } from '~/auth/custody/service';
import type { CustodyRequest } from '~/auth/custody/loader';
import type { GraphTokenResponse } from '~/utils/graph';
import { toOpenIDLogArgument } from './errors';

/**
 * The upstream token provider closure (`createOpenIDSessionTokenProvider`). It resolves the user's
 * live IdP token set from the custody record — running the record's identity check — or null when
 * the request carries its own verified upstream bearer (the remote-agent flow), and rejects
 * `OPENID_SESSION_MISSING` when no live record backs the request.
 */
type UpstreamTokenProvider = (options?: {
  forceRefresh?: boolean;
  signal?: AbortSignal;
}) => Promise<OIDCTokens | null>;

export interface ResolveGraphApiTokenInput {
  req: OpenIDRequest;
  res: OpenIDResponse;
  user: IUser;
  scopes: string;
  /** Built per request with `tokenPreference: 'access_token'` and the authenticated user's identity. */
  upstreamTokenProvider: UpstreamTokenProvider;
  /** The OBO exchange against Microsoft Graph (`getGraphApiToken`). */
  graphTokenResolver: (
    user: IUser,
    accessToken: string,
    scopes: string,
  ) => Promise<GraphTokenResponse | null | undefined>;
  custody: TokenCustodyService;
  /** Clears the OpenID auth cookies, with the tenant of the authenticated user. */
  clearAuthCookies: () => void;
  logger: Pick<OpenIDLogger, 'warn' | 'error' | 'debug'>;
}

export type ResolveGraphApiTokenResult =
  | { status: 200; body: GraphTokenResponse }
  | { status: 401; body: { message?: string; code?: string } }
  | { status: 500; body: { message: string } };

/** The session-missing indication the upstream provider rejects with when no live record backs the request. */
function isSessionMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'OPENID_SESSION_MISSING'
  );
}

/**
 * Resolves a Microsoft Graph token for the SharePoint picker on the OpenID-reuse path, sourcing the
 * upstream IdP access token from the custody record through `upstreamTokenProvider` rather than from
 * `req.user.federatedTokens` (which is empty for a custody-login browser session).
 *
 * The ownership guarantee the previous session-based check gave is kept, re-expressed against
 * custody: the provider only returns a token set opened from a live record whose identity matches
 * the authenticated user (its `assertOpenIDSessionIdentityMatch`), or null when the request carries
 * its own verified upstream bearer (remote-agent). On a session-missing rejection the caller clears
 * the OpenID cookies, as the ownership failure did before. Immediately before returning the token,
 * one projected `custodyExists` read rechecks that the record was not deleted by a concurrent logout
 * during the Graph exchange (the custody replacement for the removed response-delivery guard); the
 * remote-agent bearer path has no custody context and skips that recheck.
 *
 * Returns a status/body the thin CJS controller sends; it performs no Express I/O itself beyond what
 * the provider does to the token key cookie, so the module carries no app singleton.
 */
export async function resolveGraphApiToken(
  input: ResolveGraphApiTokenInput,
): Promise<ResolveGraphApiTokenResult> {
  const { req, user, scopes, upstreamTokenProvider, graphTokenResolver, custody, logger } = input;

  let liveTokens: OIDCTokens | null;
  try {
    liveTokens = await upstreamTokenProvider({ forceRefresh: false });
  } catch (error) {
    if (isSessionMissing(error)) {
      logger.warn('[resolveGraphApiToken] OpenID session missing; sign-in required');
      input.clearAuthCookies();
      return { status: 401, body: { code: 'OPENID_SESSION_MISSING' } };
    }
    logger.error(
      '[resolveGraphApiToken] Upstream token resolution failed',
      toOpenIDLogArgument(error),
    );
    return { status: 500, body: { message: 'Failed to obtain Microsoft Graph token' } };
  }

  /**
   * The access token comes from the live custody record when one backs the request, or from the
   * request's own verified upstream bearer (`federatedTokens`) when the provider resolved null —
   * the remote-agent flow, which has no custody record. A request with neither cannot exchange.
   */
  const accessToken = liveTokens?.access_token ?? user.federatedTokens?.access_token;
  if (!accessToken) {
    logger.warn('[resolveGraphApiToken] No upstream access token available for Graph exchange');
    return { status: 401, body: { code: 'OPENID_SESSION_MISSING' } };
  }

  let tokenResponse: GraphTokenResponse | null | undefined;
  try {
    tokenResponse = await graphTokenResolver(user, accessToken, scopes);
  } catch (error) {
    logger.error('[resolveGraphApiToken] Graph token exchange failed', toOpenIDLogArgument(error));
    return { status: 500, body: { message: 'Failed to obtain Microsoft Graph token' } };
  }

  /**
   * Custody liveness recheck before sending: a concurrent logout, ban or account deletion may have
   * removed the record during the exchange's IdP round trip. Only applies when a custody record
   * backed this request (`liveTokens` present); the remote-agent bearer path has no record and
   * skips it. This replaces the removed `withOpenIDResponseDelivery` publication-generation guard.
   */
  if (liveTokens) {
    const context = (req as CustodyRequest).openidCustody;
    if (context) {
      const live = await custody.custodyExists({
        tokenKeyHash: context.tokenKeyHash,
        expectedUserId: context.identity.userId,
        expectedTenantId: context.identity.tenantId ?? null,
      });
      if (!live) {
        logger.warn(
          '[resolveGraphApiToken] Custody record gone before Graph response; failing closed',
        );
        return { status: 401, body: { code: 'OPENID_SESSION_MISSING' } };
      }
    }
  }

  if (!tokenResponse?.access_token) {
    logger.warn('[resolveGraphApiToken] Graph token exchange returned no access token');
    return { status: 500, body: { message: 'Failed to obtain Microsoft Graph token' } };
  }

  return { status: 200, body: tokenResponse };
}
