import type { Response } from 'express';
import { shouldUseSecureCookie } from '~/oauth/csrf';
import { TOKEN_KEY_COOKIE } from './key';

/**
 * The single source of the token key cookie's options, so the login path and the
 * inline OBO refresh path write byte-identical `Set-Cookie` headers for the same
 * value and `expires`. Writes the cookie named `openid_token_key` with:
 *   - `httpOnly`, `secure: shouldUseSecureCookie()`, `sameSite: 'strict'`
 *   - `path: '/'` — required so the browser sends the cookie on same-site requests
 *     to both `/api/` routes and `/images/:ownerId/:filename`
 *   - `expires` taken as given
 *
 * The helper computes no lifetime: it receives the `expiresAt` that `createCustody`
 * or `rotateCustody` wrote on the custody record and writes it as given, so one
 * derived value serves both the record and the cookie and the two cannot drift.
 *
 * Kept apart from `key.ts` because `~/oauth/csrf` imports the key helpers; importing
 * `csrf` from `key.ts` would close an import cycle.
 */
export function setTokenKeyCookie(res: Response, tokenKey: string, expires: Date): void {
  res.cookie(TOKEN_KEY_COOKIE, tokenKey, {
    expires,
    httpOnly: true,
    secure: shouldUseSecureCookie(),
    sameSite: 'strict',
    path: '/',
  });
}

/**
 * Emits a `Set-Cookie` for `openid_token_key` with `path: '/'` that causes the
 * browser to drop the token key cookie. The path must match the one
 * `setTokenKeyCookie` wrote so the clear applies to the same cookie.
 */
export function clearTokenKeyCookie(res: Response): void {
  res.clearCookie(TOKEN_KEY_COOKIE, { path: '/' });
}
