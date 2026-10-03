import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { ITokenCustody } from '@librechat/data-schemas';
import type { Request } from 'express';
import type { CustodyTokenPayload, TokenCustodyIdentity } from './aead';
import type { TokenCustodyDeps, TokenCustodyService } from './service';
import { TOKEN_KEY_COOKIE, generateTokenKey, hashTokenKey, parseTokenKey } from './key';
import { createTokenCustodyService } from './service';
import { OPENID_USER_ID_COOKIE } from '~/oauth/csrf';
import { verifyCustodyBinding } from './binding';

const logger: TokenCustodyDeps['logger'] = {
  warn: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
};

const JWT_REFRESH_SECRET = 'test-refresh-secret-for-custody-binding';
const WRONG_REFRESH_SECRET = 'a-different-wrong-secret-for-custody-binding';

const NOW_SECONDS = Math.floor(Date.now() / 1000);

const TOKENS: CustodyTokenPayload = {
  accessToken:
    'eyJhbGciOiJSUzI1NiIsImtpZCI6ImFjY2VzcyJ9.eyJzdWIiOiJ1c2VyLTEiLCJzY29wZSI6Im9wZW5pZCJ9.c2lnLWFjY2Vzcw',
  idToken:
    'eyJhbGciOiJSUzI1NiIsImtpZCI6ImlkIn0.eyJzdWIiOiJ1c2VyLTEiLCJub25jZSI6Im4tMCJ9.c2lnLWlkLXRva2Vu',
  refreshToken: 'rt.8f3c2a1e-6b7d-4f0a-9c1e-2d3b4a5c6d7e.refresh-token-value',
  accessTokenExpiresAt: NOW_SECONDS + 3600,
  refreshTokenExpiresAt: NOW_SECONDS + 30 * 24 * 3600,
  issuedAt: Date.now(),
};

const objectId = (): string => new mongoose.Types.ObjectId().toString();

const IDENTITIES: Array<{ identityLabel: string; identity: TokenCustodyIdentity }> = [
  {
    identityLabel: 'a full identity',
    identity: {
      userId: objectId(),
      tenantId: 'tenant-a',
      openidIssuer: 'https://idp.example.com',
      openidSubject: 'subject-1',
    },
  },
  { identityLabel: 'a user id only', identity: { userId: objectId() } },
  {
    identityLabel: 'awkward identity strings',
    identity: {
      userId: objectId(),
      tenantId: 'tenant.$prod',
      openidIssuer: 'https://idp.example.com/realms/ünïcødé$.',
      openidSubject: 'sub.$ject-日本語-😀',
    },
  },
];

let mongoServer: MongoMemoryServer;
let service: TokenCustodyService;
let originalRefreshSecret: string | undefined;

