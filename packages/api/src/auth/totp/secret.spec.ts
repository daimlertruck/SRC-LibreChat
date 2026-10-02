import crypto from 'node:crypto';

import { readTotpSecret, __resetTotpKeyForTests } from './secret';

/**
 * With `TOTP_KEY` unset, `readTotpSecret` must return what the legacy
 * `CREDS_KEY`-based `getTOTPSecret` returns for every stored format, and throw
 * wherever it throws. `__resetTotpKeyForTests` clears the memoized key so each
 * case sees the current env.
 */

const CTR_ALGORITHM = 'aes-256-ctr';
const CBC_ALGORITHM = 'aes-256-cbc';

/** A fixed, known 32-byte `CREDS_KEY` (64 hex chars) shared by fixtures and the reference. */
const CREDS_KEY_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const CREDS_KEY = Buffer.from(CREDS_KEY_HEX, 'hex');

/** A distinct, valid 32-byte `TOTP_KEY` used only for the override contrast case. */
const TOTP_KEY_HEX = 'ffffeeeeddddccccbbbbaaaa9999888877776666555544443333222211110000';
const TOTP_KEY = Buffer.from(TOTP_KEY_HEX, 'hex');

/** Encrypt a plaintext as a `v3:` blob (AES-256-CTR) under the given key, matching encryptV3. */
function encryptV3Under(value: string, key: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(CTR_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v3:${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

/** Encrypt a plaintext as a v2 `iv:ciphertext` blob (AES-256-CBC) under the given key, matching encryptV2. */
function encryptV2Under(value: string, key: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(CBC_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * The reference: today's `getTOTPSecret` behavior, mirroring the crypto module's
 * `decryptV3` / `decryptV2` dispatch under the supplied key. Returns the string
 * on success and throws wherever the crypto module would throw.
 */
function legacyGetTOTPSecret(storedSecret: string | null, key: Buffer): string | null {
  if (!storedSecret) {
    return null;
  }
  if (storedSecret.startsWith('v3:')) {
    const parts = storedSecret.split(':');
    const iv = Buffer.from(parts[1], 'hex');
    const encryptedText = Buffer.from(parts.slice(2).join(':'), 'hex');
    const decipher = crypto.createDecipheriv(CTR_ALGORITHM, key, iv);
    const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
    return decrypted.toString('utf8');
  }
  if (storedSecret.includes(':')) {
    const parts = storedSecret.split(':');
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
  if (storedSecret.length === 16) {
    return storedSecret;
  }
  return storedSecret;
}

/**
 * Compares `readTotpSecret(stored)` against `legacyGetTOTPSecret(stored, key)`,
 * asserting both return the same value or both throw. Runs the resolver with the
 * key memoization reset so the current `CREDS_KEY` / `TOTP_KEY` env is used.
 */
async function assertAgrees(stored: string | null, key: Buffer): Promise<void> {
  let legacyValue: string | null | undefined;
  let legacyThrew = false;
  try {
    legacyValue = legacyGetTOTPSecret(stored, key);
  } catch {
    legacyThrew = true;
  }

  __resetTotpKeyForTests();
  let resolverValue: string | null | undefined;
  let resolverThrew = false;
  try {
    resolverValue = await readTotpSecret(stored);
  } catch {
    resolverThrew = true;
  }

  expect(resolverThrew).toBe(legacyThrew);
  if (!legacyThrew) {
    expect(resolverValue).toBe(legacyValue);
  }
}

/** Plaintexts encrypted for the v3 and v2 cases. */
const plaintexts: Array<[string, string]> = [
  ['empty', ''],
  ['ascii', 'JBSWY3DPEHPK3PXP'],
  ['unicode', 'sécret-🔐-秘密'],
  ['long', 'A'.repeat(1024)],
];

describe('readTotpSecret with TOTP_KEY unset', () => {
  const originalTotpKey = process.env.TOTP_KEY;
  const originalCredsKey = process.env.CREDS_KEY;

  beforeEach(() => {
    delete process.env.TOTP_KEY;
    process.env.CREDS_KEY = CREDS_KEY_HEX;
    __resetTotpKeyForTests();
  });

  afterAll(() => {
    if (originalTotpKey === undefined) {
      delete process.env.TOTP_KEY;
    } else {
      process.env.TOTP_KEY = originalTotpKey;
    }
    if (originalCredsKey === undefined) {
      delete process.env.CREDS_KEY;
    } else {
      process.env.CREDS_KEY = originalCredsKey;
    }
    __resetTotpKeyForTests();
  });

  it.each(plaintexts)(
    'agrees with legacy decryption on a v3 secret (%s)',
    async (_label, secret) => {
      expect.hasAssertions();
      await assertAgrees(encryptV3Under(secret, CREDS_KEY), CREDS_KEY);
    },
  );

  it.each(plaintexts)(
    'agrees with legacy decryption on a v2 (CBC) colon-delimited secret (%s)',
    async (_label, secret) => {
      expect.hasAssertions();
      await assertAgrees(encryptV2Under(secret, CREDS_KEY), CREDS_KEY);
    },
  );

  it.each([['JBSWY3DPEHPK3PXP'], ['abcdefghijklmnop'], ['0123456789abcdef'], ['ünïcödé-sécrêt!!']])(
    'returns a bare 16-character secret unchanged, as legacy does (%s)',
    async (secret) => {
      expect.hasAssertions();
      await assertAgrees(secret, CREDS_KEY);
    },
  );

  it.each([
    ['null', null],
    ['empty', ''],
    ['short', 'abc'],
    ['15 chars', 'A'.repeat(15)],
    ['17 chars', 'A'.repeat(17)],
    ['no colons, with spaces', 'not a colon value'],
    ['v3 without its colon', 'v3abcdef'],
  ])('returns other strings as legacy does (%s)', async (_label, secret) => {
    expect.hasAssertions();
    await assertAgrees(secret, CREDS_KEY);
  });

  it.each([
    ['garbage components', 'a:b'],
    ['bare colon', ':'],
    ['non-hex components', 'zz:zz'],
    ['truncated v2 ciphertext', encryptV2Under('JBSWY3DPEHPK3PXP', CREDS_KEY).slice(0, -2)],
    ['v3 with a short iv', 'v3:abcd:ef'],
  ])('fails the same way as legacy on a malformed colon value (%s)', async (_label, stored) => {
    expect.hasAssertions();
    await assertAgrees(stored, CREDS_KEY);
  });

  it.each([['JBSWY3DPEHPK3PXP'], ['sécret-🔐'], ['A'.repeat(64)]])(
    'with a distinct TOTP_KEY set, opens secrets sealed under it but not under CREDS_KEY (%s)',
    async (secret) => {
      // The equivalence above holds because TOTP_KEY is unset; setting it changes the key.
      process.env.TOTP_KEY = TOTP_KEY_HEX;

      __resetTotpKeyForTests();
      expect(await readTotpSecret(encryptV3Under(secret, TOTP_KEY))).toBe(secret);

      __resetTotpKeyForTests();
      // CTR has no authentication tag, so a wrong key yields garbage rather than a throw.
      expect(await readTotpSecret(encryptV3Under(secret, CREDS_KEY))).not.toBe(secret);
    },
  );
});
