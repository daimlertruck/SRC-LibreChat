// checks/suite-parity.spec.mjs — PARITY-SUITE-31, the existing-suite parity RECORD (task 12.3).
//
// Property 4, single-container parity (parent P12, Req 4.4). Requirement 4.4 asks that, run with
// `DISABLE_STARTUP_TASKS` absent, the existing automated test suite finish with the SAME count of
// passing and failing tests it produces against the pre-split image, having modified ZERO existing
// test files and ZERO existing assertions.
//
// == This check RECORDS a reference; it does not re-run the suite ==
// Unlike every sibling check, PARITY-SUITE-31 is `layer: 'recorded'` in the Check Catalog
// (check-catalog.mjs) — it is decided OUTSIDE the harness and recorded BY REFERENCE here. The design
// is explicit (design.md: "`PARITY-SUITE-31` is decided outside the harness. Re-running the backend
// suite inside a topology run would double the cost to re-derive a result the backend lane already
// produces on every pull request, so the harness records the reference and the observation and
// asserts nothing itself. Recording it is what keeps Requirement 4.4 visible in the run summary
// instead of unowned.").
//
// So this spec:
//
//   1. RECORDS the reference — the backend lane that runs the existing suite, the criterion under
//      which it runs it (`DISABLE_STARTUP_TASKS` absent — the backend lane's ordinary configuration,
//      which never sets the gate), and where the pass/fail counts the lane produces are read from —
//      as a single committed constant (SUITE_PARITY_REFERENCE below). The count itself is not a number
//      transcribed here (a transcribed count would rot the moment the suite grows a test); it is a
//      pointer to the lane whose run IS the count, plus the invariant Req 4.4 turns on: the two counts
//      MATCH because the harness added zero changes to any existing test.
//
//   2. RECORDS the observation that zero existing test files and zero existing assertions were
//      modified — the load-bearing half of Req 4.4. The harness is entirely additive: every artifact
//      it introduces lives under NEW paths (e2e/container-split/, api/test/container-split/), it
//      changes no application source (NG1) and neither container-split script (NG2), so no existing
//      test's file or assertion moved. That additivity is WHY the existing suite's count is unchanged,
//      and it is the thing this record commits to so a future edit that touched an existing test would
//      have to update this record deliberately rather than pass silently.
//
//   3. ASSERTS NOTHING about a local execution. The single `[PARITY-SUITE-31]` check does not run the
//      backend suite, spawn Jest, or reach any topology. Its `pass` means "the reference is recorded
//      and internally well-formed" — the check record's `status` reflects the RECORDED REFERENCE
//      rather than a local run (tasks.md 12.3: "the check record's `status` reflects the recorded
//      reference rather than a local execution"). This is what keeps Req 4.4 owned in the run summary
//      without paying to re-derive a result the backend lane already produces.
//
// == Why a pass carries no observation, and where the recorded facts live ==
// The serializer forbids a `pass` record from carrying an observation (serializer.mjs: "a pass is
// decided by the check id and its property, not by prose") — a `pass` is the correct status here
// because the reference IS recorded and well-formed, and the recorded facts (the lane, the criterion,
// the no-modification observation) live in the committed SUITE_PARITY_REFERENCE constant and are
// written to process.stderr when the file loads, so the run's console carries the reference a reader
// scans even though the check record proper stays a clean pass. A run in which the reference were
// malformed or its cited lane file were absent would `fail` with that as the observation — the record
// then carries prose, as a fail must.
//
// == The check-record tag convention ==
// The single check's title STARTS with `[PARITY-SUITE-31]`, which reporter.mjs parses to map the Jest
// result onto the check record (check-catalog.mjs owns id → {layer, requirements, property}:
// PARITY-SUITE-31 → layer 'recorded', Req 4.4, property P12).
//
// == No live gate, no self-skip ==
// This check reads only committed repository files (the cited lane workflow) and a committed constant.
// It needs no topology and no mongosh, so it neither gates on HARNESS_LIVE nor self-skips — it decides
// the same way on every run, in the backend lane and under the Layer B runner alike. That is what a
// `recorded` check is: a reference the run report carries, checked for well-formedness, not a live
// observation.
//
// NG1/NG2 hold: this records a reference to an existing CI lane and reads a committed workflow file to
// confirm the reference resolves. It adds no application code, no route mount and no HTTP path (NG1),
// and edits neither container-split script (NG2). NG6 holds: no credential validation happens here.

