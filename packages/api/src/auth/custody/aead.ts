import crypto from 'node:crypto';

/**
 * The sealed token set. This is the shape `req.session.openidTokens` carried,
 * minus the browser-held refresh token, the identity fields (unsealed columns and
 * the AEAD associated data) and the record's TTL (derived from the two expiry
 * fields). Both expiry fields also appear as unsealed columns: the sealed copy
 * travels with the token set it describes, the unsealed copy is what a keyless
 * reader and the TTL sweeper can see.
 */
export interface CustodyTokenPayload {
  accessToken: string;
  idToken?: string;
  refreshToken: string;
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
  issuedAt: number;
}

/** The sealed blob format tag and the first colon-separated part of every blob. */
export const CUSTODY_FORMAT = 'kc1';

/** 96-bit IV, drawn fresh from a CSPRNG on every seal. */
const IV_BYTES = 12;

/** 128-bit GCM authentication tag. */
const TAG_BYTES = 16;

/** The raw AES-256-GCM key is exactly 32 bytes. */
const KEY_BYTES = 32;

/** The identity a sealed blob is bound to through the AEAD associated data. */
export interface TokenCustodyIdentity {
  userId: string;
  tenantId?: string;
  openidIssuer?: string;
  openidSubject?: string;
}

/**
 * The error `openTokens` raises. `reason` distinguishes a structurally invalid
 * blob (`'format'`, raised before any decryption) from a failed GCM verification
 * (`'authentication'`). Neither the key, the sealed blob nor any of its components
 * is carried in the message or on any own property, so a leaked error reveals
 * nothing about the material it failed on.
 */
export class CustodyOpenError extends Error {
  readonly reason: 'format' | 'authentication';

  constructor(reason: 'format' | 'authentication') {
    super(`custody blob failed to open: ${reason}`);
    this.name = 'CustodyOpenError';
    this.reason = reason;
  }
}

/**
 * The one place the AAD encoding lives:
 *   utf8(JSON.stringify(['kc1', tokenKeyHash, identity.userId,
 *                        identity.tenantId ?? null, identity.openidIssuer ?? null,
 *                        identity.openidSubject ?? null]))
 *
 * Fixed length, fixed order, absent optional fields as `null` — never `''`, so an
 * absent field and an empty one are different AAD and cannot open each other. JSON
 * string escaping keeps a field value from altering the array's structure, so no
 * value can impersonate a separator, and `JSON.stringify` over an array of strings
 * and nulls is deterministic. Both `sealTokens` and `openTokens` obtain their AAD
 * from this function and never build it themselves, so the two cannot disagree.
 */
export function custodyAad(tokenKeyHash: string, identity: TokenCustodyIdentity): Buffer {
  return Buffer.from(
    JSON.stringify([
      CUSTODY_FORMAT,
      tokenKeyHash,
      identity.userId,
      identity.tenantId ?? null,
      identity.openidIssuer ?? null,
      identity.openidSubject ?? null,
    ]),
    'utf8',
  );
}

/**
 * Seals a token set under a 32-byte token key with AES-256-GCM, binding the
 * ciphertext to `tokenKeyHash` and `identity` through the AAD. A fresh 96-bit IV is
 * drawn on every call, so two seals of identical input differ. The key material is
 * accepted only as the 32 raw bytes; no key-derivation step runs, so the encoded
 * cookie value must never be passed here.
 *
 * Throws (before producing any blob) when the key is not exactly 32 bytes or when
 * `accessToken` or `refreshToken` is the empty string.
 */
export function sealTokens(
  aeadKey: Buffer,
  payload: CustodyTokenPayload,
  tokenKeyHash: string,
  identity: TokenCustodyIdentity,
): string {
  if (aeadKey.length !== KEY_BYTES) {
    throw new Error(`custody key must be exactly ${KEY_BYTES} bytes`);
  }
  if (payload.accessToken === '' || payload.refreshToken === '') {
    throw new Error('custody payload accessToken and refreshToken must be non-empty');
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', aeadKey, iv);
  cipher.setAAD(custodyAad(tokenKeyHash, identity));

  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    CUSTODY_FORMAT,
    iv.toString('base64url'),
    tag.toString('base64url'),
    body.toString('base64url'),
  ].join(':');
}

/**
 * Opens a sealed blob, returning the token set only when GCM verification
 * succeeds under the supplied key, `tokenKeyHash` and `identity`. A structurally
 * invalid blob raises `CustodyOpenError('format')` before any decryption is
 * attempted; a wrong key, a mismatched hash or identity, or a tampered component
 * raises `CustodyOpenError('authentication')`. No partial plaintext is ever
 * returned: `decipher.final()` verifies the tag before the plaintext is used.
 */
export function openTokens(
  aeadKey: Buffer,
  sealed: string,
  tokenKeyHash: string,
  identity: TokenCustodyIdentity,
): CustodyTokenPayload {
  const parts = sealed.split(':');
  if (parts.length !== 4 || parts[0] !== CUSTODY_FORMAT) {
    throw new CustodyOpenError('format');
  }

  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const body = Buffer.from(parts[3], 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new CustodyOpenError('format');
  }

  let plain: Buffer;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', aeadKey, iv);
    decipher.setAAD(custodyAad(tokenKeyHash, identity));
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new CustodyOpenError('authentication');
  }

  return JSON.parse(plain.toString('utf8')) as CustodyTokenPayload;
}
