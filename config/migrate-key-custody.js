require('dotenv').config();

/*
 * Custody records, their indexes and the leftover coordination collections are
 * created lazily on the first login write, so this script must never let Mongo
 * auto-build them out from under the explicit index step. Match the
 * `MONGO_AUTO_INDEX=false` posture the other migrations set.
 */
process.env.MONGO_AUTO_INDEX = 'false';
process.env.MONGO_AUTO_CREATE = 'false';

const path = require('path');
const crypto = require('node:crypto');
const { logger, runAsSystem, createIndexesWithRetry } = require('@librechat/data-schemas');

require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });
const mongoose = require('mongoose');
const connect = require('./connect');

const { User, TokenCustody } = require('~/db/models');

/**
 * Key custody migration. Steps, in order:
 *
 *   1. Resolve and report the TOTP key. Fail immediately, with a non-zero exit
 *      code and no further steps, on a malformed `TOTP_KEY`. This runs first
 *      because it is the check that prevents a 2FA lockout.
 *   2. Verify TOTP secrets. Scan every user with a stored secret in cursor
 *      batches, attempt the prefix dispatch under the resolved key, and report
 *      how many open and how many fail. Nothing is written.
 *   3. `--reencrypt-totp` (write). Re-encrypt under `TOTP_KEY` exactly those
 *      secrets that open under `CREDS_KEY` but not under `TOTP_KEY`, skipping
 *      those already readable under `TOTP_KEY` and leaving those that open
 *      under neither. Refuses to run, writing nothing, when `TOTP_KEY` resolves
 *      to `CREDS_KEY` — there is nothing to move. Under `--dry-run` it reports
 *      the count it would re-encrypt and writes nothing.
 *   4. Install the `tokencustodies` indexes (write). Build every index the
 *      custody store schema declares — the unique `tokenKeyHash` index, the
 *      `expiresAt` TTL index and `{ userId: 1, tenantId: 1 }` — explicitly, so
 *      `MONGO_AUTO_INDEX=false` deployments have them before the first login
 *      write. Under `--dry-run` it reports the indexes it would install and
 *      builds nothing.
 *   5. Purge `openidrefreshflights` (write). Delete every document in the
 *      flight collection: seconds-long coordination state in the old format
 *      whose loss costs at most one coalesced refresh. Under `--dry-run` it
 *      reports the count it would delete and deletes nothing.
 *   6. `--purge-legacy-bridges` (write). Delete every document in the leftover
 *      `refreshtokenbridges` collection, only when the flag is set. The bridge
 *      modules were removed, but the documents remain until purged (or until
 *      their own TTL empties the collection). Under `--dry-run` it reports the
 *      count it would delete and deletes nothing.
 *
 * The script touches no `tokens` or `sessions` document, performs no Redis
 * access, and creates no custody record from an existing session.
 *
 * Usage:
 *   node config/migrate-key-custody.js [--dry-run] [--purge-legacy-bridges] \
 *     [--reencrypt-totp] [--batch-size=N]
 */

/**
 * Default Mongo collection names for the two coordination collections. They are
 * addressed as raw collections rather than through a Mongoose model: the flight
 * model still exists, but the bridge model and its schema were deleted with the
 * bridge store, so a raw handle is the only way to reach the leftover documents
 * and keeps both purge steps uniform.
 */
const FLIGHT_COLLECTION = 'openidrefreshflights';
const BRIDGE_COLLECTION = 'refreshtokenbridges';

/** Matches `secret.ts`: `TOTP_KEY` is valid only as exactly 64 hex characters (32 bytes). */
const TOTP_KEY_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const CTR_ALGORITHM = 'aes-256-ctr';
const CBC_ALGORITHM = 'aes-256-cbc';

/**
 * A decrypted TOTP secret is Base32 (RFC 4648, no padding needed at these
 * lengths) — the alphabet `A-Z2-7`, matching `generateTOTPSecret`. A `v3:` (CTR)
 * value opened under the wrong key yields arbitrary bytes rather than throwing,
 * so "opens" cannot mean "did not throw"; it means the plaintext is a usable
 * Base32 secret. This is the same shape `verifyTOTP` would decode.
 */
const BASE32_SECRET_PATTERN = /^[A-Z2-7]+=*$/;

