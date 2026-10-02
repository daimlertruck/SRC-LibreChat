import crypto from 'node:crypto';
import type { CustodyTokenPayload, TokenCustodyIdentity } from './aead';
import { CustodyOpenError, openTokens, sealTokens } from './aead';
import { TOKEN_KEY_BYTES, hashTokenKey } from './key';

const payload: CustodyTokenPayload = {
  accessToken: 'access-token',
  idToken: 'id-token',
  refreshToken: 'refresh-token',
  accessTokenExpiresAt: 1_700_000_300_000,
  refreshTokenExpiresAt: 1_700_086_400_000,
  issuedAt: 1_700_000_000_000,
};

const identity: TokenCustodyIdentity = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  openidIssuer: 'https://issuer.example',
  openidSubject: 'subject-1',
};

/** The reason `openTokens` failed with, or undefined when it returned or threw something else. */
function failureReason(open: () => CustodyTokenPayload): CustodyOpenError['reason'] | undefined {
  try {
    open();
  } catch (error) {
    return error instanceof CustodyOpenError ? error.reason : undefined;
  }
  return undefined;
}

/**
 * Opens with `openKey` while presenting the sealing hash and identity, so the key
 * is the only wrong input and the failure is not hash or identity binding.
 */
function openWithKey(sealKey: Buffer, openKey: Buffer): CustodyOpenError['reason'] | undefined {
  const hash = hashTokenKey(sealKey);
  const sealed = sealTokens(sealKey, payload, hash, identity);
  return failureReason(() => openTokens(openKey, sealed, hash, identity));
}

function withFlippedByte(key: Buffer, position: number): Buffer {
  const flipped = Buffer.from(key);
  flipped[position] ^= 0x01;
  return flipped;
}

describe('openTokens with the wrong key', () => {
  it.each<[string, string, Buffer, Buffer]>([
    ['all-zero', 'all-0xff', Buffer.alloc(TOKEN_KEY_BYTES), Buffer.alloc(TOKEN_KEY_BYTES, 0xff)],
    ['all-0xff', 'all-zero', Buffer.alloc(TOKEN_KEY_BYTES, 0xff), Buffer.alloc(TOKEN_KEY_BYTES)],
    ['all-zero', 'random', Buffer.alloc(TOKEN_KEY_BYTES), crypto.randomBytes(TOKEN_KEY_BYTES)],
  ])(
    'rejects a blob sealed under the %s key and opened with the %s key',
    (_s, _o, sealKey, openKey) => {
      expect(openWithKey(sealKey, openKey)).toBe('authentication');
    },
  );

  it('rejects a key differing from the sealing key in any single byte', () => {
    const sealKey = crypto.randomBytes(TOKEN_KEY_BYTES);
    const accepted: number[] = [];
    for (let position = 0; position < TOKEN_KEY_BYTES; position++) {
      if (openWithKey(sealKey, withFlippedByte(sealKey, position)) !== 'authentication') {
        accepted.push(position);
      }
    }
    expect(accepted).toEqual([]);
  });

  it('rejects unrelated random keys', () => {
    for (let i = 0; i < 10; i++) {
      const sealKey = crypto.randomBytes(TOKEN_KEY_BYTES);
      const openKey = crypto.randomBytes(TOKEN_KEY_BYTES);
      expect(openKey.equals(sealKey)).toBe(false);
      expect(openWithKey(sealKey, openKey)).toBe('authentication');
    }
  });

  it('rejects the wrong key for a minimal identity and payload', () => {
    const sealKey = crypto.randomBytes(TOKEN_KEY_BYTES);
    const minimalIdentity: TokenCustodyIdentity = { userId: 'user-1' };
    const minimalPayload: CustodyTokenPayload = {
      accessToken: 'a',
      refreshToken: 'r',
      issuedAt: 0,
    };
    const hash = hashTokenKey(sealKey);
    const sealed = sealTokens(sealKey, minimalPayload, hash, minimalIdentity);
    const openKey = withFlippedByte(sealKey, 0);

    expect(failureReason(() => openTokens(openKey, sealed, hash, minimalIdentity))).toBe(
      'authentication',
    );
  });
});
