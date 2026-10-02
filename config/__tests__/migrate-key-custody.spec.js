const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { logger, encryptV3 } = require('@librechat/data-schemas');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { generateTOTPSecret, verifyTOTP } = require('~/server/services/twoFactorService');

// The migration reaches Mongo through ./connect; the memory server stands in
// for the real connection, so ./connect must resolve without dialing out.
jest.mock('../connect', () => jest.fn().mockResolvedValue(true));

logger.silent = true;

/*
 * jestSetup binds CREDS_KEY to this value (32 bytes of hex), and the crypto
 * module reads it at import, so `encryptV3` seals under exactly this key. The
 * migration resolves the same CREDS_KEY the same way.
 */
const CREDS_KEY_HEX = '0123456789abcdef'.repeat(4);
const CREDS_KEY = Buffer.from(CREDS_KEY_HEX, 'hex');

/** A TOTP_KEY distinct from CREDS_KEY so re-encryption actually moves a secret. */
const TOTP_KEY_HEX = 'f'.repeat(64);
const TOTP_KEY = Buffer.from(TOTP_KEY_HEX, 'hex');

const CTR_ALGORITHM = 'aes-256-ctr';

/**
 * Seals a plaintext as a `v3:` blob (AES-256-CTR, fresh 16-byte IV) under an
 * arbitrary key, byte-for-byte the shape `encryptV3` and `generateTOTPSecret`
 * write. Mirrors `encryptV3Under` in packages/api's secret.spec.ts so a secret
 * can be sealed under a key other than the module-bound CREDS_KEY.
 */
