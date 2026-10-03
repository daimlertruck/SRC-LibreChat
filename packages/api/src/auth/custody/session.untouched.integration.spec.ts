import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { OpenIDCustodyContext, TokenCustodyDeps, TokenCustodyService } from './service';
import type { CustodyTokenPayload, TokenCustodyIdentity } from './aead';
import { createTokenCustodyService } from './service';
import { parseTokenKey } from './key';

const logger: TokenCustodyDeps['logger'] = {
  warn: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
};

const JWT_REFRESH_SECRET = 'test-refresh-secret-for-sessions-untouched';

const FALLBACK_REFRESH_TTL_MS = 30 * 24 * 3600_000;

type AllMethods = ReturnType<typeof createMethods>;

let mongoServer: MongoMemoryServer;
let methods: AllMethods;
let service: TokenCustodyService;
let clock: number;
let originalRefreshSecret: string | undefined;

beforeAll(async () => {
  originalRefreshSecret = process.env.JWT_REFRESH_SECRET;
  process.env.JWT_REFRESH_SECRET = JWT_REFRESH_SECRET;

  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri(), { autoIndex: false });
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
  process.env.JWT_REFRESH_SECRET = originalRefreshSecret;
});

beforeEach(async () => {
  await Promise.all([SessionModel().deleteMany({}), CustodyModel().deleteMany({})]);
  /** The store's `expiresAt > now` read uses the wall clock, so the service clock starts at it. */
  clock = Date.now();
  service = createTokenCustodyService({
    db: methods,
    logger,
    fallbackRefreshTtlMs: FALLBACK_REFRESH_TTL_MS,
    now: () => clock,
  });
  jest.clearAllMocks();
});

const SessionModel = () => mongoose.models.Session;
const CustodyModel = () => mongoose.models.TokenCustody;

async function sessionHashes(): Promise<string[]> {
  const docs = await SessionModel()
    .find({}, { refreshTokenHash: 1, _id: 0 })
    .lean<Array<{ refreshTokenHash: string }>>();
  return docs.map((d) => d.refreshTokenHash).sort();
}

function payload(overrides: Partial<CustodyTokenPayload> = {}): CustodyTokenPayload {
  return {
    accessToken: 'access-token',
    idToken: 'id-token',
    refreshToken: 'refresh-token',
    accessTokenExpiresAt: Math.floor(clock / 1000) + 3600,
    refreshTokenExpiresAt: Math.floor(clock / 1000) + 7 * 24 * 3600,
    issuedAt: clock,
    ...overrides,
  };
}

const IDENTITY: TokenCustodyIdentity = {
  userId: 'openid-user-1',
  openidIssuer: 'https://idp.example',
  openidSubject: 'subject-1',
};

/** Login, refresh read, rotation, a tool worker's on-behalf-of refresh, then logout. */
async function runOpenIDLifecycle(token: string): Promise<void> {
  const created = await service.createCustody({
    tokens: payload({ accessToken: `oidc-${token}` }),
    identity: IDENTITY,
  });
  const key = parseTokenKey(created.tokenKey) as Buffer;

  const context = (await service.openCustody({
    tokenKey: key,
    expectedUserId: IDENTITY.userId,
  })) as OpenIDCustodyContext;

  clock += 60_000;
  const rotation = await service.rotateCustody({
    context,
    tokens: payload({ accessToken: `oidc-rot-${token}`, refreshToken: `rt-${token}` }),
  });
  expect(rotation.outcome).toBe('applied');
  if (rotation.outcome === 'gone') {
    throw new Error('unexpected gone outcome');
  }

  clock += 60_000;
  const oboContext = (await service.openCustody({
    tokenKey: key,
    expectedUserId: IDENTITY.userId,
  })) as OpenIDCustodyContext;
  const oboRotation = await service.rotateCustody({
    context: oboContext,
    tokens: payload({ accessToken: `oidc-obo-${token}` }),
  });
  expect(oboRotation.outcome).toBe('applied');

  await service.deleteCustody({ tokenKeyHash: rotation.context.tokenKeyHash });
}

/** SHA-256 hex, the same digest the session methods store in `refreshTokenHash`. */
function refreshTokenHash(refreshToken: string): string {
  return createHash('sha256').update(refreshToken, 'utf8').digest('hex');
}

/** `sessions.user` is an ObjectId ref, so local users need real ObjectId strings. */
const [ALICE, BOB, CAROL] = Array.from({ length: 3 }, () =>
  new mongoose.Types.ObjectId().toString(),
);

/** `logout` names a login by its 0-based issue order; an index never issued is a no-op. */
type Step =
  | { kind: 'openid' }
  | { kind: 'login'; userId: string }
  | { kind: 'logout'; loginIndex: number };

const openid: Step = { kind: 'openid' };
const login = (userId: string): Step => ({ kind: 'login', userId });
const logout = (loginIndex: number): Step => ({ kind: 'logout', loginIndex });

const SEQUENCES: Array<{ name: string; steps: Step[] }> = [
  { name: 'openid only', steps: [openid, openid] },
  { name: 'local login then logout', steps: [login(ALICE), logout(0)] },
  { name: 'logout before any login', steps: [logout(0), login(ALICE)] },
  { name: 'logout of a login index never issued', steps: [login(ALICE), logout(3)] },
  {
    name: 'openid between a local login and its logout',
    steps: [login(ALICE), openid, logout(0)],
  },
  {
    name: 'repeated logins for one user then partial logout',
    steps: [login(BOB), login(BOB), login(BOB), logout(1)],
  },
  {
    name: 'a long mixed sequence with a repeated logout',
    steps: [
      login(ALICE),
      openid,
      login(BOB),
      logout(0),
      openid,
      login(CAROL),
      login(ALICE),
      logout(0),
      openid,
      logout(2),
    ],
  },
];

describe('sessions collection on the OpenID path', () => {
  it.each(SEQUENCES)('matches what local auth alone dictates for $name', async ({ steps }) => {
    const issued: string[] = [];
    const live = new Set<string>();
    let openidRuns = 0;

    for (const step of steps) {
      if (step.kind === 'openid') {
        await runOpenIDLifecycle(`t${openidRuns++}`);
      } else if (step.kind === 'login') {
        const { refreshToken } = await methods.createSession(step.userId, {
          expiresIn: FALLBACK_REFRESH_TTL_MS,
        });
        issued.push(refreshToken);
        live.add(refreshToken);
      } else if (step.loginIndex < issued.length) {
        const refreshToken = issued[step.loginIndex];
        await methods.deleteSession({ refreshToken });
        live.delete(refreshToken);
      }

      expect(await sessionHashes()).toEqual([...live].map(refreshTokenHash).sort());
    }

    expect(await CustodyModel().countDocuments()).toBe(0);
  });
});
