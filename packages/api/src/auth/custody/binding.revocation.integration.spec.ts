import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { ITokenCustody } from '@librechat/data-schemas';
import type { Request } from 'express';
import type { CustodyTokenPayload, TokenCustodyIdentity } from './aead';
import type { TokenCustodyDeps, TokenCustodyService } from './service';
import { TOKEN_KEY_COOKIE, parseTokenKey } from './key';
import { createTokenCustodyService } from './service';
import { OPENID_USER_ID_COOKIE } from '~/oauth/csrf';
import { verifyCustodyBinding } from './binding';

const logger: TokenCustodyDeps['logger'] = {
  warn: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
};

const JWT_REFRESH_SECRET = 'test-refresh-secret-for-custody-revocation';

const NOW_SECONDS = Math.floor(Date.now() / 1000);

const tokensFor = (session: string): CustodyTokenPayload => ({
  accessToken: `eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEiLCJzaWQiOiIke3Nlc3Npb259In0.${session}-access`,
  idToken: `eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEiLCJub25jZSI6Im4ifQ.${session}-id`,
  refreshToken: `rt.${session}.6b7d4f0a9c1e2d3b4a5c6d7e`,
  accessTokenExpiresAt: NOW_SECONDS + 3600,
  refreshTokenExpiresAt: NOW_SECONDS + 30 * 24 * 3600,
  issuedAt: Date.now(),
});

const IDENTITY: TokenCustodyIdentity = {
  userId: new mongoose.Types.ObjectId().toString(),
  tenantId: 'tenant-a',
  openidIssuer: 'https://idp.example.com',
  openidSubject: 'subject-1',
};

const AWKWARD_IDENTITY: TokenCustodyIdentity = {
  userId: new mongoose.Types.ObjectId().toString(),
  tenantId: 'tenant.$prod',
  openidIssuer: 'https://idp.example.com/realms/ünïcødé$.',
  openidSubject: 'sub.$ject-日本語-😀',
};

type DeletionMode = 'deleteCustody' | 'deleteAllForUser';

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
  await mongoose.models.TokenCustody.deleteMany({});
  jest.clearAllMocks();
});

const countRecords = () =>
  (mongoose.models.TokenCustody as mongoose.Model<ITokenCustody>).countDocuments();

const CASES: Array<{ mode: DeletionMode; extraRecords: number; identity: TokenCustodyIdentity }> = [
  { mode: 'deleteCustody', extraRecords: 0, identity: IDENTITY },
  { mode: 'deleteCustody', extraRecords: 1, identity: IDENTITY },
  { mode: 'deleteCustody', extraRecords: 3, identity: IDENTITY },
  { mode: 'deleteAllForUser', extraRecords: 0, identity: IDENTITY },
  { mode: 'deleteAllForUser', extraRecords: 1, identity: IDENTITY },
  { mode: 'deleteAllForUser', extraRecords: 3, identity: IDENTITY },
  { mode: 'deleteAllForUser', extraRecords: 1, identity: AWKWARD_IDENTITY },
];

describe('custody revocation', () => {
  it.each(CASES)(
    '$mode with $extraRecords other sessions for the user ($identity.tenantId) revokes the same cookie pair',
    async ({ mode, extraRecords, identity }) => {
      const created = await service.createCustody({ tokens: tokensFor('target'), identity });
      const key = parseTokenKey(created.tokenKey) as Buffer;
      const hash = created.tokenKeyHash;
      const req = {
        cookies: {
          [TOKEN_KEY_COOKIE]: created.tokenKey,
          [OPENID_USER_ID_COOKIE]: jwt.sign(
            { id: identity.userId, tokenKeyHash: hash },
            JWT_REFRESH_SECRET,
            { expiresIn: 3600 },
          ),
        },
      } as unknown as Request;

      for (let i = 0; i < extraRecords; i++) {
        await service.createCustody({ tokens: tokensFor(`other-${i}`), identity });
      }

      const bind = () =>
        verifyCustodyBinding(req, { custody: service, tenantId: identity.tenantId });
      const open = () =>
        service.openCustody({
          tokenKey: key,
          expectedUserId: identity.userId,
          tenantId: identity.tenantId,
        });
      const revoke = () =>
        mode === 'deleteCustody'
          ? service.deleteCustody({ tokenKeyHash: hash })
          : service.deleteAllForUser({ userId: identity.userId, tenantId: identity.tenantId });

      expect(await bind()).toEqual({ userId: identity.userId, tokenKeyHash: hash });
      expect((await open())?.tokenKeyHash).toBe(hash);

      await revoke();

      // deleteCustody targets one browser session; deleteAllForUser clears every session.
      expect(await countRecords()).toBe(mode === 'deleteCustody' ? extraRecords : 0);

      expect(await bind()).toBeNull();
      expect(await open()).toBeNull();
      expect(await open()).toBeNull();
      expect(await bind()).toBeNull();

      await expect(revoke()).resolves.toBeUndefined();
      expect(await bind()).toBeNull();
      expect(await open()).toBeNull();
    },
  );
});