function sealV3Under(value, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(CTR_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v3:${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

describe('Key Custody Migration Script', () => {
  let mongoServer;
  let User;
  let TokenCustody;
  let migrateKeyCustody;
  let flights;
  let bridges;

  const originalTotpKey = process.env.TOTP_KEY;

  /** The three indexes the custody store schema declares (step 4 installs them). */
  const CUSTODY_INDEX_NAMES = ['tokenKeyHash_1', 'expiresAt_1', 'userId_1_tenantId_1'];

  /** Seeds a user whose stored `totpSecret` is the given ciphertext. */
  async function seedUserWithSecret(storedSecret) {
    const user = await User.create({
      email: `${uuidv4()}@example.com`,
      totpSecret: storedSecret,
    });
    return user._id;
  }

  /** Reads a user's stored `totpSecret` back (it is `select: false`). */
  async function storedSecretFor(userId) {
    const user = await User.findById(userId).select('+totpSecret').lean();
    return user.totpSecret;
  }

  /**
   * The names of the indexes present on `tokencustodies`. With autoCreate off the
   * collection exists only once something builds it, so a missing collection means
   * no indexes — the honest reading of "the migration installed none".
   */
  async function custodyIndexNames() {
    try {
      const indexes = await TokenCustody.collection.indexes();
      return indexes.map((i) => i.name);
    } catch (error) {
      if (/ns does not exist/i.test(error.message)) {
        return [];
      }
      throw error;
    }
  }

  /** Snapshots every user's `_id → totpSecret`, for before/after comparison. */
  async function snapshotSecrets() {
    const users = await User.find({}).select('+totpSecret').lean();
    return users
      .map((u) => `${u._id.toString()}=${u.totpSecret ?? ''}`)
      .sort()
      .join('|');
  }

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    // Connect with auto-index/auto-create off, matching the MONGO_AUTO_INDEX=false
    // production posture the migration is built for. Without this, mongoose's
    // default background index build races this suite's assertions: when these two
    // migration suites run together on the shared global mongoose, a background
    // tokencustodies build kicked off on connect can land mid-suite and install
    // indexes the migration never asked for, flaking the "no index installed"
    // assertions. The migration installs its indexes explicitly (step 4), so the
    // automatic build has no legitimate role here. autoCreate is off too, so a
    // collection exists only once something explicitly builds it; the index reads
    // below treat an absent collection as "no indexes" via custodyIndexNames().
    await mongoose.connect(mongoServer.getUri(), { autoIndex: false, autoCreate: false });

    const dbModels = require('~/db/models');
    User = dbModels.User;
    TokenCustody = dbModels.TokenCustody;

    // The two coordination collections are addressed as raw handles, matching
    // how the migration reaches them (the bridge model no longer exists).
    flights = mongoose.connection.db.collection('openidrefreshflights');
    bridges = mongoose.connection.db.collection('refreshtokenbridges');

    ({ migrateKeyCustody } = require('../migrate-key-custody'));
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
    if (originalTotpKey === undefined) {
      delete process.env.TOTP_KEY;
    } else {
      process.env.TOTP_KEY = originalTotpKey;
    }
  });

  afterEach(async () => {
    await User.deleteMany({});
    await flights.deleteMany({});
    await bridges.deleteMany({});
    await TokenCustody.collection.dropIndexes().catch(() => {
      /* no non-_id indexes to drop when a test never built them */
    });
    if (originalTotpKey === undefined) {
      delete process.env.TOTP_KEY;
    } else {
      process.env.TOTP_KEY = originalTotpKey;
    }
  });

  describe('Step 1 — malformed TOTP_KEY aborts and skips steps 2 through 6', () => {
    it('sets no verification, touches no collection, and runs no later step', async () => {
      process.env.TOTP_KEY = 'not-hex';
      await seedUserWithSecret(encryptV3('JBSWY3DPEHPK3PXP'));
      await flights.insertOne({ _id: uuidv4(), key: uuidv4(), status: 'pending' });
      await bridges.insertOne({ _id: uuidv4(), hash: 'abc' });

      const result = await migrateKeyCustody({
        purgeLegacyBridges: true,
        reencryptTotp: true,
      });

      // Step 1 reported malformed; steps 2–6 did not run.
      expect(result.malformedTotpKey).toBe(true);
      expect(result.verification).toBeNull();
      expect(result.reencryption).toBeNull();
      expect(result.indexes).toBeNull();
      expect(result.flights).toBeNull();
      expect(result.bridges).toBeNull();

      // The leftover documents survive: no purge ran.
      expect(await flights.countDocuments({})).toBe(1);
      expect(await bridges.countDocuments({})).toBe(1);
      // No custody indexes were installed.
      const names = await custodyIndexNames();
      for (const name of CUSTODY_INDEX_NAMES) {
        expect(names).not.toContain(name);
      }
    });

    it('aborts even under --dry-run', async () => {
      process.env.TOTP_KEY = 'abc123'; // too short — not 64 hex chars

      const result = await migrateKeyCustody({ dryRun: true, reencryptTotp: true });

      expect(result.malformedTotpKey).toBe(true);
      expect(result.verification).toBeNull();
    });
  });

  describe('Step 2 — verify scan reports open/fail counts', () => {
    it('counts secrets that open and fail under the resolved key, writing nothing', async () => {
      process.env.TOTP_KEY = TOTP_KEY_HEX;

      // Two open under TOTP_KEY, one is sealed under CREDS_KEY (fails under TOTP_KEY),
      // one is garbage that opens under neither.
      await seedUserWithSecret(sealV3Under('JBSWY3DPEHPK3PXP', TOTP_KEY));
      await seedUserWithSecret(sealV3Under('KRSXG5BAORSXG5A', TOTP_KEY));
      await seedUserWithSecret(sealV3Under('GEZDGNBVGY3TQOJQ', CREDS_KEY));
      await seedUserWithSecret('v3:not-decryptable-garbage');

      const before = await snapshotSecrets();
      const result = await migrateKeyCustody({});

      expect(result.verification.scanned).toBe(4);
      expect(result.verification.opened).toBe(2);
      expect(result.verification.failed).toBe(2);
      // The two counts sum to the number of users scanned.
      expect(result.verification.opened + result.verification.failed).toBe(
        result.verification.scanned,
      );
      // Read-only: nothing was rewritten.
      expect(await snapshotSecrets()).toBe(before);
    });

    it('reports the CREDS_KEY default when TOTP_KEY is unset', async () => {
      delete process.env.TOTP_KEY;
      await seedUserWithSecret(encryptV3('JBSWY3DPEHPK3PXP'));

      const result = await migrateKeyCustody({});

      expect(result.totpKeySource).toBe('CREDS_KEY');
      expect(result.verification.scanned).toBe(1);
      expect(result.verification.opened).toBe(1);
      expect(result.verification.failed).toBe(0);
    });
  });

  describe('Step 3 — --reencrypt-totp moves only CREDS_KEY-readable secrets', () => {
    it('moves CREDS_KEY secrets, skips TOTP_KEY secrets, and leaves un-openable ones', async () => {
      process.env.TOTP_KEY = TOTP_KEY_HEX;

      const movable = await seedUserWithSecret(sealV3Under('JBSWY3DPEHPK3PXP', CREDS_KEY));
      const alreadyTotp = await seedUserWithSecret(sealV3Under('KRSXG5BAORSXG5A', TOTP_KEY));
      const unopenable = await seedUserWithSecret('v3:not-decryptable-garbage');

      const alreadyTotpBefore = await storedSecretFor(alreadyTotp);
      const unopenableBefore = await storedSecretFor(unopenable);

      const result = await migrateKeyCustody({ reencryptTotp: true });

      expect(result.reencryption.refused).toBe(false);
      expect(result.reencryption.reencrypted).toBe(1);
      expect(result.reencryption.skipped).toBe(1);
      expect(result.reencryption.unopenable).toBe(1);

      // The moved secret now opens under TOTP_KEY, and its plaintext is unchanged.
      const movedNow = await storedSecretFor(movable);
      expect(movedNow.startsWith('v3:')).toBe(true);
      const decipher = crypto.createDecipheriv(
        CTR_ALGORITHM,
        TOTP_KEY,
        Buffer.from(movedNow.split(':')[1], 'hex'),
      );
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(movedNow.split(':').slice(2).join(':'), 'hex')),
        decipher.final(),
      ]).toString('utf8');
      expect(plaintext).toBe('JBSWY3DPEHPK3PXP');

      // The already-TOTP and un-openable secrets are byte-for-byte untouched.
      expect(await storedSecretFor(alreadyTotp)).toBe(alreadyTotpBefore);
      expect(await storedSecretFor(unopenable)).toBe(unopenableBefore);
    });

    it('refuses to run and writes nothing when TOTP_KEY resolves to CREDS_KEY', async () => {
      // TOTP_KEY set to the same value as CREDS_KEY: nowhere to move a secret.
      process.env.TOTP_KEY = CREDS_KEY_HEX;
      await seedUserWithSecret(encryptV3('JBSWY3DPEHPK3PXP'));

      const before = await snapshotSecrets();
      const result = await migrateKeyCustody({ reencryptTotp: true });

      expect(result.reencryption.refused).toBe(true);
      expect(result.reencryption.reencrypted).toBe(0);
      expect(await snapshotSecrets()).toBe(before);
    });

    it('also refuses when TOTP_KEY is unset (resolves to the CREDS_KEY default)', async () => {
      delete process.env.TOTP_KEY;
      await seedUserWithSecret(encryptV3('JBSWY3DPEHPK3PXP'));

      const before = await snapshotSecrets();
      const result = await migrateKeyCustody({ reencryptTotp: true });

      expect(result.reencryption.refused).toBe(true);
      expect(await snapshotSecrets()).toBe(before);
    });
  });

  describe('Step 4 — install tokencustodies indexes', () => {
    it('installs the three declared indexes even with MONGO_AUTO_INDEX=false', async () => {
      // The migration sets MONGO_AUTO_INDEX=false at require; assert that posture
      // holds so this test genuinely exercises the explicit install.
      expect(process.env.MONGO_AUTO_INDEX).toBe('false');
      delete process.env.TOTP_KEY;

      const result = await migrateKeyCustody({});

      expect(result.indexes.dryRun).toBe(false);
      const indexes = await TokenCustody.collection.indexes();
      for (const name of CUSTODY_INDEX_NAMES) {
        expect(indexes.some((i) => i.name === name)).toBe(true);
      }
      // The TTL index carries expireAfterSeconds: 0.
      const ttl = indexes.find((i) => i.name === 'expiresAt_1');
      expect(ttl.expireAfterSeconds).toBe(0);
      // The lookup index is unique.
      const unique = indexes.find((i) => i.name === 'tokenKeyHash_1');
      expect(unique.unique).toBe(true);
    });
  });

  describe('Step 5 — purge openidrefreshflights', () => {
    it('deletes every flight document unconditionally', async () => {
      delete process.env.TOTP_KEY;
      await flights.insertMany([
        { _id: uuidv4(), key: uuidv4(), status: 'a' },
        { _id: uuidv4(), key: uuidv4(), status: 'b' },
      ]);

      const result = await migrateKeyCustody({});

      expect(result.flights.deleted).toBe(2);
      expect(await flights.countDocuments({})).toBe(0);
    });
  });

  describe('Step 6 — purge refreshtokenbridges only under the flag', () => {
    it('leaves bridges alone without the flag', async () => {
      delete process.env.TOTP_KEY;
      await bridges.insertMany([{ _id: uuidv4() }, { _id: uuidv4() }]);

      const result = await migrateKeyCustody({});

      expect(result.bridges).toBeNull();
      expect(await bridges.countDocuments({})).toBe(2);
    });

    it('deletes every bridge document with --purge-legacy-bridges', async () => {
      delete process.env.TOTP_KEY;
      await bridges.insertMany([{ _id: uuidv4() }, { _id: uuidv4() }]);

      const result = await migrateKeyCustody({ purgeLegacyBridges: true });

      expect(result.bridges.deleted).toBe(2);
      expect(await bridges.countDocuments({})).toBe(0);
    });
  });

  describe('--dry-run writes nothing for every write step', () => {
    it('reports the counts it would write but changes no document or index', async () => {
      process.env.TOTP_KEY = TOTP_KEY_HEX;

      await seedUserWithSecret(sealV3Under('JBSWY3DPEHPK3PXP', CREDS_KEY));
      await flights.insertOne({ _id: uuidv4(), key: uuidv4(), status: 'pending' });
      await bridges.insertOne({ _id: uuidv4() });

      const secretsBefore = await snapshotSecrets();
      const result = await migrateKeyCustody({
        dryRun: true,
        reencryptTotp: true,
        purgeLegacyBridges: true,
      });

      // Every write step reports what it would do.
      expect(result.reencryption.reencrypted).toBe(1);
      expect(result.indexes.dryRun).toBe(true);
      expect(result.indexes.installed.length).toBe(3);
      expect(result.flights.deleted).toBe(1);
      expect(result.bridges.deleted).toBe(1);

      // Nothing was actually written, built or deleted.
      expect(await snapshotSecrets()).toBe(secretsBefore);
      expect(await flights.countDocuments({})).toBe(1);
      expect(await bridges.countDocuments({})).toBe(1);
      const names = await custodyIndexNames();
      for (const name of CUSTODY_INDEX_NAMES) {
        expect(names).not.toContain(name);
      }
    });
  });

  describe('a second run with the same flags leaves the same state', () => {
    it('re-encrypts zero secrets and reaches the same database state', async () => {
      process.env.TOTP_KEY = TOTP_KEY_HEX;

      await seedUserWithSecret(sealV3Under('JBSWY3DPEHPK3PXP', CREDS_KEY));
      await seedUserWithSecret(sealV3Under('KRSXG5BAORSXG5A', TOTP_KEY));
      await flights.insertOne({ _id: uuidv4(), key: uuidv4(), status: 'pending' });
      await bridges.insertOne({ _id: uuidv4() });

      const first = await migrateKeyCustody({
        reencryptTotp: true,
        purgeLegacyBridges: true,
      });
      expect(first.reencryption.reencrypted).toBe(1);

      const afterFirst = await snapshotSecrets();

      const second = await migrateKeyCustody({
        reencryptTotp: true,
        purgeLegacyBridges: true,
      });

      // The second run moves nothing: every secret already opens under TOTP_KEY.
      expect(second.reencryption.reencrypted).toBe(0);
      expect(second.reencryption.skipped).toBe(2);
      // The database state is unchanged by the second run.
      expect(await snapshotSecrets()).toBe(afterFirst);
      expect(await flights.countDocuments({})).toBe(0);
      expect(await bridges.countDocuments({})).toBe(0);
    });
  });

  describe('a --reencrypt-totp run followed by a real verifyTOTP', () => {
    it('every re-encrypted secret verifies under TOTP_KEY', async () => {
      process.env.TOTP_KEY = TOTP_KEY_HEX;

      // Real generated secrets, sealed under CREDS_KEY so the migration moves them.
      const secrets = [generateTOTPSecret(), generateTOTPSecret(), generateTOTPSecret()];
      const userIds = [];
      for (const secret of secrets) {
        userIds.push(await seedUserWithSecret(sealV3Under(secret, CREDS_KEY)));
      }

      const result = await migrateKeyCustody({ reencryptTotp: true });
      expect(result.reencryption.reencrypted).toBe(3);

      // Open each re-encrypted secret under TOTP_KEY, then verify a fresh TOTP
      // token generated from the recovered plaintext — the real 2FA path.
      for (let i = 0; i < userIds.length; i++) {
        const stored = await storedSecretFor(userIds[i]);
        const parts = stored.split(':');
        const decipher = crypto.createDecipheriv(
          CTR_ALGORITHM,
          TOTP_KEY,
          Buffer.from(parts[1], 'hex'),
        );
        const recovered = Buffer.concat([
          decipher.update(Buffer.from(parts.slice(2).join(':'), 'hex')),
          decipher.final(),
        ]).toString('utf8');
        expect(recovered).toBe(secrets[i]);

        // A token minted from the recovered secret passes real verifyTOTP.
        const { generateTOTP } = require('~/server/services/twoFactorService');
        const token = await generateTOTP(recovered);
        expect(await verifyTOTP(recovered, token)).toBe(true);
      }
    });
  });
});
