import crypto from 'node:crypto';
import type { Request } from 'express';

/** The httpOnly cookie whose value is the base64url-encoded token key (43 characters). */
export const TOKEN_KEY_COOKIE: string = 'openid_token_key';

/** The token key is exactly 32 raw bytes; those bytes ARE the AES-256-GCM key. */
export const TOKEN_KEY_BYTES: number = 32;

/**
 * Unpadded base64url encoding of 32 bytes is exactly 43 characters. Both the
 * token key cookie value and the token key hash match this shape.
 */
export const TOKEN_KEY_PATTERN: RegExp = /^[A-Za-z0-9_-]{43}$/;

/**
 * Mints one token key: 32 bytes from a cryptographically secure random source,
 * returned as the unpadded base64url encoding (the token key cookie value).
 */
export function generateTokenKey(): string {
  return crypto.randomBytes(TOKEN_KEY_BYTES).toString('base64url');
}

/**
 * Strict parse of a cookie value into the 32 raw bytes that ARE the AEAD key;
 * null for absent, wrong-length or non-base64url input. The Buffer return type is the
 * boundary: the encoded 43-character string never reaches a cipher.
 *
 * Node's base64url decoder is lenient — it ignores stray characters and accepts
 * padding — so the strict `TOKEN_KEY_PATTERN` gate runs first, and the decoded
 * length is re-checked so a truncated value can never be partially accepted.
 * Never throws; no side effects.
 */
export function parseTokenKey(value: string | undefined): Buffer | null {
  if (typeof value !== 'string' || !TOKEN_KEY_PATTERN.test(value)) {
    return null;
  }

  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== TOKEN_KEY_BYTES) {
    return null;
  }

  return decoded;
}

/**
 * `base64url(sha256(key))` — the custody store lookup key and the marker cookie
 * `tokenKeyHash` claim. Hashes the 32 raw bytes, never the encoded string, and is
 * the single function behind both consumers so they are byte-identical for the same
 * key. Deterministic, 43-character base64url, infeasible to invert.
 */
export function hashTokenKey(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('base64url');
}

/**
 * Reads and parses the token key cookie from an incoming request, returning the
 * 32-byte key or null when the cookie is absent or malformed.
 */
export function readTokenKey(req: Request): Buffer | null {
  const cookie = (req.cookies as Record<string, string> | undefined)?.[TOKEN_KEY_COOKIE];
  return parseTokenKey(cookie);
}
