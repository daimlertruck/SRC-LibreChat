import crypto from 'node:crypto';

/**
 * The TOTP encryption key resolver.
 *
 * `TOTP_KEY` narrows *which* key decrypts stored two-factor secrets; it does not
 * remove the need for a server-held key. Two-factor verification runs before the
 * user is authenticated, so no user-held key is available at the time it runs.
 *
 * The rule is a single resolution with no switches: `TOTP_KEY` when it is set to
 * exactly 64 hexadecimal characters, otherwise the `CREDS_KEY` value in effect
 * after credential bootstrap. An operator who sets nothing sees today's behavior
 * exactly, because the resolved key is then byte-identical to the `CREDS_KEY` the
 * `packages/data-schemas` crypto module binds.
 *
 * Resolution is lazy and memoized: `packages/data-schemas`'s crypto module binds
 * `CREDS_KEY` at import time, so the TOTP path must resolve *after*
 * `bootstrapCredentials()` has run, not at module load. Once resolved the result is
 * cached for the lifetime of the process, so later mutations of `TOTP_KEY` or
 * `CREDS_KEY` in the environment do not change the key.
 */

const TOTP_KEY_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const CTR_ALGORITHM = 'aes-256-ctr';
const CBC_ALGORITHM = 'aes-256-cbc';

/**
 * Whether a raw environment value counts as configured. Absent, empty and
 * whitespace-only all read as unset — the same test the existing `CREDS_KEY` /
 * `CREDS_IV` validation uses for an unconfigured value.
 */
function isConfigured(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

let memoizedKey: Buffer | null = null;

/**
 * Resolves the TOTP encryption key on first use and memoizes it.
 *
 * - `TOTP_KEY` set to exactly 64 hex characters (32 bytes) is used in place of
 *   `CREDS_KEY`.
 * - `TOTP_KEY` set to anything else throws, naming the variable, the required
 *   length and the same restore-or-migrate guidance as the `CREDS_KEY` /
 *   `CREDS_IV` validation, so a malformed value fails at startup before any
 *   request is served rather than silently orphaning every stored secret.
 * - `TOTP_KEY` unset (absent, empty or whitespace-only) falls back to `CREDS_KEY`,
 *   decoded exactly as the crypto module decodes it, so the default reproduces
 *   today's behavior byte for byte.
 */
function resolveTotpKey(): Buffer {
  if (memoizedKey) {
    return memoizedKey;
  }

  const totpKey = process.env.TOTP_KEY;
  if (isConfigured(totpKey)) {
    if (!TOTP_KEY_HEX_PATTERN.test(totpKey)) {
      throw new Error(
        '[totp] TOTP_KEY must be exactly 64 hexadecimal characters (32 bytes). ' +
          'Refusing startup to prevent weak encryption or late crypto failures. ' +
          'Restore the original credential if it protects existing data; plan a controlled migration before rotating it.',
      );
    }
    memoizedKey = Buffer.from(totpKey, 'hex');
    return memoizedKey;
  }

  memoizedKey = Buffer.from(process.env.CREDS_KEY ?? '', 'hex');
  return memoizedKey;
}

/**
 * AES-256-CTR decryption for `v3:` values under a caller-supplied key, mirroring
 * `decryptV3` in the crypto module but taking the resolved TOTP key rather than the
 * module-bound `CREDS_KEY`. V3 is CTR with no tag, so a wrong key yields garbage
 * rather than a clean failure — which is exactly why the `v3:` prefix is kept as
 * the only detectable signal of the format.
 */
function decryptV3WithKey(encryptedValue: string, key: Buffer): string {
  const parts = encryptedValue.split(':');
  if (parts[0] !== 'v3') {
    throw new Error('Not a v3 encrypted value');
  }
  const iv = Buffer.from(parts[1], 'hex');
  const encryptedText = Buffer.from(parts.slice(2).join(':'), 'hex');
  const decipher = crypto.createDecipheriv(CTR_ALGORITHM, key, iv);
  const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * AES-CBC decryption for colon-delimited v2 values under a caller-supplied key,
 * mirroring `decryptV2` in the crypto module. The IV is the first colon-delimited
 * component; a value with no colon is returned as-is, matching the crypto module.
 */
function decryptV2WithKey(encryptedValue: string, key: Buffer): string {
  const parts = encryptedValue.split(':');
  if (parts.length === 1) {
    return parts[0];
  }
  const iv = Buffer.from(parts.shift() ?? '', 'hex');
  const encrypted = parts.join(':');
  const decipher = crypto.createDecipheriv(CBC_ALGORITHM, key, iv);
  const encryptedBuffer = Buffer.from(encrypted, 'hex');
  const decrypted = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Reads a stored TOTP secret, decrypting under the resolved TOTP key.
 *
 * The prefix dispatch matches `getTOTPSecret`: a `v3:` value is decrypted as V3
 * (even though it also contains a colon), otherwise a value containing a colon is
 * decrypted as V2, otherwise a 16-character value is returned unchanged as a plain
 * secret, and any other value is returned unchanged.
 *
 * With `TOTP_KEY` unset this returns the same value as the previous `getTOTPSecret`
 * for every input class and fails in the same way wherever that function fails.
 */
export async function readTotpSecret(storedSecret: string | null): Promise<string | null> {
  if (!storedSecret) {
    return null;
  }
  const key = resolveTotpKey();
  if (storedSecret.startsWith('v3:')) {
    return decryptV3WithKey(storedSecret, key);
  }
  if (storedSecret.includes(':')) {
    return decryptV2WithKey(storedSecret, key);
  }
  if (storedSecret.length === 16) {
    return storedSecret;
  }
  return storedSecret;
}

/**
 * Test-only reset of the memoized key. Production code never mutates the key after
 * first resolution; this exists so a test can exercise resolution under different
 * `TOTP_KEY` / `CREDS_KEY` environments within one process.
 */
export function __resetTotpKeyForTests(): void {
  memoizedKey = null;
}
