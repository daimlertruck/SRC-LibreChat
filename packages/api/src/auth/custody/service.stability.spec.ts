import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { OpenIDCustodyContext, TokenCustodyDeps } from './service';
import type { CustodyTokenPayload, TokenCustodyIdentity } from './aead';
import { createTokenCustodyService } from './service';
import { hashTokenKey, parseTokenKey } from './key';

const logger: TokenCustodyDeps['logger'] = {
  warn: () => undefined,
  debug: () => undefined,
  info: () => undefined,
};

const FALLBACK_REFRESH_TTL_MS = 3_600_000;

/** Anchored at real time because the store's `expiresAt > now` read uses the wall clock. */
const FIXED_NOW = Date.now();
const NOW_SECONDS = Math.floor(FIXED_NOW / 1000);

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { autoIndex: false });
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await mongoose.models.TokenCustody.deleteMany({});
});

/** Cycles through payload shapes: all fields, no id token, no expiries, access expiry only. */
function rotation(n: number): CustodyTokenPayload {
  const base = { accessToken: `access-${n}`, refreshToken: `refresh-${n}`, issuedAt: FIXED_NOW };
  const shapes: CustodyTokenPayload[] = [
    {
      ...base,
      idToken: `id-${n}`,
      accessTokenExpiresAt: NOW_SECONDS + 3600,
      refreshTokenExpiresAt: NOW_SECONDS + (n + 1) * 24 * 3600,
    },
    { ...base, accessTokenExpiresAt: NOW_SECONDS + 3600 },
    { ...base, idToken: `id-${n}` },
    { ...base, accessTokenExpiresAt: NOW_SECONDS + 7200 },
  ];
  return shapes[n % shapes.length];
}

const rotations = (count: number): CustodyTokenPayload[] =>
  Array.from({ length: count }, (_, n) => rotation(n + 1));

const CASES: Array<{
  name: string;
  identity: TokenCustodyIdentity;
  rotations: CustodyTokenPayload[];
}> = [
  { name: 'no rotations, user id only', identity: { userId: 'user-1' }, rotations: [] },
  {
    name: 'one rotation, full identity',
    identity: {
      userId: 'user-2',
      tenantId: 'tenant-a',
      openidIssuer: 'https://idp.example.com',
      openidSubject: 'subject-2',
    },
    rotations: rotations(1),
  },
  {
    name: 'eight rotations across every payload shape',
    identity: { userId: 'user-3', tenantId: 'tenant-b' },
    rotations: rotations(8),
  },
  {
    name: 'three rotations with awkward identity strings',
    identity: {
      userId: 'user.$4',
      tenantId: 'tenant.$prod',
      openidIssuer: 'https://idp.example.com/realms/ünïcødé$.',
      openidSubject: 'sub.$ject-日本語-😀',
    },
    rotations: rotations(3),
  },
];

describe('custody lookup key under rotation', () => {
  it.each(CASES)(
    'keeps tokenKeyHash and the cookie key fixed with $name',
    async ({ identity, rotations: sequence }) => {
      const service = createTokenCustodyService({
        db: methods,
        logger,
        fallbackRefreshTtlMs: FALLBACK_REFRESH_TTL_MS,
        now: () => FIXED_NOW,
      });
      const initialTokens = rotation(0);
      const created = await service.createCustody({ tokens: initialTokens, identity });
      const cookieValue = created.tokenKey;
      const originalHash = created.tokenKeyHash;
      const key = parseTokenKey(cookieValue) as Buffer;
      expect(hashTokenKey(key)).toBe(originalHash);

      const open = () =>
        service.openCustody({
          tokenKey: key,
          expectedUserId: identity.userId,
          tenantId: identity.tenantId,
        });

      let context = (await open()) as OpenIDCustodyContext;
      expect(context).not.toBeNull();

      for (const tokens of sequence) {
        const result = await service.rotateCustody({ context, tokens });
        expect(result.applied).toBe(true);
        expect(result.context.tokenKeyHash).toBe(originalHash);
        context = result.context;
      }

      const stored = await methods.findTokenCustody({
        tokenKeyHash: originalHash,
        tenantId: identity.tenantId,
      });
      expect(stored?.tokenKeyHash).toBe(originalHash);
      expect(stored?.rotationCounter).toBe(sequence.length);
      expect(await mongoose.models.TokenCustody.countDocuments()).toBe(1);

      expect(hashTokenKey(parseTokenKey(cookieValue) as Buffer)).toBe(originalHash);
      const reopened = await open();
      expect(reopened?.tokens).toEqual(sequence[sequence.length - 1] ?? initialTokens);
    },
  );
});
