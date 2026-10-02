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

const key = Buffer.from(Array.from({ length: TOKEN_KEY_BYTES }, (_, i) => i));
const sealingHash = hashTokenKey(key);

/** The reason `openTokens` failed with, or undefined when it returned or threw something else. */
function failureReason(open: () => CustodyTokenPayload): CustodyOpenError['reason'] | undefined {
  try {
    open();
  } catch (error) {
    return error instanceof CustodyOpenError ? error.reason : undefined;
  }
  return undefined;
}

/** Opens with the sealing key and identity, so the hash is the only differing input. */
function openWithHash(sealHash: string, openHash: string): CustodyOpenError['reason'] | undefined {
  const sealed = sealTokens(key, payload, sealHash, identity);
  return failureReason(() => openTokens(key, sealed, openHash, identity));
}

function replaceCharAt(value: string, position: number): string {
  const replacement = value[position] === 'A' ? 'B' : 'A';
  return `${value.slice(0, position)}${replacement}${value.slice(position + 1)}`;
}

describe('openTokens with a different token key hash', () => {
  it.each<[string, string]>([
    ['the hash of another key', hashTokenKey(Buffer.alloc(TOKEN_KEY_BYTES))],
    ['the empty string', ''],
    ['the hash with one character appended', `${sealingHash}A`],
    ['the hash truncated by one character', sealingHash.slice(0, -1)],
    ['the hash in a different letter case', sealingHash.toUpperCase()],
    ['the hash with padding', `${sealingHash}=`],
    ['the base64url of the key itself', key.toString('base64url')],
  ])('rejects a blob opened with %s', (_label, openHash) => {
    expect(openHash).not.toBe(sealingHash);
    expect(openWithHash(sealingHash, openHash)).toBe('authentication');
  });

  it('rejects a hash differing from the sealing hash in any single character', () => {
    const accepted: number[] = [];
    for (let position = 0; position < sealingHash.length; position++) {
      if (openWithHash(sealingHash, replaceCharAt(sealingHash, position)) !== 'authentication') {
        accepted.push(position);
      }
    }
    expect(accepted).toEqual([]);
  });

  it('rejects a non-empty hash on a blob sealed with an empty hash', () => {
    expect(openWithHash('', sealingHash)).toBe('authentication');
  });

  it('opens with the sealing hash', () => {
    const sealed = sealTokens(key, payload, sealingHash, identity);
    expect(openTokens(key, sealed, sealingHash, identity)).toEqual(payload);
  });
});
