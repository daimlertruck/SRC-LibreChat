import crypto from 'node:crypto';
import type { CustodyTokenPayload, TokenCustodyIdentity } from './aead';
import { openTokens, sealTokens } from './aead';
import { hashTokenKey } from './key';

const fullIdentity: TokenCustodyIdentity = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  openidIssuer: 'https://issuer.example',
  openidSubject: 'subject-1',
};

const fullPayload: CustodyTokenPayload = {
  accessToken: 'access-token',
  idToken: 'id-token',
  refreshToken: 'refresh-token',
  accessTokenExpiresAt: 1_700_000_300_000,
  refreshTokenExpiresAt: 1_700_086_400_000,
  issuedAt: 1_700_000_000_000,
};

function roundTrip(
  key: Buffer,
  payload: CustodyTokenPayload,
  identity: TokenCustodyIdentity,
): CustodyTokenPayload {
  const hash = hashTokenKey(key);
  return openTokens(key, sealTokens(key, payload, hash, identity), hash, identity);
}

describe('sealTokens / openTokens round trip', () => {
  it.each<[string, CustodyTokenPayload]>([
    ['only the required fields', { accessToken: 'a', refreshToken: 'r', issuedAt: 1 }],
    ['every optional field', fullPayload],
    ['an empty idToken', { ...fullPayload, idToken: '' }],
    [
      'multi-byte unicode tokens',
      { ...fullPayload, accessToken: 'jeton-é-日本-🔑', refreshToken: '🔄'.repeat(32) },
    ],
    [
      'JSON-significant characters',
      { ...fullPayload, accessToken: '"},{"x":"', refreshToken: '\\\n\t\u0000' },
    ],
    ['8 KB tokens', { ...fullPayload, accessToken: 'a'.repeat(8192), idToken: 'i'.repeat(8192) }],
    [
      'zero timestamps',
      { ...fullPayload, accessTokenExpiresAt: 0, refreshTokenExpiresAt: 0, issuedAt: 0 },
    ],
    [
      'the largest safe integer timestamps',
      {
        ...fullPayload,
        accessTokenExpiresAt: Number.MAX_SAFE_INTEGER,
        refreshTokenExpiresAt: Number.MAX_SAFE_INTEGER,
        issuedAt: Number.MAX_SAFE_INTEGER,
      },
    ],
    ['a negative timestamp', { ...fullPayload, issuedAt: -1 }],
  ])('returns a payload with %s unchanged', (_label, payload) => {
    expect(roundTrip(crypto.randomBytes(32), payload, fullIdentity)).toEqual(payload);
  });

  /** Every present/absent combination of the three optional identity fields. */
  it.each<TokenCustodyIdentity>([
    { userId: 'user-1' },
    { userId: 'user-1', tenantId: 'tenant-1' },
    { userId: 'user-1', openidIssuer: 'https://issuer.example' },
    { userId: 'user-1', openidSubject: 'subject-1' },
    { userId: 'user-1', tenantId: 'tenant-1', openidIssuer: 'https://issuer.example' },
    { userId: 'user-1', tenantId: 'tenant-1', openidSubject: 'subject-1' },
    { userId: 'user-1', openidIssuer: 'https://issuer.example', openidSubject: 'subject-1' },
    fullIdentity,
    { userId: 'user-1', tenantId: '', openidIssuer: '', openidSubject: '' },
    { userId: 'ユーザー', tenantId: 'tenant-é', openidSubject: '🔑' },
  ])('opens under the sealing identity %j', (identity) => {
    expect(roundTrip(crypto.randomBytes(32), fullPayload, identity)).toEqual(fullPayload);
  });

  it.each<[string, Buffer]>([
    ['all-zero', Buffer.alloc(32)],
    ['all-0xff', Buffer.alloc(32, 0xff)],
    ['ascending', Buffer.from(Array.from({ length: 32 }, (_, i) => i))],
  ])('opens under an %s key', (_label, key) => {
    expect(roundTrip(key, fullPayload, fullIdentity)).toEqual(fullPayload);
  });

  it('opens under freshly generated random keys', () => {
    for (let i = 0; i < 10; i++) {
      expect(roundTrip(crypto.randomBytes(32), fullPayload, fullIdentity)).toEqual(fullPayload);
    }
  });
});
