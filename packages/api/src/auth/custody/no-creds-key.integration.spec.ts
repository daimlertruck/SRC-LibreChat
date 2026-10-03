import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { OpenIDCustodyContext, TokenCustodyDeps, TokenCustodyService } from './service';
import type { CustodyTokenPayload, TokenCustodyIdentity } from './aead';
import { hashTokenKey, parseTokenKey, TOKEN_KEY_COOKIE } from './key';
import { createTokenCustodyService } from './service';
import { CustodyOpenError, openTokens } from './aead';

/**
 * OpenID tokens in custody are sealed only under the browser-held token key, never `CREDS_KEY`,
 * while the `tokens` collection and local auth keep working as before. Runs against real
 * data-schemas methods on `mongodb-memory-server` with real AEAD.
 */

/** 32 bytes of `CREDS_KEY`, hex, and a 16-byte `CREDS_IV` — the shape the legacy AES-CBC path wants. */
const CREDS_KEY_HEX = '11'.repeat(32);
const CREDS_IV_HEX = '22'.repeat(16);
const JWT_REFRESH_SECRET = 'test-refresh-secret-for-no-creds-key';

/** A fixed fallback so the record TTL fallback branch is deterministic; irrelevant to these tests. */
const FALLBACK_REFRESH_TTL_MS = 30 * 24 * 3600_000;

type AllMethods = ReturnType<typeof createMethods>;

let mongoServer: MongoMemoryServer;
let methods: AllMethods;
let service: TokenCustodyService;
let logger: TokenCustodyDeps['logger'];
let clock: number;

let savedCredsKey: string | undefined;
let savedCredsIv: string | undefined;
let savedRefreshSecret: string | undefined;

/** The service's `db` dependency: the real method set plus the projected meta read. */
function serviceDb(m: AllMethods): TokenCustodyDeps['db'] {
  return {
    upsertTokenCustody: m.upsertTokenCustody,
    findTokenCustody: m.findTokenCustody,
    findTokenCustodyMeta: async (query) => {
      const record = await m.findTokenCustody(query);
      return record === null ? null : { userId: record.userId };
    },
    updateTokenCustodyIfCurrent: m.updateTokenCustodyIfCurrent,
    deleteTokenCustody: m.deleteTokenCustody,
    deleteTokenCustodiesByUser: m.deleteTokenCustodiesByUser,
  };
}

beforeAll(async () => {
  savedCredsKey = process.env.CREDS_KEY;
  savedCredsIv = process.env.CREDS_IV;
  savedRefreshSecret = process.env.JWT_REFRESH_SECRET;
  process.env.CREDS_KEY = CREDS_KEY_HEX;
  process.env.CREDS_IV = CREDS_IV_HEX;
  process.env.JWT_REFRESH_SECRET = JWT_REFRESH_SECRET;

  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
  process.env.CREDS_KEY = savedCredsKey;
  process.env.CREDS_IV = savedCredsIv;
  process.env.JWT_REFRESH_SECRET = savedRefreshSecret;
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  clock = Date.now();
  logger = { warn: jest.fn(), debug: jest.fn(), info: jest.fn() };
  service = createTokenCustodyService({
    db: serviceDb(methods),
    logger,
    fallbackRefreshTtlMs: FALLBACK_REFRESH_TTL_MS,
    now: () => clock,
  });
});

const IDENTITY: TokenCustodyIdentity = {
  userId: 'openid-user-1',
  openidIssuer: 'https://idp.example',
  openidSubject: 'subject-1',
};

