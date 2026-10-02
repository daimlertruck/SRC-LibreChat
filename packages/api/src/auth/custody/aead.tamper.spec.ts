import crypto from 'node:crypto';
import type { CustodyTokenPayload, TokenCustodyIdentity } from './aead';
import { CustodyOpenError, openTokens, sealTokens } from './aead';
import { hashTokenKey } from './key';

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

/** Low bit, high bit and every bit, so each position is flipped in three distinct ways. */
const FLIP_MASKS = [0x01, 0x80, 0xff];

/** The reason `openTokens` failed with, or undefined when it returned or threw something else. */
function failureReason(open: () => CustodyTokenPayload): CustodyOpenError['reason'] | undefined {
  try {
    open();
  } catch (error) {
    return error instanceof CustodyOpenError ? error.reason : undefined;
  }
  return undefined;
}

describe('openTokens on a tampered blob', () => {
  const key = crypto.randomBytes(32);
  const hash = hashTokenKey(key);
  const sealed = sealTokens(key, payload, hash, identity);
  const parts = sealed.split(':');

  it('opens the untampered blob', () => {
    expect(openTokens(key, sealed, hash, identity)).toEqual(payload);
  });

  /**
   * Decodes one component, flips a single byte, re-encodes it and reassembles the
   * `kc1:iv:tag:ciphertext` blob. Every position of the component is covered, so
   * GCM must reject the change wherever it lands rather than decrypting into a
   * different payload.
   */
  it.each<[string, number]>([
    ['IV', 1],
    ['tag', 2],
    ['ciphertext', 3],
  ])('rejects a flip of every byte of the %s', (_label, index) => {
    const component = Buffer.from(parts[index], 'base64url');
    expect(component.length).toBeGreaterThan(0);

    const accepted: string[] = [];
    for (let position = 0; position < component.length; position++) {
      for (const mask of FLIP_MASKS) {
        const mutated = Buffer.from(component);
        mutated[position] ^= mask;
        const tampered = [...parts];
        tampered[index] = mutated.toString('base64url');

        const reason = failureReason(() => openTokens(key, tampered.join(':'), hash, identity));
        if (reason !== 'authentication') {
          accepted.push(`byte ${position} mask ${mask}: ${reason}`);
        }
      }
    }
    expect(accepted).toEqual([]);
  });
});
