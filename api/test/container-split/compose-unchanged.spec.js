const { createHash } = require('crypto');
const { readFileSync } = require('fs');
const path = require('path');

/**
 * Property 4: Single-container parity — the static NG3 guard.
 *
 * NG3 is absolute: the harness introduces a *new* compose file and must never
 * convert either existing single-container setup to an auth-enabled MongoDB.
 * Both `deploy-compose.yml` and `utils/docker/test-compose.yml` run one
 * container against `mongod --noauth`, and Requirements 1.1 and 4.1 require them
 * to stay byte-for-byte unchanged.
 *
 * Nothing else in the harness would catch a quiet edit that swaps `--noauth`
 * for `--auth` on one of these files, so this guard pins their exact content
 * against a recorded SHA-256 digest. It reads the files and hashes them — no
 * fixture, no `mongosh`, no Docker — so it costs nothing, never self-skips, and
 * runs in the backend lane on every pull request rather than in Layer B's
 * path-scoped lane, where it would sit idle for the changes it exists to catch.
 *
 * A legitimate change to either compose file is therefore a deliberate two-line
 * update here — recompute the digest and update the recorded value with the
 * reason — rather than a mystery failure.
 *
 * **Validates: Requirements 1.1, 4.1**
 *
 * Check: COMPOSE-UNCHANGED-12
 */

const repoRoot = path.resolve(__dirname, '..', '..', '..');

/**
 * Recorded SHA-256 digests of the two single-container compose files, computed
 * from their current contents. Each entry pairs the relative path with the
 * reason its content is frozen. To change a compose file deliberately, edit the
 * file, recompute its digest (`shasum -a 256 <file>`), and update `digest` here
 * in the same change so the guard tracks the new intended content.
 */
const GUARDED_COMPOSE_FILES = [
  {
    file: 'deploy-compose.yml',
    // Single-container deployment topology on `mongod --noauth`. NG3/Req 1.1/4.1
    // forbid converting this to an auth-enabled MongoDB or otherwise destabilizing
    // the single-container setup; the harness ships its own compose file instead.
    digest: 'a0cdcf2cd9c3198d6ff47b16867fa4aa64832899333db6bfd6d02d97e286fb7c',
  },
  {
    file: 'utils/docker/test-compose.yml',
    // Single-container test topology on `mongod --noauth`. Same NG3/Req 1.1/4.1
    // freeze: the harness must not repoint this file at an auth-enabled MongoDB.
    digest: 'ea8a92a8fec0af8f4e6b8568d805e49a1a5d4ccda6f0c105a7f70e03e56597dd',
  },
];

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

describe('COMPOSE-UNCHANGED-12: single-container compose files are frozen (NG3)', () => {
  it.each(GUARDED_COMPOSE_FILES)(
    '$file matches its recorded content digest',
    ({ file, digest }) => {
      const contents = readFileSync(path.join(repoRoot, file));
      const actual = sha256(contents);

      // On mismatch, the message points at the deliberate two-line update this
      // guard is designed around rather than leaving a bare hash diff.
      expect({ file, digest: actual }).toEqual({ file, digest });
    },
  );
});