/** Distinctive token strings so a substring search for them in stored bytes is meaningful. */
function payload(overrides: Partial<CustodyTokenPayload> = {}): CustodyTokenPayload {
  return {
    accessToken: 'ACCESS-TOKEN-in-scope-secret-value',
    idToken: 'ID-TOKEN-in-scope-secret-value',
    refreshToken: 'REFRESH-TOKEN-in-scope-secret-value',
    // The IdP-supplied expiries are unix seconds — the unit the real callers store and that
    // `resolveRecordExpiry` multiplies by 1000 — so express them in seconds an hour/week ahead of
    // real "now" to keep the record live against the wall-clock reader predicate.
    accessTokenExpiresAt: Math.floor(clock / 1000) + 3600,
    refreshTokenExpiresAt: Math.floor(clock / 1000) + 7 * 24 * 3600,
    issuedAt: clock,
    ...overrides,
  };
}

function keyOf(tokenKey: string): Buffer {
  return parseTokenKey(tokenKey) as Buffer;
}

const CustodyModel = () => mongoose.models.TokenCustody as mongoose.Model<Record<string, unknown>>;
const SessionModel = () => mongoose.models.Session as mongoose.Model<Record<string, unknown>>;

/**
 * A 32-byte AEAD key derived from `CREDS_KEY` the only way an attacker with the process environment
 * could — the raw bytes of `CREDS_KEY`, and the SHA-256 of them. Either one standing in for the
 * token key must be rejected.
 */
function credsKeyDerivedKeys(): Buffer[] {
  const raw = Buffer.from(CREDS_KEY_HEX, 'hex');
  const hashed = crypto.createHash('sha256').update(raw).digest();
  return [raw, hashed];
}