/**
 * Whether a raw environment value counts as configured. Absent, empty and
 * whitespace-only all read as unset — the same test `secret.ts` and the
 * existing `CREDS_KEY` / `CREDS_IV` validation use for an unconfigured value.
 *
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isConfigured(value) {
  return Boolean(value && value.trim());
}

/**
 * Resolves the TOTP key exactly as `packages/api`'s `secret.ts` resolver does,
 * without importing it: `TOTP_KEY` when set to 64 hex characters, otherwise
 * `CREDS_KEY`. Reports whether the key is the dedicated `TOTP_KEY` or the
 * `CREDS_KEY` default and flags a malformed `TOTP_KEY` rather than throwing, so
 * step 1 can set the exit code and skip the rest.
 *
 * The resolution is duplicated here on purpose: `readTotpSecret` throws lazily
 * on first use and memoizes its key, which is the wrong shape for a step that
 * must decide up front whether to run at all and must report the source.
 *
 * The `credsKey` buffer is returned alongside the resolved key so step 3 can
 * open a secret under `CREDS_KEY` and, when `TOTP_KEY` resolves to `CREDS_KEY`,
 * detect that there is nothing to move without re-deriving the key. It is the
 * `CREDS_KEY` value in effect after credential bootstrap, decoded as hex the
 * same way `secret.ts` does.
 *
 * @returns {{ key: Buffer | null, credsKey: Buffer, source: 'TOTP_KEY' | 'CREDS_KEY', malformed: boolean }}
 */
function resolveTotpKey() {
  const credsKey = Buffer.from(process.env.CREDS_KEY ?? '', 'hex');
  const totpKey = process.env.TOTP_KEY;
  if (isConfigured(totpKey)) {
    if (!TOTP_KEY_HEX_PATTERN.test(totpKey)) {
      return { key: null, credsKey, source: 'TOTP_KEY', malformed: true };
    }
    return { key: Buffer.from(totpKey, 'hex'), credsKey, source: 'TOTP_KEY', malformed: false };
  }
  return {
    key: credsKey,
    credsKey,
    source: 'CREDS_KEY',
    malformed: false,
  };
}

/**
 * Decrypts one stored secret under the supplied key using the same prefix
 * dispatch as `readTotpSecret` (`v3:` -> AES-256-CTR, colon-delimited -> v2
 * AES-256-CBC, 16-char bare secret returned as-is, anything else returned
 * as-is). Throws on a structurally malformed ciphertext (bad hex, wrong IV
 * length), exactly where `readTotpSecret` throws.
 *
 * @param {string} storedSecret
 * @param {Buffer} key
 * @returns {string}
 */
function decryptWithKey(storedSecret, key) {
  if (storedSecret.startsWith('v3:')) {
    const parts = storedSecret.split(':');
    const iv = Buffer.from(parts[1], 'hex');
    const encryptedText = Buffer.from(parts.slice(2).join(':'), 'hex');
    const decipher = crypto.createDecipheriv(CTR_ALGORITHM, key, iv);
    return Buffer.concat([decipher.update(encryptedText), decipher.final()]).toString('utf8');
  }
  if (storedSecret.includes(':')) {
    const parts = storedSecret.split(':');
    const iv = Buffer.from(parts.shift() ?? '', 'hex');
    const encrypted = parts.join(':');
    const decipher = crypto.createDecipheriv(CBC_ALGORITHM, key, Buffer.from(iv));
    const encryptedBuffer = Buffer.from(encrypted, 'hex');
    return Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]).toString('utf8');
  }
  if (storedSecret.length === 16) {
    return storedSecret;
  }
  return storedSecret;
}

/**
 * Encrypts one plaintext TOTP secret under the supplied key as a `v3:` blob,
 * byte-for-byte the format `encryptV3` (`packages/data-schemas/src/crypto`)
 * produces and `generateTOTPSecret` writes: AES-256-CTR, a fresh 16-byte IV,
 * `v3:<iv-hex>:<ciphertext-hex>`. This is the only shape the re-encrypt step
 * writes, so a re-encrypted secret reads back through the same `v3:` branch of
 * `readTotpSecret` that step 2 verified, and its plaintext is unchanged: only
 * the ciphertext differs.
 *
 * @param {string} plaintext
 * @param {Buffer} key
 * @returns {string}
 */
