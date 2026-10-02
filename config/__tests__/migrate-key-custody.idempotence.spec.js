const crypto = require('node:crypto');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Mock the config/connect module so migrateKeyCustody reuses the in-memory
// connection this suite stands up rather than dialing a real Mongo.
jest.mock('../connect', () => jest.fn().mockResolvedValue(true));

logger.silent = true;

/**
 * Running the migration a second time with the same flags, against the database
 * the first run left, changes nothing: the stored secrets, the tokencustodies
 * indexes and the flight/bridge counts match the first run, and a second
 * --reencrypt-totp run re-encrypts zero secrets.
 */
describe('migrateKeyCustody idempotence', () => {
  let mongoServer;
  let User;
  let migrateKeyCustody;
  let credsKey;
  let originalTotpKey;

  const FLIGHT_COLLECTION = 'openidrefreshflights';
  const BRIDGE_COLLECTION = 'refreshtokenbridges';

  // A distinct dedicated two-factor key, unequal to CREDS_KEY set in jestSetup.js.
  const TOTP_KEY_HEX = 'fedcba9876543210'.repeat(4);
  // A key that is neither CREDS_KEY nor TOTP_KEY, for a secret nothing can open.
  const FOREIGN_KEY = Buffer.from('0123456789abcdef'.repeat(4), 'hex');

  /** v3 (`v3:<iv>:<ct>`, AES-256-CTR) — the format the re-encrypt step writes. */
  function encryptV3(plaintext, key) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `v3:${iv.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /** v2 (`<iv>:<ct>`, AES-256-CBC) — a legacy colon-delimited value. */
  function encryptV2(plaintext, key) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /** The observable state the migration touches; equal snapshots mean "same database state". */
  async function snapshotState() {
    const users = await User.find({}).select('+totpSecret').lean();
    const secrets = {};
    for (const user of users) {
      secrets[String(user._id)] = user.totpSecret ?? null;
    }

    const db = mongoose.connection.db;
    const indexes = await db.collection('tokencustodies').indexes();
    const indexNames = indexes.map((index) => index.name).sort();

    const flights = await db.collection(FLIGHT_COLLECTION).countDocuments({});
    const bridges = await db.collection(BRIDGE_COLLECTION).countDocuments({});

    return { secrets, indexNames, flights, bridges };
  }

  /** Reset every collection the migration or the fixtures touch. */
  async function resetDatabase() {
    const db = mongoose.connection.db;
    await User.deleteMany({});
    await db.collection(FLIGHT_COLLECTION).deleteMany({});
    await db.collection(BRIDGE_COLLECTION).deleteMany({});
    // Drop tokencustodies outright so each case starts with no indexes installed.
    await db
      .collection('tokencustodies')
      .drop()
      .catch(() => {
        /* not yet created */
      });
  }

  /**
   * Seed one secret of each kind so the first run has real re-encrypt work and
   * the second run has something to skip.
   */
  async function seedUsers() {
    const totpKey = Buffer.from(TOTP_KEY_HEX, 'hex');
    const secrets = [
      // Opens under CREDS_KEY only — the re-encrypt step moves these.
      encryptV3('JBSWY3DPEHPK3PXP', credsKey),
      encryptV2('KRSXG5CTMVRXEZLU', credsKey),
      // Bare 16-char Base32 secret: returned as-is under any key, so it is skipped.
      'GEZDGNBVGY3TQOJQ',
      // Already sealed under TOTP_KEY — skipped on every run.
      encryptV3('MFRGGZDFMZTWQ2LK', totpKey),
      // Opens under neither key — left unchanged.
      encryptV3('NBSWY3DPO5XXE3DE', FOREIGN_KEY),
    ];
    for (const [i, totpSecret] of secrets.entries()) {
      await User.create({
        name: `TOTP User ${i}`,
        email: `totp-${i}@test.com`,
        role: 'USER',
        totpSecret,
      });
    }
  }

  /** Seed `count` documents into a coordination collection. */
  async function seedCollection(name, count) {
    if (count === 0) {
      return;
    }
    // The flight schema declares a unique `key` index, so each document needs its own key.
    const docs = Array.from({ length: count }, () => ({
      _id: new mongoose.Types.ObjectId(),
      key: crypto.randomUUID(),
      createdAt: new Date(),
    }));
    await mongoose.connection.db.collection(name).insertMany(docs);
  }

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    // autoIndex/autoCreate off matches the MONGO_AUTO_INDEX=false production posture.
    // Without it, a background tokencustodies index build on the shared mongoose can
    // race the sibling migration suite's "no index installed" assertions.
    await mongoose.connect(mongoServer.getUri(), { autoIndex: false, autoCreate: false });

    const dbModels = require('~/db/models');
    User = dbModels.User;

    credsKey = Buffer.from(process.env.CREDS_KEY, 'hex');

    ({ migrateKeyCustody } = require('../migrate-key-custody'));

    // The re-encrypt step needs a distinct TOTP_KEY to have anything to move; the
    // script reads process.env at call time.
    originalTotpKey = process.env.TOTP_KEY;
    process.env.TOTP_KEY = TOTP_KEY_HEX;
  });

  afterAll(async () => {
    if (originalTotpKey === undefined) {
      delete process.env.TOTP_KEY;
    } else {
      process.env.TOTP_KEY = originalTotpKey;
    }
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // Five users are seeded: batch size 1 is one per batch, 2 leaves a partial last
  // batch, 5 fits them all in one. Collection counts cover empty, one and several.
  const sizes = [
    { batchSize: 1, flights: 0, bridges: 0 },
    { batchSize: 2, flights: 1, bridges: 4 },
    { batchSize: 5, flights: 4, bridges: 1 },
  ];
  const cases = [false, true].flatMap((purgeLegacyBridges) =>
    [false, true].flatMap((reencryptTotp) =>
      sizes.map((size) => ({ purgeLegacyBridges, reencryptTotp, ...size })),
    ),
  );

  it.each(cases)(
    'leaves the same state after a second run (purgeLegacyBridges=$purgeLegacyBridges, reencryptTotp=$reencryptTotp, batchSize=$batchSize, flights=$flights, bridges=$bridges)',
    async ({ purgeLegacyBridges, reencryptTotp, batchSize, flights, bridges }) => {
      await resetDatabase();
      await seedUsers();
      await seedCollection(FLIGHT_COLLECTION, flights);
      await seedCollection(BRIDGE_COLLECTION, bridges);

      const flags = { purgeLegacyBridges, reencryptTotp, batchSize };

      await migrateKeyCustody(flags);
      const afterFirst = await snapshotState();

      const secondResult = await migrateKeyCustody(flags);
      const afterSecond = await snapshotState();

      expect(afterSecond).toEqual(afterFirst);

      if (reencryptTotp) {
        expect(secondResult.reencryption).not.toBeNull();
        expect(secondResult.reencryption.refused).toBe(false);
        expect(secondResult.reencryption.reencrypted).toBe(0);
      }
    },
  );
});