describe('key custody without CREDS_KEY', () => {
  describe('custody tokens seal and open under the token key, never CREDS_KEY', () => {
    it('every custody path (login, refresh, rotation, OBO, invalid_grant reload) opens only under the browser key', async () => {
      // login: createCustody mints the key and seals the set
      const created = await service.createCustody({ tokens: payload(), identity: IDENTITY });
      const key = keyOf(created.tokenKey);

      // refresh read: openCustody returns the set using the cookie key alone
      const context = (await service.openCustody({
        tokenKey: key,
        expectedUserId: IDENTITY.userId,
      })) as OpenIDCustodyContext;
      expect(context.tokens.accessToken).toBe('ACCESS-TOKEN-in-scope-secret-value');

      // rotation (also the OBO refresh path and flight completion): re-seal under the SAME key
      clock += 60_000;
      const rotation = await service.rotateCustody({
        context,
        tokens: payload({ accessToken: 'ACCESS-TOKEN-rotated' }),
      });
      expect(rotation.outcome).toBe('applied');
      const afterRotate = (await service.openCustody({
        tokenKey: key,
        expectedUserId: IDENTITY.userId,
      })) as OpenIDCustodyContext;
      expect(afterRotate.tokens.accessToken).toBe('ACCESS-TOKEN-rotated');

      // invalid_grant recovery: reloadAfterInvalidGrant opens with the context's key, not CREDS_KEY
      const reloaded = await service.reloadAfterInvalidGrant({ context: afterRotate });
      expect(reloaded?.tokens.accessToken).toBe('ACCESS-TOKEN-rotated');

      // none of these paths consulted CREDS_KEY: the derived keys cannot open the stored blob
      const stored = await service.openCustody({ tokenKey: key, expectedUserId: IDENTITY.userId });
      const record = (await CustodyModel().findOne({
        tokenKeyHash: created.tokenKeyHash,
      })) as unknown as { sealedTokens: string };
      const identity: TokenCustodyIdentity = {
        userId: IDENTITY.userId,
        openidIssuer: IDENTITY.openidIssuer,
        openidSubject: IDENTITY.openidSubject,
      };
      for (const credsKey of credsKeyDerivedKeys()) {
        expect(() =>
          openTokens(credsKey, record.sealedTokens, created.tokenKeyHash, identity),
        ).toThrow(CustodyOpenError);
      }
      // the real key still opens it, confirming the blob itself is intact and it is the KEY, not the
      // blob, that separates success from failure
      expect(stored?.tokens.accessToken).toBe('ACCESS-TOKEN-rotated');
    });

    it('a sealed blob opened with a CREDS_KEY-derived key throws CustodyOpenError and returns no plaintext', async () => {
      const created = await service.createCustody({ tokens: payload(), identity: IDENTITY });
      const record = (await CustodyModel().findOne({
        tokenKeyHash: created.tokenKeyHash,
      })) as unknown as { sealedTokens: string };
      const identity: TokenCustodyIdentity = {
        userId: IDENTITY.userId,
        openidIssuer: IDENTITY.openidIssuer,
        openidSubject: IDENTITY.openidSubject,
      };

      for (const credsKey of credsKeyDerivedKeys()) {
        let threw: unknown;
        try {
          openTokens(credsKey, record.sealedTokens, created.tokenKeyHash, identity);
        } catch (error) {
          threw = error;
        }
        expect(threw).toBeInstanceOf(CustodyOpenError);
        expect((threw as CustodyOpenError).reason).toBe('authentication');
      }
    });

    it('the stored custody record holds no plaintext token and cannot be read with CREDS_KEY', async () => {
      const p = payload();
      const created = await service.createCustody({ tokens: p, identity: IDENTITY });

      const record = (await CustodyModel()
        .findOne({ tokenKeyHash: created.tokenKeyHash })
        .lean()) as Record<string, unknown> | null;
      const serialized = JSON.stringify(record);

      // no in-scope plaintext, and no base64url of the token key, survives at rest
      expect(serialized).not.toContain(p.accessToken);
      expect(serialized).not.toContain(p.idToken as string);
      expect(serialized).not.toContain(p.refreshToken);
      expect(serialized).not.toContain(created.tokenKey);

      // the only key-derived value at rest is the 43-char token key hash
      expect(record?.tokenKeyHash).toBe(created.tokenKeyHash);

      // the sealed blob is the custody `kc1:` AEAD format, not a `CREDS_KEY` (v2/v3) ciphertext, so
      // no CREDS_KEY code path was used to write it
      expect(record?.sealedTokens as string).toMatch(/^kc1:/);
      expect(record?.sealedTokens as string).not.toMatch(/^v3:/);
    });
  });

  describe('the `tokens` collection stays under CREDS_KEY, unchanged', () => {
    it('mcp_oauth / mcp_oauth_refresh / mcp_oauth_client / oauth_refresh documents round-trip under CREDS_KEY with no migration', async () => {
      // The data-schemas crypto module captures `CREDS_KEY`/`CREDS_IV` from the environment at module
      // load. It is loaded once for the process — potentially before this file's `beforeAll` set the
      // env — so a fresh, isolated copy is loaded here with the env in place to exercise the exact
      // `CREDS_KEY` encrypt/decrypt pair the `tokens` collection uses. This mirrors what a real
      // deployment sees: the key is fixed at boot and every `tokens` write/read shares it.
      let crypto!: typeof import('@librechat/data-schemas');
      await jest.isolateModulesAsync(async () => {
        crypto = await import('@librechat/data-schemas');
      });
      const { encryptV2, encrypt, decrypt, decryptV2 } = crypto;

      const types = ['mcp_oauth', 'mcp_oauth_refresh', 'mcp_oauth_client', 'oauth_refresh'];
      for (const type of types) {
        const plaintext = `${type}-secret-payload`;

        // a document written before deployment (v2 iv:ciphertext under CREDS_KEY) decrypts after
        const encrypted = await encryptV2(plaintext);
        await methods.createToken({
          userId: new mongoose.Types.ObjectId().toString(),
          type,
          identifier: `id-${type}`,
          token: encrypted,
          expiresIn: 3600,
        });

        const stored = await methods.findToken({ identifier: `id-${type}` });
        // the stored ciphertext is byte-identical to what was written: no re-encryption, no migration
        expect(stored?.token).toBe(encrypted);
        // decryptV2 recovers the original plaintext under CREDS_KEY
        expect(await decryptV2(stored?.token as string)).toBe(plaintext);
        // and the legacy fixed-IV format decrypts too, proving CREDS_KEY is still the key in effect
        expect(await decrypt(await encrypt(plaintext))).toBe(plaintext);
      }
    });

    it('code touching the `tokens` collection imports none of the custody modules', () => {
      const srcRoot = path.resolve(__dirname, '..', '..');
      const tokenSources = [
        path.join(srcRoot, 'oauth', 'tokens.ts'),
        path.join(srcRoot, 'mcp', 'oauth', 'tokens.ts'),
      ];

      // the custody module family the `tokens` collection must not reach for
      const forbidden = [
        /from ['"].*custody\/key['"]/,
        /from ['"].*custody\/aead['"]/,
        /from ['"].*custody\/service['"]/,
        /from ['"].*custody\/binding['"]/,
        /from ['"].*custody\/loader['"]/,
        /from ['"].*custody['"]/,
        /require\(['"].*custody/,
      ];

      for (const file of tokenSources) {
        expect(fs.existsSync(file)).toBe(true);
        const source = fs.readFileSync(file, 'utf8');
        for (const pattern of forbidden) {
          expect(source).not.toMatch(pattern);
        }
        // sanity: these files DO use the CREDS_KEY crypto they are supposed to
        expect(source).toMatch(/encryptV2|decryptV2/);
      }
    });
  });

  describe('local auth is untouched by key custody', () => {
    it('a local-auth login and refresh set no token key cookie and create no custody record', async () => {
      const userId = new mongoose.Types.ObjectId().toString();

      // login writes exactly one `sessions` row through the local auth session writer
      const { session, refreshToken } = await methods.createSession(userId, {
        expiresIn: FALLBACK_REFRESH_TTL_MS,
      });
      expect(refreshToken).toBeTruthy();
      expect(await SessionModel().countDocuments()).toBe(1);

      // refresh rotates the same session's refresh token, still through local auth
      await methods.generateRefreshToken(
        session as Parameters<typeof methods.generateRefreshToken>[0],
      );

      // no token key cookie is minted anywhere on this path, and no custody record exists
      expect(await CustodyModel().countDocuments()).toBe(0);

      // a local-auth session never carries the custody cookie name
      const stored = (await SessionModel().findOne({ user: userId }).lean()) as Record<
        string,
        unknown
      > | null;
      expect(JSON.stringify(stored)).not.toContain(TOKEN_KEY_COOKIE);
    });

    it('the session id and stored hash are derived from neither the token key nor its hash', async () => {
      const userId = new mongoose.Types.ObjectId().toString();

      // mint an unrelated custody key so we can prove the session shares nothing with it
      const created = await service.createCustody({ tokens: payload(), identity: IDENTITY });
      const key = keyOf(created.tokenKey);
      const tokenKeyHash = hashTokenKey(key);

      const { session } = await methods.createSession(userId, {
        expiresIn: FALLBACK_REFRESH_TTL_MS,
      });

      const stored = (await SessionModel().findOne({ user: userId }).lean()) as unknown as {
        _id: mongoose.Types.ObjectId;
        refreshTokenHash: string;
      };

      const sessionId = String(stored._id);
      // the session id is a Mongo ObjectId, unrelated to the token key or its base64url encoding
      expect(sessionId).not.toBe(created.tokenKey);
      expect(sessionId).not.toBe(tokenKeyHash);
      // the stored refreshTokenHash is a SHA-256 hex of the app refresh token, not the token key hash
      expect(stored.refreshTokenHash).not.toBe(tokenKeyHash);
      expect(stored.refreshTokenHash).not.toBe(created.tokenKey);
      // and it does not contain the token key material as a substring
      expect(stored.refreshTokenHash).not.toContain(created.tokenKey);
      expect(String(session.user)).toBe(userId);
    });
  });
});
