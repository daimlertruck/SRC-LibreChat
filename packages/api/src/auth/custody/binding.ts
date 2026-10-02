import jwt from 'jsonwebtoken';
import type { Request } from 'express';
import type { TokenCustodyService } from './service';
import { hashTokenKey, parseTokenKey, TOKEN_KEY_COOKIE } from './key';
import { OPENID_USER_ID_COOKIE } from '~/oauth/csrf';

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
 * The result of a successful binding check. Carries only the user id the marker claimed and the
 * token key hash the cookie parsed to — never a token, never key material.
 */
export interface CustodyBindingResult {
  userId: string;
  tokenKeyHash: string;
}

/**
 * Verifies the marker cookie with `JWT_REFRESH_SECRET` and extracts `{ id, tokenKeyHash }`. Returns
 * null for an absent cookie, an absent secret, a bad or unsigned signature, a non-ObjectId `id`, or a
 * missing `tokenKeyHash` claim — every shape that cannot bind to a token key. Never throws.
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
 * The cookie-pair check shared by image authorization and shared-link authorization. Parses the
 * token key cookie (`openid_token_key`), hashes the 32 bytes, verifies the marker cookie
 * (`openid_user_id`) with `JWT_REFRESH_SECRET`, compares the marker's `tokenKeyHash` claim to that
 * hash for exact string equality, then performs exactly one custody record existence-and-`userId`
 * check through `custodyExists`.
 *
 * The checks run cheapest-first so the store is never touched for a request that cannot succeed: a
 * missing or malformed key cookie, an absent or unsigned marker, a missing or mismatched claim all
 * return null before the single indexed read.
 *
 * It never opens the sealed blob, never uses the token key as an AEAD key and never attaches a
 * custody context; the only cryptographic work is one SHA-256 and the marker's signature
 * verification. It never inserts, updates or deletes a record, so a forged cookie cannot revoke a
 * live session. Every failure returns null without throwing. A null result is both the failure
 * answer and the revocation answer: the record's existence is what "this session is still live"
 * means on the OpenID path.
 */
export async function verifyCustodyBinding(
  req: Request,
  deps: { custody: TokenCustodyService; tenantId?: string },
): Promise<CustodyBindingResult | null> {
  const cookies = req.cookies as Record<string, string> | undefined;

  const key = parseTokenKey(cookies?.[TOKEN_KEY_COOKIE]);
  if (key === null) {
    return null;
  }

  const hash = hashTokenKey(key);
  const marker = verifyMarker(cookies?.[OPENID_USER_ID_COOKIE]);
  if (marker === null || marker.tokenKeyHash !== hash) {
    return null;
  }

  const live = await deps.custody.custodyExists({
    tokenKeyHash: hash,
    expectedUserId: marker.id,
    tenantId: deps.tenantId,
  });
  if (!live) {
    return null;
  }

  return { userId: marker.id, tokenKeyHash: hash };
}
