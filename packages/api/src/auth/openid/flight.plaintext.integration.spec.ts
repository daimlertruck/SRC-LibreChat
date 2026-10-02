import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { TokenCustodyIdentity } from '~/auth/custody/aead';
import type { CustodyFlightSeal, TokenResult } from './flight';
import { generateTokenKey, hashTokenKey, parseTokenKey } from '~/auth/custody/key';
import { createOpenIDRefreshFlightService } from './flight';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;

const logger = { warn: () => undefined };

const EXPIRES_AT = Math.floor(Date.now() / 1000) + 3600;

const ACCESS_TOKEN =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6ImFjY2VzcyJ9.eyJzdWIiOiJ1c2VyLTEiLCJzY29wZSI6Im9wZW5pZCJ9.c2lnLWFjY2Vzcw';
const ID_TOKEN =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6ImlkIn0.eyJzdWIiOiJ1c2VyLTEiLCJub25jZSI6Im4tMCJ9.c2lnLWlkLXRva2Vu';
const REFRESH_TOKEN = 'rt.8f3c2a1e-6b7d-4f0a-9c1e-2d3b4a5c6d7e.refresh-token-value';

const FULL_IDENTITY: TokenCustodyIdentity = {
  userId: 'user-1',
  tenantId: 'tenant-a',
  openidIssuer: 'https://idp.example.com',
  openidSubject: 'subject-1',
};

const CASES: Array<{ name: string; tokens: TokenResult; identity: TokenCustodyIdentity }> = [
  {
    name: 'a full token set',
    tokens: {
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      id_token: ID_TOKEN,
      expires_at: EXPIRES_AT,
    },
    identity: FULL_IDENTITY,
  },
  {
    name: 'a token set without an id token',
    tokens: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_at: EXPIRES_AT },
    identity: FULL_IDENTITY,
  },
  {
    name: 'a user id only identity',
    tokens: {
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
      id_token: ID_TOKEN,
      expires_at: EXPIRES_AT,
    },
    identity: { userId: 'user-2' },
  },
  {
    name: 'awkward identity strings and kilobyte-long tokens',
    tokens: {
      access_token: `${ACCESS_TOKEN}.${'QWxhZGRpbjpvcGVuIHNlc2FtZQ'.repeat(40)}`,
      refresh_token: `${REFRESH_TOKEN}.${'cmVmcmVzaC10b2tlbi1ib2R5'.repeat(40)}`,
      id_token: `${ID_TOKEN}.${'aWQtdG9rZW4tYm9keQ'.repeat(40)}`,
      expires_at: EXPIRES_AT,
    },
    identity: {
      userId: 'user.$3',
      tenantId: 'tenant.$prod',
      openidIssuer: 'https://idp.example.com/realms/ünïcødé$.',
      openidSubject: 'sub.$ject-日本語-😀',
    },
  },
];

function buildService() {
  return createOpenIDRefreshFlightService({
    db: {
      acquireOpenIDRefreshFlight: methods.acquireOpenIDRefreshFlight,
      completeOpenIDRefreshFlight: methods.completeOpenIDRefreshFlight,
      renewOpenIDRefreshFlight: methods.renewOpenIDRefreshFlight,
      failOpenIDRefreshFlight: methods.failOpenIDRefreshFlight,
      revokeOpenIDRefreshFlight: methods.revokeOpenIDRefreshFlight,
      findOpenIDRefreshFlight: methods.findOpenIDRefreshFlight,
      claimOpenIDRefreshFlightDelivery: methods.claimOpenIDRefreshFlightDelivery,
      releaseOpenIDRefreshFlightDelivery: methods.releaseOpenIDRefreshFlightDelivery,
    },
    logger,
  });
}

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
  await mongoose.models.OpenIDRefreshFlight.deleteMany({});
});

type LeanFlight = { sealedResult?: string };

describe('completed refresh flight at rest', () => {
  it.each(CASES)(
    'stores $name sealed, with no token or key in the document, and opens only under the owning key',
    async ({ tokens, identity }) => {
      const OpenIDRefreshFlight = mongoose.models.OpenIDRefreshFlight;
      const encodedKey = generateTokenKey();
      const aeadKey = parseTokenKey(encodedKey) as Buffer;
      const seal: CustodyFlightSeal = { aeadKey, tokenKeyHash: hashTokenKey(aeadKey), identity };
      const key = crypto.randomUUID();
      const ownerId = crypto.randomUUID();
      const service = buildService();

      const acquired = await service.acquireOpenIDRefreshFlight({ key, ownerId });
      expect(acquired.acquired).toBe(true);
      await service.completeOpenIDRefreshFlight({ key, ownerId, tokens, seal });

      const doc = await OpenIDRefreshFlight.findOne({ key }).lean<LeanFlight>();
      expect(doc?.sealedResult).toEqual(expect.stringMatching(/^kc1:/));

      const serialized = JSON.stringify(doc);
      const secrets = [tokens.access_token, tokens.refresh_token, tokens.id_token, encodedKey];
      for (const secret of secrets.filter((s): s is string => typeof s === 'string')) {
        expect(serialized).not.toContain(secret);
      }

      const opened = await service.waitForOpenIDRefreshFlight({ key, seal, timeoutMs: 200 });
      expect(opened?.access_token).toBe(tokens.access_token);
      expect(opened?.refresh_token).toBe(tokens.refresh_token);
      expect(opened?.id_token).toBe(tokens.id_token);

      const foreignKey = parseTokenKey(generateTokenKey()) as Buffer;
      const foreign = await service.waitForOpenIDRefreshFlight({
        key,
        seal: { ...seal, aeadKey: foreignKey },
        timeoutMs: 200,
      });
      expect(foreign).toBeNull();

      const after = await OpenIDRefreshFlight.findOne({ key }).lean<LeanFlight>();
      expect(after?.sealedResult).toBe(doc?.sealedResult);
    },
  );
});
