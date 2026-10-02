import type { CustodyTokenPayload, TokenCustodyIdentity } from './aead';
import { CustodyOpenError, custodyAad, openTokens, sealTokens } from './aead';
import { hashTokenKey } from './key';

type OptionalField = 'tenantId' | 'openidIssuer' | 'openidSubject';

const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const hash = hashTokenKey(key);

const payload: CustodyTokenPayload = {
  accessToken: 'access-token',
  idToken: 'id-token',
  refreshToken: 'refresh-token',
  accessTokenExpiresAt: 1_700_000_300_000,
  refreshTokenExpiresAt: 1_700_086_400_000,
  issuedAt: 1_700_000_000_000,
};

const full: TokenCustodyIdentity = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  openidIssuer: 'https://issuer.example',
  openidSubject: 'subject-1',
};

const minimal: TokenCustodyIdentity = { userId: 'user-1' };

function without(identity: TokenCustodyIdentity, field: OptionalField): TokenCustodyIdentity {
  const copy = { ...identity };
  delete copy[field];
  return copy;
}

/** The reason `openTokens` failed with, or undefined when it returned or threw something else. */
function failureReason(open: () => CustodyTokenPayload): CustodyOpenError['reason'] | undefined {
  try {
    open();
  } catch (error) {
    return error instanceof CustodyOpenError ? error.reason : undefined;
  }
  return undefined;
}

function openUnder(
  sealedFor: TokenCustodyIdentity,
  openedAs: TokenCustodyIdentity,
): CustodyOpenError['reason'] | undefined {
  const sealed = sealTokens(key, payload, hash, sealedFor);
  return failureReason(() => openTokens(key, sealed, hash, openedAs));
}

/**
 * Distinct identity tuples whose values carry JSON delimiters, escapes, control
 * characters and the literal `null`. A serializer that joined or failed to escape
 * fields would let several of these collide, e.g. `{ userId: 'a,b' }` with
 * `{ userId: 'a', tenantId: 'b' }`.
 */
const trickyIdentities: TokenCustodyIdentity[] = [
  { userId: 'a' },
  { userId: 'a', tenantId: 'b' },
  { userId: 'a', openidIssuer: 'b' },
  { userId: 'a', openidSubject: 'b' },
  { userId: 'a,b' },
  { userId: 'a","b' },
  { userId: 'a\x1fb' },
  { userId: 'a\\', tenantId: 'b' },
  { userId: 'a', tenantId: '' },
  { userId: 'a', tenantId: 'null' },
  { userId: 'a', tenantId: '",null,"' },
  { userId: 'a', tenantId: 'b', openidIssuer: 'c' },
  { userId: 'a', tenantId: 'b,c' },
  { userId: '"' },
  { userId: '\\' },
  { userId: '\\"' },
  { userId: '["]' },
  { userId: '[' },
  { userId: ']' },
  { userId: '\u00fc' },
  { userId: 'u\u0308' },
];

describe('custodyAad identity binding', () => {
  it.each<[string, TokenCustodyIdentity, TokenCustodyIdentity]>([
    ['a different userId', full, { ...full, userId: 'user-2' }],
    ['a userId differing only in case', full, { ...full, userId: 'USER-1' }],
    ['a different tenantId', full, { ...full, tenantId: 'tenant-2' }],
    ['a different openidIssuer', full, { ...full, openidIssuer: 'https://other.example' }],
    ['a different openidSubject', full, { ...full, openidSubject: 'subject-2' }],
    ['an absent tenantId', full, without(full, 'tenantId')],
    ['an absent openidIssuer', full, without(full, 'openidIssuer')],
    ['an absent openidSubject', full, without(full, 'openidSubject')],
    ['an added tenantId', minimal, { ...minimal, tenantId: 'tenant-1' }],
    ['an added openidIssuer', minimal, { ...minimal, openidIssuer: 'https://issuer.example' }],
    ['an added openidSubject', minimal, { ...minimal, openidSubject: 'subject-1' }],
    [
      'issuer and subject values swapped',
      full,
      { ...full, openidIssuer: 'subject-1', openidSubject: 'https://issuer.example' },
    ],
  ])('rejects a blob opened under %s', (_label, sealedFor, openedAs) => {
    expect(openUnder(sealedFor, openedAs)).toBe('authentication');
  });

  it.each<OptionalField>(['tenantId', 'openidIssuer', 'openidSubject'])(
    'keeps an absent %s and an empty one from opening each other',
    (field) => {
      const absent = without(full, field);
      const empty: TokenCustodyIdentity = { ...full, [field]: '' };

      expect(openUnder(absent, empty)).toBe('authentication');
      expect(openUnder(empty, absent)).toBe('authentication');
      expect(openTokens(key, sealTokens(key, payload, hash, absent), hash, absent)).toEqual(
        payload,
      );
      expect(openTokens(key, sealTokens(key, payload, hash, empty), hash, empty)).toEqual(payload);
    },
  );

  it('serializes an explicitly undefined field the same as an absent one', () => {
    const explicit: TokenCustodyIdentity = { userId: 'a', tenantId: undefined };
    expect(custodyAad(hash, explicit).equals(custodyAad(hash, { userId: 'a' }))).toBe(true);
  });

  it('serializes the same tuple to the same bytes', () => {
    for (const identity of trickyIdentities) {
      expect(custodyAad(hash, identity).equals(custodyAad(hash, { ...identity }))).toBe(true);
    }
  });

  it('serializes every pair of distinct tuples to distinct bytes', () => {
    const collisions: string[] = [];
    for (let i = 0; i < trickyIdentities.length; i++) {
      for (let j = i + 1; j < trickyIdentities.length; j++) {
        const a = trickyIdentities[i];
        const b = trickyIdentities[j];
        if (custodyAad(hash, a).equals(custodyAad(hash, b))) {
          collisions.push(`${JSON.stringify(a)} = ${JSON.stringify(b)}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it('rejects a blob sealed under one tricky identity and opened under any other', () => {
    const accepted: string[] = [];
    for (const sealedFor of trickyIdentities) {
      const sealed = sealTokens(key, payload, hash, sealedFor);
      for (const openedAs of trickyIdentities) {
        if (openedAs === sealedFor) {
          continue;
        }
        if (failureReason(() => openTokens(key, sealed, hash, openedAs)) !== 'authentication') {
          accepted.push(`${JSON.stringify(sealedFor)} -> ${JSON.stringify(openedAs)}`);
        }
      }
    }
    expect(accepted).toEqual([]);
  });
});
