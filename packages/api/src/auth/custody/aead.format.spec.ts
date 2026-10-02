import crypto from 'node:crypto';

import {
  CUSTODY_FORMAT,
  CustodyOpenError,
  openTokens,
  sealTokens,
  type CustodyTokenPayload,
  type TokenCustodyIdentity,
} from './aead';
import { generateTokenKey } from './key';

/**
 * Format rejection and `CustodyOpenError` secrecy; round-trip, wrong-key, binding,
 * tamper and nondeterminism live in the sibling `aead.*.spec.ts` files.
 */

/** A fresh 32-byte AES key, the only key material `sealTokens`/`openTokens` accept. */
function freshKey(): Buffer {
  return crypto.randomBytes(32);
}

/** A well-formed payload, sealed once to produce a valid blob for reshaping. */
function samplePayload(): CustodyTokenPayload {
  return {
    accessToken: 'access-token-value',
    idToken: 'id-token-value',
    refreshToken: 'refresh-token-value',
    accessTokenExpiresAt: 1_000,
    refreshTokenExpiresAt: 2_000,
    issuedAt: 500,
  };
}

const identity: TokenCustodyIdentity = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  openidIssuer: 'https://issuer.example',
  openidSubject: 'subject-1',
};

const tokenKeyHash = 'a'.repeat(43);

/**
 * Every non-secret argument used to build a well-formed blob, so a format
 * rejection is provably independent of the key, hash and identity supplied.
 */
function open(sealed: string): void {
  openTokens(freshKey(), sealed, tokenKeyHash, identity);
}

describe('openTokens format validation', () => {
  let validBlob: string;
  let parts: string[];

  beforeEach(() => {
    validBlob = sealTokens(freshKey(), samplePayload(), tokenKeyHash, identity);
    parts = validBlob.split(':');
  });

  it('seals to the four-part `kc1:iv:tag:ciphertext` shape the rejection cases reshape', () => {
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe(CUSTODY_FORMAT);
  });

  it('rejects a blob with fewer than four parts as reason "format"', () => {
    const threeParts = [parts[0], parts[1], parts[2]].join(':');
    expect(() => open(threeParts)).toThrow(CustodyOpenError);
    try {
      open(threeParts);
    } catch (err) {
      expect((err as CustodyOpenError).reason).toBe('format');
    }
  });

  it('rejects a blob with more than four parts as reason "format"', () => {
    const fiveParts = [...parts, parts[3]].join(':');
    try {
      open(fiveParts);
      throw new Error('expected openTokens to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CustodyOpenError);
      expect((err as CustodyOpenError).reason).toBe('format');
    }
  });

  it('rejects a first part other than "kc1" as reason "format"', () => {
    const wrongTag = ['kc2', parts[1], parts[2], parts[3]].join(':');
    try {
      open(wrongTag);
      throw new Error('expected openTokens to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CustodyOpenError);
      expect((err as CustodyOpenError).reason).toBe('format');
    }
  });

  it('rejects an IV that decodes to a length other than 12 bytes as reason "format"', () => {
    // 11-byte IV: a real base64url value of the wrong decoded length, not garbage.
    const shortIv = crypto.randomBytes(11).toString('base64url');
    const badIv = [parts[0], shortIv, parts[2], parts[3]].join(':');
    try {
      open(badIv);
      throw new Error('expected openTokens to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CustodyOpenError);
      expect((err as CustodyOpenError).reason).toBe('format');
    }
  });

  it('rejects a tag that decodes to a length other than 16 bytes as reason "format"', () => {
    // 15-byte tag: a real base64url value of the wrong decoded length.
    const shortTag = crypto.randomBytes(15).toString('base64url');
    const badTag = [parts[0], parts[1], shortTag, parts[3]].join(':');
    try {
      open(badTag);
      throw new Error('expected openTokens to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CustodyOpenError);
      expect((err as CustodyOpenError).reason).toBe('format');
    }
  });

  it('does not attempt decryption on a format failure: rejects even a wrong-length IV that is valid base64url', () => {
    // A 12-byte-but-wrong IV would reach GCM (authentication); a 13-byte IV must
    // be rejected as "format" before any cipher is constructed. The distinction
    // proves the length gate runs ahead of decryption.
    const longIv = crypto.randomBytes(13).toString('base64url');
    const badIv = [parts[0], longIv, parts[2], parts[3]].join(':');
    try {
      open(badIv);
      throw new Error('expected openTokens to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CustodyOpenError);
      expect((err as CustodyOpenError).reason).toBe('format');
    }
  });
});

describe('CustodyOpenError hygiene', () => {
  it('carries no key bytes, no base64url key and no ciphertext component in message or own properties', () => {
    const key = freshKey();
    const keyBase64Url = key.toString('base64url');
    const keyBase64 = key.toString('base64');
    const keyHex = key.toString('hex');

    const sealed = sealTokens(key, samplePayload(), tokenKeyHash, identity);
    const ciphertextComponent = sealed.split(':')[3];

    // Force an authentication failure with a different key, then a format
    // failure with a mangled blob; inspect both errors for leakage.
    const errors: CustodyOpenError[] = [];
    try {
      openTokens(freshKey(), sealed, tokenKeyHash, identity);
    } catch (err) {
      errors.push(err as CustodyOpenError);
    }
    try {
      openTokens(key, 'not-a-valid-blob', tokenKeyHash, identity);
    } catch (err) {
      errors.push(err as CustodyOpenError);
    }

    expect(errors).toHaveLength(2);
    expect(errors[0].reason).toBe('authentication');
    expect(errors[1].reason).toBe('format');

    for (const err of errors) {
      // Everything a serializer could reach: message plus own enumerable and
      // non-enumerable properties (name, reason, message, stack, and any extra).
      const surfaces: string[] = [err.message];
      for (const prop of Object.getOwnPropertyNames(err)) {
        const value = (err as unknown as Record<string, unknown>)[prop];
        if (typeof value === 'string') {
          surfaces.push(value);
        }
      }
      const haystack = surfaces.join('\n');

      // No key material in any encoding.
      expect(haystack).not.toContain(keyBase64Url);
      expect(haystack).not.toContain(keyBase64);
      expect(haystack).not.toContain(keyHex);
      // No ciphertext component of the sealed blob.
      expect(haystack).not.toContain(ciphertextComponent);
      // Sanity: the reason string is the only structural detail exposed.
      expect(err.name).toBe('CustodyOpenError');
    }
  });
});

describe('sealTokens key validation', () => {
  it('throws rather than sealing when the 43-byte base64url cookie value is passed as the key', () => {
    // The token key cookie is a 43-character base64url string; its UTF-8 bytes
    // number 43, not 32. Passing it where the decoded 32-byte key belongs must
    // throw before any blob is produced, not silently seal under bad material.
    const encoded = generateTokenKey();
    expect(encoded).toHaveLength(43);

    const encodedAsKey = Buffer.from(encoded, 'utf8');
    expect(encodedAsKey.length).toBe(43);

    let sealed: string | undefined;
    expect(() => {
      sealed = sealTokens(encodedAsKey, samplePayload(), tokenKeyHash, identity);
    }).toThrow();
    expect(sealed).toBeUndefined();
  });

  it('also rejects the raw 43-byte length regardless of content', () => {
    const fortyThreeBytes = crypto.randomBytes(43);
    expect(() => sealTokens(fortyThreeBytes, samplePayload(), tokenKeyHash, identity)).toThrow();
  });
});