beforeAll(async () => {
  originalRefreshSecret = process.env.JWT_REFRESH_SECRET;
  process.env.JWT_REFRESH_SECRET = JWT_REFRESH_SECRET;

  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { autoIndex: false });
  createModels(mongoose);
  service = createTokenCustodyService({
    db: createMethods(mongoose),
    logger,
    fallbackRefreshTtlMs: 3600_000,
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
  process.env.JWT_REFRESH_SECRET = originalRefreshSecret;
});

beforeEach(async () => {
  await TokenCustody().deleteMany({});
  jest.clearAllMocks();
});

const TokenCustody = () => mongoose.models.TokenCustody as mongoose.Model<ITokenCustody>;

const readAllRecords = () => TokenCustody().find({}).sort({ tokenKeyHash: 1 }).lean();

function signMarker(id: string, tokenKeyHash: string, secret = JWT_REFRESH_SECRET): string {
  return jwt.sign({ id, tokenKeyHash }, secret, { expiresIn: 3600 });
}

const hashOf = (tokenKey: string): string => hashTokenKey(parseTokenKey(tokenKey) as Buffer);

type Cookies = Record<string, string>;

const cookiePair = (tokenKey: string, marker: string): Cookies => ({
  [TOKEN_KEY_COOKIE]: tokenKey,
  [OPENID_USER_ID_COOKIE]: marker,
});

interface Seeded {
  userId: string;
  tokenKey: string;
  tokenKeyHash: string;
  marker: string;
}

interface CookieCase {
  cookieLabel: string;
  bound: boolean;
  arrange: (seeded: Seeded) => Promise<Cookies>;
}

/** Each value fails `parseTokenKey`'s strict 43-character base64url gate. */
const MALFORMED_KEYS: Array<[string, string]> = [
  ['empty', ''],
  ['too short', 'A'.repeat(42)],
  ['too long', 'A'.repeat(44)],
  ['padded', '=' + 'A'.repeat(42)],
  ['standard base64 alphabet', '+/' + 'A'.repeat(41)],
];

const COOKIE_CASES: CookieCase[] = [
  {
    cookieLabel: 'a valid cookie pair',
    bound: true,
    arrange: async ({ tokenKey, marker }) => cookiePair(tokenKey, marker),
  },
  { cookieLabel: 'no cookies', bound: false, arrange: async () => ({}) },
  ...MALFORMED_KEYS.map(
    ([label, value]): CookieCase => ({
      cookieLabel: `a malformed key cookie (${label})`,
      bound: false,
      arrange: async ({ marker }) => cookiePair(value, marker),
    }),
  ),
  {
    cookieLabel: "another user's well-formed cookie pair with no record",
    bound: false,
    arrange: async () => {
      const foreignKey = generateTokenKey();
      return cookiePair(foreignKey, signMarker(objectId(), hashOf(foreignKey)));
    },
  },
  {
    cookieLabel: 'a valid cookie pair whose record has expired',
    bound: false,
    arrange: async ({ tokenKey, tokenKeyHash, marker }) => {
      await TokenCustody().updateOne(
        { tokenKeyHash },
        { $set: { expiresAt: new Date(Date.now() - 60_000) } },
      );
      return cookiePair(tokenKey, marker);
    },
  },
  {
    cookieLabel: 'a marker signed with the wrong secret',
    bound: false,
    arrange: async ({ userId, tokenKey, tokenKeyHash }) =>
      cookiePair(tokenKey, signMarker(userId, tokenKeyHash, WRONG_REFRESH_SECRET)),
  },
  {
    cookieLabel: 'a marker claiming a different key hash',
    bound: false,
    arrange: async ({ userId, tokenKey }) =>
      cookiePair(tokenKey, signMarker(userId, hashOf(generateTokenKey()))),
  },
];

const CASES = COOKIE_CASES.flatMap((cookieCase) =>
  IDENTITIES.map(({ identityLabel, identity }) => ({
    ...cookieCase,
    identityLabel,
    identity,
  })),
);

describe('verifyCustodyBinding', () => {
  it.each(CASES)(
    'answers $cookieLabel for $identityLabel without leaking tokens or touching the store',
    async ({ identity, bound, arrange }) => {
      const created = await service.createCustody({ tokens: TOKENS, identity });
      const seeded: Seeded = {
        userId: identity.userId,
        tokenKey: created.tokenKey,
        tokenKeyHash: created.tokenKeyHash,
        marker: signMarker(identity.userId, created.tokenKeyHash),
      };
      const cookies = await arrange(seeded);
      const recordsBefore = await readAllRecords();
      expect(recordsBefore).toHaveLength(1);

      const req = { cookies } as Request;
      const result = await verifyCustodyBinding(req, {
        custody: service,
        expectedTenantId: identity.tenantId ?? null,
      });

      expect(result).toEqual(
        bound ? { userId: identity.userId, tokenKeyHash: created.tokenKeyHash } : null,
      );

      const serialized = JSON.stringify(result);
      for (const secret of [
        TOKENS.accessToken,
        TOKENS.idToken,
        TOKENS.refreshToken,
        created.tokenKey,
      ]) {
        expect(serialized).not.toContain(secret);
      }

      expect(await readAllRecords()).toEqual(recordsBefore);
    },
  );
});
