import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { OpenIDCustodyContext, TokenCustodyDeps } from './service';
import type { CustodyTokenPayload, TokenCustodyIdentity } from './aead';
import { createTokenCustodyService } from './service';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;

const logger: TokenCustodyDeps['logger'] = {
  warn: () => undefined,
  debug: () => undefined,
  info: () => undefined,
};

const FALLBACK_REFRESH_TTL_MS = 3_600_000;

/**
 * Anchored at real time because the store's `expiresAt > now` read uses the wall clock; the frozen
 * service clock makes the fallback-expiry branch deterministic.
 */
const FIXED_NOW = Date.now();
const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW / 1000);
const SEED_REFRESH_EXPIRY_SECONDS = FIXED_NOW_SECONDS + 5 * 24 * 3600;

function buildService() {
  return createTokenCustodyService({
    db: methods,
    logger,
    fallbackRefreshTtlMs: FALLBACK_REFRESH_TTL_MS,
    now: () => FIXED_NOW,
  });
}

const seedTokens: CustodyTokenPayload = {
  accessToken: 'access-seed',
  refreshToken: 'refresh-seed',
  idToken: 'id-seed',
  refreshTokenExpiresAt: SEED_REFRESH_EXPIRY_SECONDS,
  issuedAt: FIXED_NOW,
};

/**
 * Odd racers drop the refresh-token expiry, so whichever caller wins may move `expiresAt` earlier;
 * the counter must advance by exactly one either way.
 */
function rotationTokens(batch: number, racer: number): CustodyTokenPayload {
  const tokens: CustodyTokenPayload = {
    accessToken: `access-${batch}-${racer}`,
    refreshToken: `refresh-${batch}-${racer}`,
    idToken: `id-${batch}-${racer}`,
    accessTokenExpiresAt: FIXED_NOW_SECONDS + 3600,
    issuedAt: FIXED_NOW,
  };
  if (racer % 2 === 0) {
    tokens.refreshTokenExpiresAt = FIXED_NOW_SECONDS + (batch + 2) * 24 * 3600;
  }
  return tokens;
}

const TENANT_IDENTITY: TokenCustodyIdentity = {
  userId: 'user-counter',
  tenantId: 'tenant-a',
  openidIssuer: 'https://idp.example.com',
  openidSubject: 'subject-1',
};

const BARE_IDENTITY: TokenCustodyIdentity = { userId: 'user-counter-bare' };

/** Each entry is one batch: the number of callers racing from the same opened context. */
const CASES: Array<{ name: string; batches: number[]; identity: TokenCustodyIdentity }> = [
  { name: 'a single serial rotation', batches: [1], identity: TENANT_IDENTITY },
  { name: 'three serial rotations', batches: [1, 1, 1], identity: BARE_IDENTITY },
  { name: 'two racing callers', batches: [2], identity: TENANT_IDENTITY },
  { name: 'four racing callers', batches: [4], identity: BARE_IDENTITY },
  { name: 'six mixed batches', batches: [3, 1, 4, 2, 1, 2], identity: TENANT_IDENTITY },
];

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

describe('rotateCustody counter', () => {
  it.each(CASES)(
    'lets exactly one caller win per counter value across $name',
    async ({ batches, identity }) => {
      const service = buildService();
      const created = await service.createCustody({ tokens: seedTokens, identity });
      const key = Buffer.from(created.tokenKey, 'base64url');

      let context = (await service.openCustody({
        tokenKey: key,
        tenantId: identity.tenantId,
      })) as OpenIDCustodyContext;
      expect(context.rotationCounter).toBe(0);

      for (const [batch, racers] of batches.entries()) {
        const counterBefore = context.rotationCounter;
        const startContext = context;

        const results = await Promise.all(
          Array.from({ length: racers }, (_, racer) =>
            service.rotateCustody({ context: startContext, tokens: rotationTokens(batch, racer) }),
          ),
        );

        const winners = results.filter((r) => r.applied);
        expect(winners).toHaveLength(1);

        const winner = winners[0];
        expect(winner.context.rotationCounter).toBe(counterBefore + 1);
        for (const result of results) {
          expect(result.context.rotationCounter).toBe(winner.context.rotationCounter);
        }

        const stored = await methods.findTokenCustody({
          tokenKeyHash: created.tokenKeyHash,
          tenantId: identity.tenantId,
        });
        expect(stored?.rotationCounter).toBe(counterBefore + 1);

        context = winner.context;
      }

      expect(context.rotationCounter).toBe(batches.length);
    },
  );

  it('drives expiresAt earlier when a rotation omits a refresh-token expiry the seed provided, without disturbing the counter', async () => {
    const service = buildService();
    const created = await service.createCustody({
      tokens: seedTokens,
      identity: { userId: 'user-decrease' },
    });
    expect(created.expiresAt.getTime()).toBe(SEED_REFRESH_EXPIRY_SECONDS * 1000);

    const key = Buffer.from(created.tokenKey, 'base64url');
    const context = (await service.openCustody({ tokenKey: key })) as OpenIDCustodyContext;

    const result = await service.rotateCustody({
      context,
      tokens: { accessToken: 'access-1', refreshToken: 'refresh-1', issuedAt: FIXED_NOW },
    });

    expect(result.applied).toBe(true);
    expect(result.context.rotationCounter).toBe(1);
    expect(result.expiresAt.getTime()).toBe(FIXED_NOW + FALLBACK_REFRESH_TTL_MS);
    expect(result.expiresAt.getTime()).toBeLessThan(created.expiresAt.getTime());

    const stored = await methods.findTokenCustody({ tokenKeyHash: created.tokenKeyHash });
    expect(stored?.rotationCounter).toBe(1);
    expect(stored?.expiresAt.getTime()).toBe(FIXED_NOW + FALLBACK_REFRESH_TTL_MS);
  });
});