function encryptV3WithKey(plaintext, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(CTR_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v3:${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Whether a stored secret opens under the resolved key: the prefix dispatch
 * succeeds and the plaintext is a usable Base32 secret. A wrong key that
 * throws (v2/v3 hex or block errors) and a wrong key that yields non-Base32
 * garbage (v3 CTR) both count as "does not open", which is the honest signal
 * step 2 reports and step 3 acts on.
 *
 * @param {string} storedSecret
 * @param {Buffer} key
 * @returns {string | null} the usable Base32 plaintext, or null if it does not open
 */
function openUnderKey(storedSecret, key) {
  let plaintext;
  try {
    plaintext = decryptWithKey(storedSecret, key);
  } catch {
    return null;
  }
  return typeof plaintext === 'string' && BASE32_SECRET_PATTERN.test(plaintext) ? plaintext : null;
}

/**
 * Whether a stored secret opens under the resolved key. A thin boolean view of
 * {@link openUnderKey} for the read-only verify scan (step 2), which needs only
 * the open/fail signal and not the plaintext.
 *
 * @param {string} storedSecret
 * @param {Buffer} key
 * @returns {boolean}
 */
function opensUnderKey(storedSecret, key) {
  return openUnderKey(storedSecret, key) !== null;
}

/**
 * Step 1 — resolve and report the TOTP key.
 *
 * @returns {{ key: Buffer | null, credsKey: Buffer, source: string, malformed: boolean }}
 */
function reportTotpKey() {
  const resolved = resolveTotpKey();
  logger.info('[migrate-key-custody] Step 1: resolve TOTP key');
  if (resolved.malformed) {
    logger.error(
      '[migrate-key-custody] TOTP_KEY is malformed: it must be exactly 64 hexadecimal characters ' +
        '(32 bytes). Skipping every subsequent step. Restore the original value if it protects ' +
        'existing secrets; plan a controlled re-encryption before rotating it.',
    );
    return resolved;
  }
  if (resolved.source === 'TOTP_KEY') {
    logger.info('[migrate-key-custody] TOTP_KEY is set; stored secrets are read under it.');
  } else {
    logger.info(
      '[migrate-key-custody] TOTP_KEY is not set; defaulting to CREDS_KEY. This reproduces ' +
        "today's behavior — no dedicated two-factor key is in effect.",
    );
  }
  return resolved;
}

/**
 * Step 2 — verify TOTP secrets. Scans every user with a stored secret in cursor
 * batches of `batchSize`, attempts the prefix dispatch under the resolved key,
 * and reports the opening and failing counts (which sum to the users scanned).
 * Writes nothing, under `--dry-run` or otherwise.
 *
 * @param {Buffer} key
 * @param {number} batchSize
 * @returns {Promise<{ scanned: number, opened: number, failed: number }>}
 */
async function verifyTotpSecrets(key, batchSize) {
  logger.info('[migrate-key-custody] Step 2: verify TOTP secrets');

  /*
   * Scan across every tenant under system context, matching the other
   * cross-tenant migrations, so the tenant isolation plugin neither throws
   * under TENANT_ISOLATION_STRICT=true nor scopes to a non-existent tenant.
   * `totpSecret` is `select: false`, so it must be projected in explicitly.
   */
  return runAsSystem(async () => {
    const cursor = User.find({ totpSecret: { $exists: true, $ne: null } })
      .select('+totpSecret')
      .batchSize(batchSize)
      .cursor();

    let scanned = 0;
    let opened = 0;
    let failed = 0;

    for await (const user of cursor) {
      const storedSecret = user.totpSecret;
      if (!storedSecret) {
        // Defensive: the query filters these out, but a concurrent clear could
        // race the cursor. An empty secret is not a scannable secret.
        continue;
      }
      scanned++;
      if (opensUnderKey(storedSecret, key)) {
        opened++;
      } else {
        failed++;
      }
    }

    logger.info(
      `[migrate-key-custody] Verified ${scanned} stored secret(s): ${opened} open under the ` +
        `resolved key, ${failed} do not.`,
    );
    if (failed > 0) {
      logger.warn(
        `[migrate-key-custody] ${failed} secret(s) do not open under the resolved key. If ` +
          'TOTP_KEY is set, run --reencrypt-totp to move secrets still under CREDS_KEY; if it is ' +
          'unset, the failing secrets predate this key or the wrong CREDS_KEY is configured.',
      );
    }
    return { scanned, opened, failed };
  });
}

/**
 * Whether the resolved TOTP key and the `CREDS_KEY` are the same key material.
 * Step 3 refuses to run in this case: there is nowhere to move
 * a secret to. This covers both `TOTP_KEY` unset (the resolver already returned
 * the `CREDS_KEY` buffer) and `TOTP_KEY` set to the same value as `CREDS_KEY`.
 *
 * @param {Buffer} key
 * @param {Buffer} credsKey
 * @returns {boolean}
 */
function resolvesToCredsKey(key, credsKey) {
  return key.length === credsKey.length && crypto.timingSafeEqual(key, credsKey);
}

/**
 * Step 3 — `--reencrypt-totp`. Re-encrypts under `TOTP_KEY`, and writes back,
 * exactly the secrets that open under `CREDS_KEY` but not under `TOTP_KEY`. A
 * secret already readable under `TOTP_KEY` is skipped, which makes reruns
 * idempotent; a secret that opens under neither key is left unchanged —
 * re-encrypting it would destroy it, which is why the read-only verify scan is
 * kept separate from this fix. Refuses to run, writing nothing and reporting
 * why, when `TOTP_KEY` resolves to `CREDS_KEY`.
 *
 * Under `--dry-run` it reports the count it would re-encrypt and writes nothing.
 * Writes proceed in cursor batches of `batchSize`.
 *
 * Cache: this step rewrites `user.totpSecret` but performs no auth user
 * document cache invalidation. `sanitizeUserForCache` strips `totpSecret`
 * before anything is cached, so no cached `req.user` can carry a stale secret;
 * and a standalone migration process cannot reliably reach a per-process
 * in-memory (or Redis-backed) cache anyway.
 *
 * @param {Buffer} key the resolved TOTP key (must be TOTP_KEY, not CREDS_KEY)
 * @param {Buffer} credsKey
 * @param {number} batchSize
 * @param {boolean} dryRun
 * @returns {Promise<{ reencrypted: number, skipped: number, unopenable: number, refused: boolean }>}
 */
async function reencryptTotpSecrets(key, credsKey, batchSize, dryRun) {
  logger.info('[migrate-key-custody] Step 3: re-encrypt TOTP secrets (--reencrypt-totp)');

  if (resolvesToCredsKey(key, credsKey)) {
    logger.warn(
      '[migrate-key-custody] Re-encryption refused: TOTP_KEY resolves to CREDS_KEY (unset, or set ' +
        'to the same value as CREDS_KEY). There is nothing to move — secrets are already read ' +
        'under this key. Set a distinct TOTP_KEY to separate the two-factor key from the ' +
        'credential key.',
    );
    return { reencrypted: 0, skipped: 0, unopenable: 0, refused: true };
  }

  /*
   * Key-rollout ordering is an operational hazard the script cannot enforce,
   * so warn on every run: servers that still hold the old key after this runs
   * cannot read the rewritten secrets.
   */
  logger.warn(
    '[migrate-key-custody] Key-rollout ordering: ensure every server process holds the new ' +
      'TOTP_KEY BEFORE OR AT THE SAME TIME AS this re-encryption, never after. A server still ' +
      'holding the old key after this runs cannot read the re-encrypted secrets: it fails 2FA ' +
      'verification closed and refuses TOTP-gated account deletion until it restarts with ' +
      'TOTP_KEY set. Re-encryption is transparent to users — the plaintext secret is unchanged, ' +
      'only its ciphertext differs — so the failure mode is operational, not user-visible.',
  );

  return runAsSystem(async () => {
    const cursor = User.find({ totpSecret: { $exists: true, $ne: null } })
      .select('+totpSecret')
      .batchSize(batchSize)
      .cursor();

    let reencrypted = 0;
    let skipped = 0;
    let unopenable = 0;

    for await (const user of cursor) {
      const storedSecret = user.totpSecret;
      if (!storedSecret) {
        // Defensive: filtered out by the query, but a concurrent clear could
        // race the cursor. An empty secret is not a re-encryptable secret.
        continue;
      }

      // Skip secrets already readable under TOTP_KEY — nothing to move, and the
      // basis of idempotence: a second run re-encrypts zero secrets.
      if (opensUnderKey(storedSecret, key)) {
        skipped++;
        continue;
      }

      // Re-encrypt only what opens under CREDS_KEY. A secret that opens under
      // neither key is left untouched: re-encrypting it would seal garbage over
      // the real secret.
      const plaintext = openUnderKey(storedSecret, credsKey);
      if (plaintext === null) {
        unopenable++;
        continue;
      }

      if (dryRun) {
        reencrypted++;
        continue;
      }

      /*
       * Deliberately no cache invalidation: totpSecret never enters the auth
       * user document cache, so a bare updateOne on the one field is enough.
       */
      const resealed = encryptV3WithKey(plaintext, key);
      await User.updateOne({ _id: user._id }, { $set: { totpSecret: resealed } });
      reencrypted++;
    }

    if (dryRun) {
      logger.info(
        `[migrate-key-custody] DRY RUN: would re-encrypt ${reencrypted} secret(s) under TOTP_KEY; ` +
          `${skipped} already readable under TOTP_KEY (skipped); ${unopenable} open under neither ` +
          'key (left unchanged). Nothing written.',
      );
    } else {
      logger.info(
        `[migrate-key-custody] Re-encrypted ${reencrypted} secret(s) under TOTP_KEY; ${skipped} ` +
          `already readable under TOTP_KEY (skipped); ${unopenable} open under neither key (left ` +
          'unchanged).',
      );
    }

    return { reencrypted, skipped, unopenable, refused: false };
  });
}

/**
 * Step 4 — install the `tokencustodies` indexes. The custody store builds these
 * lazily on the first login write, so a `MONGO_AUTO_INDEX=false` deployment that
 * has not yet seen an OpenID login has none of them. This step builds every
 * index the schema declares — the unique `tokenKeyHash` index, the `expiresAt`
 * TTL index and `{ userId: 1, tenantId: 1 }` — through `createIndexesWithRetry`,
 * the same helper `createTokenCustodyMethods.ensureIndexes` uses, so the engine's
 * one-build-per-collection constraint is honored. Idempotent: an index that
 * already exists is left as it is.
 *
 * Under `--dry-run` it reports the indexes it would install and builds nothing.
 *
 * @param {boolean} dryRun
 * @returns {Promise<{ installed: string[], dryRun: boolean }>}
 */
async function installTokenCustodyIndexes(dryRun) {
  logger.info('[migrate-key-custody] Step 4: install tokencustodies indexes');

  /*
   * The index specs are read off the registered schema rather than hard-coded,
   * so this step follows the schema declaration and cannot drift from it. Each
   * entry is `[keys, options]`; the name Mongo derives is enough for reporting.
   */
  const declared = TokenCustody.schema.indexes().map(([keys, options]) => {
    const spec = Object.entries(keys)
      .map(([field, direction]) => `${field}:${direction}`)
      .join(', ');
    const attrs = [];
    if (options && options.unique) {
      attrs.push('unique');
    }
    if (options && typeof options.expireAfterSeconds === 'number') {
      attrs.push(`ttl expireAfterSeconds=${options.expireAfterSeconds}`);
    }
    return attrs.length > 0 ? `{ ${spec} } (${attrs.join(', ')})` : `{ ${spec} }`;
  });

  if (dryRun) {
    logger.info(
      `[migrate-key-custody] DRY RUN: would install ${declared.length} tokencustodies index(es): ` +
        `${declared.join('; ')}. Nothing built.`,
    );
    return { installed: declared, dryRun: true };
  }

  await createIndexesWithRetry(TokenCustody);
  logger.info(
    `[migrate-key-custody] Installed ${declared.length} tokencustodies index(es): ` +
      `${declared.join('; ')}.`,
  );
  return { installed: declared, dryRun: false };
}

/**
 * Step 5 — purge `openidrefreshflights`. Every flight document is seconds-long
 * coordination state in the old `encryptV2` format; leaving them risks a
 * mixed-format read during the rollout, and losing them costs at most one
 * coalesced refresh. Deletes them all unconditionally
 * — this is not gated behind a flag, unlike the bridge purge — through a raw
 * collection handle so it does not depend on the flight model being registered.
 *
 * Under `--dry-run` it reports the count it would delete and deletes nothing.
 *
 * @param {boolean} dryRun
 * @returns {Promise<{ deleted: number, dryRun: boolean }>}
 */
async function purgeOpenIDRefreshFlights(dryRun) {
  logger.info('[migrate-key-custody] Step 5: purge openidrefreshflights');

  const collection = mongoose.connection.db.collection(FLIGHT_COLLECTION);

  if (dryRun) {
    const count = await collection.countDocuments({});
    logger.info(
      `[migrate-key-custody] DRY RUN: would delete ${count} openidrefreshflights document(s). ` +
        'Nothing deleted.',
    );
    return { deleted: count, dryRun: true };
  }

  const result = await collection.deleteMany({});
  logger.info(
    `[migrate-key-custody] Deleted ${result.deletedCount} openidrefreshflights document(s).`,
  );
  return { deleted: result.deletedCount, dryRun: false };
}

/**
 * Step 6 — `--purge-legacy-bridges`. The bridge store modules were deleted, but
 * the `refreshtokenbridges` documents remain until purged (or until their own
 * TTL empties the collection). This step deletes them all, only when the flag is
 * set — the default-off posture is deliberate: deleting data is irreversible and
 * the collection empties itself within `REFRESH_TOKEN_EXPIRY`, so the purge is
 * the audited action, not the default. A raw collection handle is used because
 * the model no longer exists.
 *
 * Under `--dry-run` it reports the count it would delete and deletes nothing.
 *
 * @param {boolean} dryRun
 * @returns {Promise<{ deleted: number, dryRun: boolean }>}
 */
async function purgeLegacyRefreshTokenBridges(dryRun) {
  logger.info('[migrate-key-custody] Step 6: purge refreshtokenbridges (--purge-legacy-bridges)');

  const collection = mongoose.connection.db.collection(BRIDGE_COLLECTION);

  if (dryRun) {
    const count = await collection.countDocuments({});
    logger.info(
      `[migrate-key-custody] DRY RUN: would delete ${count} refreshtokenbridges document(s). ` +
        'Nothing deleted.',
    );
    return { deleted: count, dryRun: true };
  }

  const result = await collection.deleteMany({});
  logger.info(
    `[migrate-key-custody] Deleted ${result.deletedCount} refreshtokenbridges document(s).`,
  );
  return { deleted: result.deletedCount, dryRun: false };
}

/**
 * Runs every step of the key custody migration: the read-only steps, the
 * `--reencrypt-totp` write step when requested, the index install, the flight
 * purge, and the bridge purge when `--purge-legacy-bridges` is set.
 *
 * @param {{ dryRun?: boolean, purgeLegacyBridges?: boolean, reencryptTotp?: boolean, batchSize?: number }} [options]
 * @returns {Promise<{ dryRun: boolean, malformedTotpKey: boolean, totpKeySource: string | null, verification: { scanned: number, opened: number, failed: number } | null, reencryption: { reencrypted: number, skipped: number, unopenable: number, refused: boolean } | null, indexes: { installed: string[], dryRun: boolean } | null, flights: { deleted: number, dryRun: boolean } | null, bridges: { deleted: number, dryRun: boolean } | null }>}
 */
async function migrateKeyCustody({
  dryRun = false,
  purgeLegacyBridges = false,
  reencryptTotp = false,
  batchSize = 100,
} = {}) {
  await connect();

  logger.info('[migrate-key-custody] Starting key custody migration', {
    dryRun,
    purgeLegacyBridges,
    reencryptTotp,
    batchSize,
  });

  const results = {
    dryRun,
    malformedTotpKey: false,
    totpKeySource: null,
    verification: null,
    reencryption: null,
    indexes: null,
    flights: null,
    bridges: null,
  };

  // Step 1 — resolve and report the TOTP key.
  const resolved = reportTotpKey();
  results.totpKeySource = resolved.source;
  if (resolved.malformed) {
    // A malformed TOTP_KEY sets a non-zero exit code and runs none of steps 2
    // through 6, with or without --dry-run.
    results.malformedTotpKey = true;
    return results;
  }

  // Step 2 — verify TOTP secrets (read-only).
  results.verification = await verifyTotpSecrets(resolved.key, batchSize);

  // Step 3 — re-encrypt TOTP secrets, only under --reencrypt-totp. Runs after
  // the verify scan; honors --dry-run.
  if (reencryptTotp) {
    results.reencryption = await reencryptTotpSecrets(
      resolved.key,
      resolved.credsKey,
      batchSize,
      dryRun,
    );
  }

  // Step 4 — install the tokencustodies indexes; honors --dry-run.
  results.indexes = await installTokenCustodyIndexes(dryRun);

  // Step 5 — purge openidrefreshflights unconditionally; honors --dry-run.
  results.flights = await purgeOpenIDRefreshFlights(dryRun);

  // Step 6 — purge refreshtokenbridges, only under --purge-legacy-bridges;
  // honors --dry-run.
  if (purgeLegacyBridges) {
    results.bridges = await purgeLegacyRefreshTokenBridges(dryRun);
  }

  logger.info('[migrate-key-custody] Steps complete', {
    dryRun,
    totpKeySource: results.totpKeySource,
    scanned: results.verification.scanned,
    opened: results.verification.opened,
    failed: results.verification.failed,
    reencrypted: results.reencryption ? results.reencryption.reencrypted : null,
    indexesInstalled: results.indexes ? results.indexes.installed.length : null,
    flightsDeleted: results.flights ? results.flights.deleted : null,
    bridgesDeleted: results.bridges ? results.bridges.deleted : null,
  });

  return results;
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const purgeLegacyBridges = process.argv.includes('--purge-legacy-bridges');
  const reencryptTotp = process.argv.includes('--reencrypt-totp');
  const batchSize =
    parseInt(process.argv.find((arg) => arg.startsWith('--batch-size='))?.split('=')[1], 10) || 100;

  migrateKeyCustody({ dryRun, purgeLegacyBridges, reencryptTotp, batchSize })
    .then((result) => {
      console.log(`\n=== ${dryRun ? 'DRY RUN ' : ''}KEY CUSTODY MIGRATION ===`);
      console.log(`TOTP key source: ${result.totpKeySource}`);
      if (result.malformedTotpKey) {
        console.error('TOTP_KEY is malformed; skipped verification. See the log above.');
        process.exitCode = 1;
      } else if (result.verification) {
        const { scanned, opened, failed } = result.verification;
        console.log(`Secrets scanned: ${scanned}`);
        console.log(`Open under the resolved key: ${opened}`);
        console.log(`Do not open: ${failed}`);
        if (result.reencryption) {
          const { reencrypted, skipped, unopenable, refused } = result.reencryption;
          if (refused) {
            console.log('Re-encryption refused: TOTP_KEY resolves to CREDS_KEY (nothing to move).');
          } else {
            console.log(
              `${dryRun ? 'Would re-encrypt' : 'Re-encrypted'} under TOTP_KEY: ${reencrypted}`,
            );
            console.log(`Already under TOTP_KEY (skipped): ${skipped}`);
            console.log(`Open under neither key (left unchanged): ${unopenable}`);
          }
        }
        if (result.indexes) {
          console.log(
            `${dryRun ? 'Would install' : 'Installed'} tokencustodies indexes: ` +
              `${result.indexes.installed.length}`,
          );
        }
        if (result.flights) {
          console.log(
            `${dryRun ? 'Would delete' : 'Deleted'} openidrefreshflights documents: ` +
              `${result.flights.deleted}`,
          );
        }
        if (result.bridges) {
          console.log(
            `${dryRun ? 'Would delete' : 'Deleted'} refreshtokenbridges documents: ` +
              `${result.bridges.deleted}`,
          );
        } else {
          console.log(
            'Legacy bridge purge skipped (pass --purge-legacy-bridges to delete refreshtokenbridges).',
          );
        }
      }
    })
    .catch((error) => {
      console.error('Key custody migration failed:', error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect();
    });
}

module.exports = { migrateKeyCustody };