// The exported constants and pure deciders live in suite-parity.filter.mjs (a non-spec sibling) so this
// spec file exports nothing (task 14.6). The spec imports what its checks exercise.
import {
  CHECK_ID,
  SUITE_PARITY_REFERENCE,
  decideSuiteParityReference,
  referenceSummary,
} from './suite-parity.filter.mjs';

// Write the recorded reference to stderr at load time. Written straight to process.stderr, not
// console.warn: Jest's default reporter discards the console buffer of a file, and this reference is
// the record's substance — it must reach the run output regardless of the reporter's buffering, the
// same discipline the sibling self-skipping specs use for their skip reason.
process.stderr.write(`[container-split] ${referenceSummary()}\n`);

// ---------------------------------------------------------------------------------------------
// The check. A single `[PARITY-SUITE-31]` test that decides the recorded reference is well-formed and
// resolves — it runs the existing suite NOWHERE, reaches no topology, and reflects the RECORDED
// REFERENCE rather than a local execution (tasks.md 12.3). Its title starts with the catalog id so
// reporter.mjs maps the result onto the check record.
// ---------------------------------------------------------------------------------------------
describe(`${CHECK_ID}: the existing-suite parity result is recorded by reference`, () => {
  test(`[${CHECK_ID}] the existing-suite parity reference is recorded, additive, and resolves to the backend lane`, () => {
    const decision = decideSuiteParityReference();
    expect(decision.ok ? '' : decision.reason).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------
// Static unit exercises for the pure decider — they run NOW (no topology, no gate), so the
// recorded-reference logic is exercised on every run. Each asserts both a pass and a fail so no
// branch is vacuous (Property 6: no check passes vacuously). The cited lane's existence is stubbed
// through the injectable `fileExists` so the exercises do not depend on the real workflow file being
// present in the unit's view.
// ---------------------------------------------------------------------------------------------
describe(`${CHECK_ID}: pure decider unit exercises`, () => {
  const present = () => true;
  const absent = () => false;

  test('the committed reference is well-formed and resolves', () => {
    // Against the real repo root and the real filesystem: the cited lane workflow exists in-tree.
    expect(decideSuiteParityReference().ok).toBe(true);
    // And explicitly with a stubbed present filesystem, so the exercise does not depend on cwd.
    expect(decideSuiteParityReference(SUITE_PARITY_REFERENCE, { fileExists: present }).ok).toBe(
      true,
    );
  });

  test('a non-zero modified-existing-test count fails — the counts can no longer carry by reference', () => {
    const edited = { ...SUITE_PARITY_REFERENCE, modifiedExistingTestFiles: 1 };
    const decision = decideSuiteParityReference(edited, { fileExists: present });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain('modified');
  });

  test('a non-zero modified-assertion count fails for the same reason', () => {
    const edited = { ...SUITE_PARITY_REFERENCE, modifiedExistingAssertions: 3 };
    expect(decideSuiteParityReference(edited, { fileExists: present }).ok).toBe(false);
  });

  test('a wrong requirement fails — the record owns Req 4.4', () => {
    const wrongReq = { ...SUITE_PARITY_REFERENCE, requirement: '4.3' };
    expect(decideSuiteParityReference(wrongReq, { fileExists: present }).ok).toBe(false);
  });

  test('a missing DISABLE_STARTUP_TASKS criterion fails — the condition must be recorded', () => {
    const noCriterion = { ...SUITE_PARITY_REFERENCE, criterion: 'some other condition' };
    expect(decideSuiteParityReference(noCriterion, { fileExists: present }).ok).toBe(false);
  });

  test('a dangling lane pointer fails — the reference must resolve', () => {
    // The reference is well-formed but the cited lane file is absent (renamed or removed).
    const decision = decideSuiteParityReference(SUITE_PARITY_REFERENCE, { fileExists: absent });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain(SUITE_PARITY_REFERENCE.lanePath);
  });

  test('an empty additive-roots list fails — additivity is what makes the counts carry', () => {
    const noRoots = { ...SUITE_PARITY_REFERENCE, additiveRoots: [] };
    expect(decideSuiteParityReference(noRoots, { fileExists: present }).ok).toBe(false);
  });

  test('a non-object reference fails rather than throwing', () => {
    expect(decideSuiteParityReference(null, { fileExists: present }).ok).toBe(false);
  });

  test('referenceSummary names the lane, the criterion, and the additive counts', () => {
    const summary = referenceSummary();
    expect(summary).toContain('BY REFERENCE');
    expect(summary).toContain(SUITE_PARITY_REFERENCE.laneName);
    expect(summary).toContain('DISABLE_STARTUP_TASKS');
    expect(summary).toContain('asserts nothing');
  });
});
