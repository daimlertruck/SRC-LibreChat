// suite-parity.filter.mjs — the pure decision logic and constants behind this check's Layer B spec (task 14.6).
//
// The exported deciders and constants this check's spec relies on live here, in a non-spec sibling
// module, so the spec file (suite-parity.spec.mjs) can import them and export NOTHING itself. jest.config.mjs's
// testMatch collects only `*.spec.mjs` / `*.test.mjs`, so a `.filter.mjs` is never collected as a
// test — the same shape boot-nowrite.filter.mjs establishes. This is a move, not a rewrite: the logic
// is identical to what previously lived in the spec, and the spec exercises it via the import.
//
// NG1/NG2 hold: this decides over the harness's own artifacts and touches no application code and
// neither container-split script.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// This file's own directory, resolved from `import.meta.url` — the one shape valid under both `node`
// and the Layer B native-ESM Jest config (jest.config.mjs). `__dirname` does not exist under native
// ESM, so it is deliberately not used. checks/ sits one level below e2e/container-split/, and the
// repository root is three levels above that.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

// The check id this spec decides, named once and prefixed onto the check title so reporter.mjs maps
// the Jest result onto the PARITY-SUITE-31 record.
export const CHECK_ID = 'PARITY-SUITE-31';

// ---------------------------------------------------------------------------------------------
// The committed reference. This is the whole substance of PARITY-SUITE-31: the pointer to the lane
// that decides the existing suite's pass/fail counts, the criterion it runs under, and the invariant
// Req 4.4 turns on. Frozen so a reader cannot mutate it and a change to it is a deliberate edit.
// ---------------------------------------------------------------------------------------------
export const SUITE_PARITY_REFERENCE = Object.freeze({
  // The requirement this record owns.
  requirement: '4.4',

  // The lane whose run IS the existing suite's pass/fail counts. The harness does NOT re-run the
  // suite (that would double the cost to re-derive a result this lane already produces on every pull
  // request — design.md); it records this pointer. `lanePath` is repo-root-relative so the check can
  // confirm the cited workflow actually exists; `laneName` and `jobs` are what a reader looks for in
  // that lane's output.
  laneName: 'Backend Unit Tests',
  lanePath: '.github/workflows/backend-review.yml',
  jobs: Object.freeze([
    'Tests: api (shard N/3)',
    'Tests: @librechat/api (shard N/4)',
    'Tests: data-provider',
    'Tests: data-schemas',
  ]),

  // The criterion Req 4.4 names: the existing suite is run with `DISABLE_STARTUP_TASKS` absent. That
  // is the backend lane's ORDINARY configuration — the gate is a container-split env lever
  // (env-matrix.md), never set in the backend test lane — so the lane's counts are exactly the
  // "DISABLE_STARTUP_TASKS absent" counts Req 4.4 asks about. Recorded so the record states the
  // condition under which the referenced counts hold rather than leaving it implied.
  criterion: 'DISABLE_STARTUP_TASKS absent (the backend lane never sets the gate)',

  // The load-bearing observation: the harness modified ZERO existing test files and ZERO existing
  // assertions, so the existing suite's pass/fail counts are unchanged by construction. Every harness
  // artifact lives under a NEW path; no application source and neither container-split script changed
  // (NG1/NG2). This is WHY the counts match, and committing it here is what makes an edit that touched
  // an existing test have to revisit this record rather than pass silently.
  modifiedExistingTestFiles: 0,
  modifiedExistingAssertions: 0,

  // The new roots the harness added, all additive — the concrete form of "zero existing modified".
  // A reader confirms these are new directories, not edits to existing suites.
  additiveRoots: Object.freeze(['e2e/container-split/', 'api/test/container-split/']),
});

