import jwt from 'jsonwebtoken';
import type { Request } from 'express';
import type { OpenIDCustodyContext, TokenCustodyService } from './service';
import { OPENID_USER_ID_COOKIE } from '~/oauth/csrf';
import { hashTokenKey, readTokenKey } from './key';

/** The 24-hex-character shape of a Mongo ObjectId, as the marker's `id` claim carries. */
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/**
 * The verified marker cookie claims. `id` is the custody record's `userId`; `tokenKeyHash` binds the
 * marker to the token key it was issued alongside. A marker with no `tokenKeyHash` claim — a
 * previous-format marker carrying only `refreshTokenHash`, or none at all — fails the claim
 * comparison and is treated as absent, so it fails closed.
 */
interface CustodyMarker {
  id: string;
  tokenKeyHash: string;
}

/**
 * A request carrying the memoized custody context. The context lives only on the request object: it
 * is never serialized, never written to the session store, a store document or a log entry. The
 * `undefined` slot is "not yet loaded"; a resolved `null` is "loaded and no valid session", so both
 * are distinguished and the store is read at most once per request.
 */
export type CustodyRequest = Request & {
  openidCustody?: OpenIDCustodyContext | null;
};

/**
 * Verifies the marker cookie with `JWT_REFRESH_SECRET` and extracts `{ id, tokenKeyHash }`. Returns
 * null for an absent cookie, an absent secret, a bad signature, a non-ObjectId `id`, or a missing
 * `tokenKeyHash` claim — every shape that cannot bind to a token key. Never throws.
 */
function verifyMarker(token: string | undefined): CustodyMarker | null {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!token || !secret) {
    return null;
  }
  try {
    const payload = jwt.verify(token, secret);
    if (typeof payload !== 'object' || payload === null) {
      return null;
    }
    const { id, tokenKeyHash } = payload as { id?: unknown; tokenKeyHash?: unknown };
    if (typeof id !== 'string' || !OBJECT_ID_PATTERN.test(id)) {
      return null;
    }
    if (typeof tokenKeyHash !== 'string') {
      return null;
    }
    return { id, tokenKeyHash };
  } catch {
    return null;
  }
}

/**
 * Materializes the request's OpenID custody context: the request-scoped opened token set that
 * replaces the retired `req.session.openidTokens`. It is memoized on `req.openidCustody`, so however
 * many times a request calls the loader it performs at most one custody store read.
 *
 * The checks run cheapest first so the store is never touched for a request that cannot succeed:
 *   1. `readTokenKey` — parse the token key cookie into 32 raw bytes, or null.
 *   2. Verify the marker cookie with `JWT_REFRESH_SECRET` and read its `id` and `tokenKeyHash`.
 *   3. Compare the marker's `tokenKeyHash` claim against `hashTokenKey` of the parsed key for exact
 *      string equality.
 *   4. Only then `openCustody`, with the marker's `id` as `expectedUserId`.
 *
 * Steps 1–3 fail closed before any read: a missing or malformed key, an absent or unsigned marker, a
 * missing claim, or a mismatched claim all return null with zero store reads. The returned context
 * (or the null) is cached so subsequent calls in the same request are free.
 *
 * The token key and the context live only on the request object; nothing here writes them to a log,
 * a cookie, the session store or a store document.
 */
export async function loadOpenIDCustody(
  req: CustodyRequest,
  deps: { custody: TokenCustodyService; tenantId?: string },
): Promise<OpenIDCustodyContext | null> {
  if (req.openidCustody !== undefined) {
    return req.openidCustody;
  }

  const key = readTokenKey(req);
  if (key === null) {
    req.openidCustody = null;
    return null;
  }

  const cookies = req.cookies as Record<string, string> | undefined;
  const marker = verifyMarker(cookies?.[OPENID_USER_ID_COOKIE]);
  if (marker === null || marker.tokenKeyHash !== hashTokenKey(key)) {
    req.openidCustody = null;
    return null;
  }

  req.openidCustody = await deps.custody.openCustody({
    tokenKey: key,
    expectedUserId: marker.id,
    tenantId: deps.tenantId,
  });
  return req.openidCustody;
}
