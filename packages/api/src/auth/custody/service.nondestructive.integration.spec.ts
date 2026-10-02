import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { ITokenCustody } from '@librechat/data-schemas';
import type { CustodyTokenPayload, TokenCustodyIdentity } from './aead';
import type { TokenCustodyDeps, TokenCustodyService } from './service';
import type { CustodyRequest } from './loader';
import { TOKEN_KEY_COOKIE, generateTokenKey, parseTokenKey } from './key';
import { createTokenCustodyService } from './service';
import { OPENID_USER_ID_COOKIE } from '~/oauth/csrf';
import { loadOpenIDCustody } from './loader';

const logger: TokenCustodyDeps['logger'] = {
  warn: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
};

const JWT_REFRESH_SECRET = 'test-refresh-secret-for-custody-nondestructive';

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
    identityLabel: 'a tenant identity',
    identity: {
      userId: objectId(),
      tenantId: 'tenant-a',
      openidIssuer: 'https://idp.example.com',
      openidSubject: 'subject-1',
    },
  },
  { identityLabel: 'a user id only', identity: { userId: objectId() } },
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

const readAllRecords = () => TokenCustody().find({}).lean();

/** Sealed blobs are `kc1:<iv>:<tag>:<ciphertext>`; flips the first byte of one component. */
function corruptComponent(sealed: string, index: 1 | 2 | 3): string {
  const parts = sealed.split(':');
  const bytes = Buffer.from(parts[index], 'base64url');
  bytes[0] ^= 0x01;
  parts[index] = bytes.toString('base64url');
  return parts.join(':');
}

interface Seeded {
  identity: TokenCustodyIdentity;
  tokenKey: string;
  tokenKeyHash: string;
}

/** Each attempt is the failing request; any out-of-band corruption happens in `arrange`. */
interface FailureCase {
  failure: string;
  arrange?: (seeded: Seeded) => Promise<void>;
  attempt: (seeded: Seeded) => Promise<unknown>;
}

const openWithOwnKey = ({ identity, tokenKey }: Seeded) =>
  service.openCustody({
    tokenKey: parseTokenKey(tokenKey) as Buffer,
    expectedUserId: identity.userId,
    tenantId: identity.tenantId,
  });

const corruptStoredBlob =
  (index: 1 | 2 | 3) =>
  async ({ tokenKeyHash }: Seeded): Promise<void> => {
    const record = await TokenCustody().findOne({ tokenKeyHash }).lean();
    await TokenCustody().updateOne(
      { tokenKeyHash },
      { $set: { sealedTokens: corruptComponent(record?.sealedTokens ?? '', index) } },
    );
  };

const FAILURES: FailureCase[] = [
  {
    failure: 'a different generated key',
    attempt: ({ identity }) =>
      service.openCustody({
        tokenKey: parseTokenKey(generateTokenKey()) as Buffer,
        expectedUserId: identity.userId,
        tenantId: identity.tenantId,
      }),
  },
  {
    failure: 'the right key with another user id',
    attempt: ({ identity, tokenKey }) =>
      service.openCustody({
        tokenKey: parseTokenKey(tokenKey) as Buffer,
        expectedUserId: objectId(),
        tenantId: identity.tenantId,
      }),
  },
  { failure: 'a corrupted iv', arrange: corruptStoredBlob(1), attempt: openWithOwnKey },
  { failure: 'a corrupted auth tag', arrange: corruptStoredBlob(2), attempt: openWithOwnKey },
  { failure: 'a corrupted ciphertext', arrange: corruptStoredBlob(3), attempt: openWithOwnKey },
  {
    failure: 'a marker signed with the wrong secret',
    attempt: ({ identity, tokenKey, tokenKeyHash }) => {
      const req = {
        cookies: {
          [TOKEN_KEY_COOKIE]: tokenKey,
          [OPENID_USER_ID_COOKIE]: jwt.sign(
            { id: identity.userId, tokenKeyHash },
            'a-different-wrong-secret',
          ),
        },
      } as unknown as CustodyRequest;
      return loadOpenIDCustody(req, { custody: service, tenantId: identity.tenantId });
    },
  },
];

const CASES = FAILURES.flatMap((failureCase) =>
  IDENTITIES.map(({ identityLabel, identity }) => ({ ...failureCase, identityLabel, identity })),
);

describe('failed custody opens', () => {
  it.each(CASES)(
    'return null for $failure with $identityLabel and leave the store unchanged',
    async ({ identity, arrange, attempt }) => {
      const created = await service.createCustody({ tokens: TOKENS, identity });
      const seeded: Seeded = {
        identity,
        tokenKey: created.tokenKey,
        tokenKeyHash: created.tokenKeyHash,
      };
      await arrange?.(seeded);
      const recordsBefore = await readAllRecords();
      expect(recordsBefore).toHaveLength(1);

      expect(await attempt(seeded)).toBeNull();

      expect(await readAllRecords()).toEqual(recordsBefore);
    },
  );
});
