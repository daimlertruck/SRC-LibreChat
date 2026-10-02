import crypto from 'node:crypto';
import type { CustodyTokenPayload, TokenCustodyIdentity } from './aead';
import { openTokens, sealTokens } from './aead';
import { hashTokenKey } from './key';

const fullPayload: CustodyTokenPayload = {
  accessToken: 'access-token',
  idToken: 'id-token',
  refreshToken: 'refresh-token',
  accessTokenExpiresAt: 1_700_000_300_000,
  refreshTokenExpiresAt: 1_700_086_400_000,
  issuedAt: 1_700_000_000_000,
};

const fullIdentity: TokenCustodyIdentity = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  openidIssuer: 'https://issuer.example',
  openidSubject: 'subject-1',
};

describe('sealTokens', () => {
  it.each<[string, Buffer, CustodyTokenPayload, TokenCustodyIdentity]>([
    ['a full payload and identity', crypto.randomBytes(32), fullPayload, fullIdentity],
    [
      'a minimal payload and identity',
      crypto.randomBytes(32),
      { accessToken: 'a', refreshToken: 'r', issuedAt: 0 },
      { userId: 'u' },
    ],
    [
      'an 8 KB unicode payload',
      crypto.randomBytes(32),
      { ...fullPayload, accessToken: 'é'.repeat(4096), refreshToken: '🔑'.repeat(2048) },
      fullIdentity,
    ],
    ['an all-zero key', Buffer.alloc(32), fullPayload, fullIdentity],
  ])('seals identical input to distinct blobs for %s', (_label, key, payload, identity) => {
    const hash = hashTokenKey(key);
    const first = sealTokens(key, payload, hash, identity);
    const second = sealTokens(key, payload, hash, identity);

    expect(first).not.toBe(second);
    expect(first.split(':')[1]).not.toBe(second.split(':')[1]);
  });

  it('draws a fresh IV on every seal, and every blob still opens', () => {
    const key = crypto.randomBytes(32);
    const hash = hashTokenKey(key);
    const blobs = Array.from({ length: 20 }, () =>
      sealTokens(key, fullPayload, hash, fullIdentity),
    );

    expect(new Set(blobs).size).toBe(blobs.length);
    expect(new Set(blobs.map((blob) => blob.split(':')[1])).size).toBe(blobs.length);
    for (const blob of blobs) {
      expect(openTokens(key, blob, hash, fullIdentity)).toEqual(fullPayload);
    }
  });
});