// ---------------------------------------------------------------------------------------------
// Pure decider over the recorded reference — the whole of what this check decides. Returns
// `{ ok, reason? }`; a false carries the observation the check reports (a malformed reference or a
// cited lane that does not resolve is a `fail`, because the recorded reference no longer means what it
// claims). Injectable `repoRoot` and `fileExists` so the decider is unit-exercisable without touching
// the real filesystem.
// ---------------------------------------------------------------------------------------------
export function decideSuiteParityReference(
  reference = SUITE_PARITY_REFERENCE,
  { repoRoot = REPO_ROOT, fileExists = existsSync } = {},
) {
  if (reference === null || typeof reference !== 'object') {
    return { ok: false, reason: `${CHECK_ID}: the suite-parity reference is not an object.` };
  }

  // The requirement this record owns must be 4.4 — the record is Req 4.4's owner in the run summary.
  if (reference.requirement !== '4.4') {
    return {
      ok: false,
      reason:
        `${CHECK_ID}: the reference names requirement ${JSON.stringify(reference.requirement)}, ` +
        'but PARITY-SUITE-31 records Requirement 4.4. The recorded requirement must match the ' +
        'check the catalog carries.',
    };
  }

  // The no-modification invariant is the half Req 4.4 turns on: the counts match BECAUSE the harness
  // touched no existing test. A non-zero count here means the harness edited an existing test file or
  // assertion, so the recorded "same pass/fail counts" no longer holds by construction and the
  // reference must be re-established (by re-running the pre-split suite for a fresh baseline), not
  // silently kept.
  if (reference.modifiedExistingTestFiles !== 0 || reference.modifiedExistingAssertions !== 0) {
    return {
      ok: false,
      reason:
        `${CHECK_ID}: the reference records ${reference.modifiedExistingTestFiles} modified ` +
        `existing test file(s) and ${reference.modifiedExistingAssertions} modified existing ` +
        "assertion(s). Req 4.4 requires ZERO of each — the existing suite's pass/fail counts are " +
        'unchanged only because the harness is additive. A non-zero count means the counts can no ' +
        'longer be carried by reference and the pre-split baseline must be re-established.',
    };
  }

  // The criterion (DISABLE_STARTUP_TASKS absent) must be recorded, so the record states the condition
  // under which the referenced counts hold rather than leaving it implied.
  if (
    typeof reference.criterion !== 'string' ||
    !/DISABLE_STARTUP_TASKS/.test(reference.criterion)
  ) {
    return {
      ok: false,
      reason:
        `${CHECK_ID}: the reference does not record the DISABLE_STARTUP_TASKS-absent criterion Req ` +
        '4.4 names. The record must state the condition under which the referenced counts hold.',
    };
  }

  // The cited lane must actually exist, so the reference resolves rather than pointing at a workflow
  // that was renamed or removed out from under it. A dangling pointer is the failure mode a recorded
  // reference is most prone to; confirming the file exists is what keeps the record honest.
  if (typeof reference.lanePath !== 'string' || reference.lanePath.trim() === '') {
    return {
      ok: false,
      reason: `${CHECK_ID}: the reference records no lane path; there is nothing to resolve.`,
    };
  }
  const laneAbsolute = path.join(repoRoot, reference.lanePath);
  if (!fileExists(laneAbsolute)) {
    return {
      ok: false,
      reason:
        `${CHECK_ID}: the cited backend lane ${JSON.stringify(reference.lanePath)} does not exist ` +
        `at ${laneAbsolute}. The suite-parity reference points at the lane that decides the existing ` +
        "suite's counts; a lane that was renamed or removed makes the reference dangle. Update the " +
        'recorded lanePath to the lane that now runs the existing backend suite.',
    };
  }

  // The additive roots must be recorded and non-empty — they are the concrete form of "zero existing
  // modified", the roots a reader confirms are new rather than edits.
  if (!Array.isArray(reference.additiveRoots) || reference.additiveRoots.length === 0) {
    return {
      ok: false,
      reason:
        `${CHECK_ID}: the reference records no additive roots. The harness's additivity — new roots, ` +
        "no existing test edited — is what makes the existing suite's counts carry by reference.",
    };
  }

  return { ok: true };
}

// A one-line human summary of the recorded reference, written to stderr when the file loads so the
// run's console carries the reference a reader scans. The check record proper stays a clean `pass`
// (the serializer forbids a pass from carrying an observation), so this is where the recorded facts
// surface for a human reading the run output.
export function referenceSummary(reference = SUITE_PARITY_REFERENCE) {
  return (
    `${CHECK_ID} (recorded, Req ${reference.requirement}): existing-suite pass/fail counts carried ` +
    `BY REFERENCE to the "${reference.laneName}" lane (${reference.lanePath}), run with ` +
    `${reference.criterion}. The harness is additive — ${reference.modifiedExistingTestFiles} ` +
    `existing test files and ${reference.modifiedExistingAssertions} existing assertions modified ` +
    `(new roots: ${reference.additiveRoots.join(', ')}) — so the counts are unchanged by ` +
    'construction. This check records the reference and asserts nothing itself.'
  );
}
