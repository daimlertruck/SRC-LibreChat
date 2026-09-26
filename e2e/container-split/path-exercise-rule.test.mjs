// path-exercise-rule.test.mjs — unit tests for the two decisions the path-exercise rule gets wrong
// most expensively: a 5xx reported under the wrong label, and a request that queried nothing reported
// as grant sufficiency.
//
// These guard the defect class task 11.1 was reopened for. The implementation that shipped before it
// failed `PATH-EXERCISE-25` on a 5xx over a clean window and attributed the failure to the ownership
// matrix, emitting the grant-recompute guidance — a claim about the Container_1_Grant drawn from a
// status code, for a path that refused nothing. The failure was real and the LABEL on it was wrong, so
// a test that asked only "does the check go red" would have passed against it. The assertions below
// therefore read the outcome label and the guidance, not the verdict:
//
//   * a 5xx over a clean window is `uncorroborated`, never `understated` and never `pass`, and the
//     recompute guidance is WITHHELD (criteria 3.12, 3.13 — the guidance is confined to an exercise
//     whose `Exercise_Log_Window` records an Authorization_Error, and this window records none);
//   * a session-gated path exercised with no `Session_Fixture` attached is a FIXTURE FAILURE and never
//     a pass (Req 3.22, Property 6), because the gate's 401 over a clean window is indistinguishable,
//     on the three observations criterion 3.13 names, from a grant that really was sufficient.
//
// Everything here drives the REAL rule — `classifyExercise`, `decideSessionAttachment` and the
// `summarizePathExercise` fold — over the real recorded fixtures, so a test cannot agree with a
// paraphrase of the rule while the rule itself drifts.
//
// The titles carry NO bracketed check id deliberately: these are unit tests of a decider, not
// observations of `PATH-EXERCISE-25` against a live topology, and a tagged title would have the
// reporter mint a check record for a run that brought nothing up.
//
// This is native-ESM Jest under e2e/container-split/jest.config.mjs (matched by its `**/*.test.mjs`
// pattern). It touches no application code and no container-split script (NG1/NG2), and needs no
// Docker.

import {
  AUTH_SURFACE_UPSTREAM,
  EXERCISE_FAILURE,
  carriesRecomputeGuidance,
  classifyExercise,
  recomputeGuidance,
  summarizePathExercise,
} from './checks/path-exercise.filter.mjs';
import { SESSION_GATED_PATHS, payloadFor } from './checks/path-exercise.payloads.mjs';
import { decideSessionAttachment } from './checks/path-exercise.session.mjs';
import { PATH_OUTCOME } from './path-outcomes.mjs';

// The path whose recorded payload answers 400 through a validation branch and whose EMPTY-BODY request
// answers 500 out of the same controller's `catch` — a server error over a window that stays clean,
// because the throw happens on absent input before any collection is queried.
const SERVER_ERROR_PATH = '/api/user/verify';

// A path that really sits behind `requireJwtAuth`. With the fixture attached its handler reads the
// Seeded_Account and writes a pending TOTP secret back (real read-and-write reach into the
// Container_1_Grant); with the fixture withheld the gate answers 401 ahead of the handler and nothing
// is queried at all.
const GATED_PATH = '/api/auth/2fa/enable';

// ---------------------------------------------------------------------------------------------
// The three inputs, built by the real rule. `summarizePathExercise` is what `PATH-EXERCISE-25` calls
// and its `{ pathOutcomes, failures, verdict }` is what the check reports, so the folds below are the
// check's own output with no translation layer in between.
// ---------------------------------------------------------------------------------------------

// One clean pass on an unrelated path, so a fold is a whole run's worth rather than a single entry. It
// also keeps the folds honest about the rule's run-level clause: a report with no `pass` at all fails
// for a different reason ("no exercise passed").
function cleanPassOnAnotherPath(pathText = '/api/config', surface = 'config') {
  return classifyExercise({
    observation: {
      path: pathText,
      surface,
      attributedTo: AUTH_SURFACE_UPSTREAM,
      httpStatus: 200,
      windowScanned: true,
      windowClean: true,
      authorizationError: null,
      transportError: null,
      scanError: null,
    },
  });
}

// A 5xx whose `Exercise_Log_Window` is clean: the controller threw on absent input, so nothing was
// queried and the window records no Authorization_Error.
function serverErrorOverCleanWindow() {
  return classifyExercise({
    observation: {
      path: SERVER_ERROR_PATH,
      surface: 'email verification',
      attributedTo: AUTH_SURFACE_UPSTREAM,
      httpStatus: 500,
      windowScanned: true,
      windowClean: true,
      authorizationError: null,
      transportError: null,
      scanError: null,
    },
  });
}

// The gated mount refusing an anonymous request at 401 over a clean window, with the REAL
// `decideSessionAttachment` producing the Req 3.22 fixture signal from the recorded payload entry.
// `withFixtureGuard: false` drops that signal and nothing else — the same three observations with no
// guard, which is exactly what the vacuous pass looks like.
function gatedPathWithNoFixture({ withFixtureGuard = true } = {}) {
  const entry = payloadFor(GATED_PATH);
  const { fixtureFailure } = decideSessionAttachment({ entry, fixture: null });
  return classifyExercise({
    observation: {
      path: GATED_PATH,
      surface: '2FA enroll',
      attributedTo: AUTH_SURFACE_UPSTREAM,
      httpStatus: 401,
      windowScanned: true,
      windowClean: true,
      authorizationError: null,
      transportError: null,
      scanError: null,
    },
    fixtureFailure: withFixtureGuard ? fixtureFailure : null,
  });
}

// The gated path reached by an exercise the proxy attributed elsewhere — a failed PRECONDITION that is
// not the fixture guard, so it must not be reported as one.
function gatedPathNotAttributedToAuthSurface() {
  return classifyExercise({
    observation: {
      path: GATED_PATH,
      surface: '2FA enroll',
      attributedTo: null,
      httpStatus: 401,
      windowScanned: true,
      windowClean: true,
      authorizationError: null,
      transportError: null,
      scanError: null,
    },
  });
}

describe('the inputs these tests build are the real recorded fixtures', () => {
  // Both assertions keep the tests below from going vacuous. A path that stopped being gated would make
  // the 401 an ordinary refusal rather than the one indistinguishable from a pass, and a payload whose
  // well-formed answer was already a 5xx would make the empty-body 500 the status quo.
  it('the gated path is one the payload table records as session-gated', () => {
    expect(SESSION_GATED_PATHS).toContain(GATED_PATH);
  });

  it('the server-error path has a recorded payload whose well-formed answer is a 400', () => {
    const entry = payloadFor(SERVER_ERROR_PATH);
    expect(entry).not.toBeNull();
    expect(entry.expectedStatus).toBe(400);
  });
});

describe('a 5xx over a clean window is `uncorroborated`, not `understated`', () => {
  it('labels the path `uncorroborated` and turns the run red', () => {
    const report = summarizePathExercise([cleanPassOnAnotherPath(), serverErrorOverCleanWindow()]);
    expect(report.verdict).toBe('fail');
    const entry = report.pathOutcomes.find((o) => o.path === SERVER_ERROR_PATH);
    expect(entry.outcome).toBe(PATH_OUTCOME.UNCORROBORATED);
    // The two labels the earlier implementation could have reached instead: a grant conclusion drawn
    // from a status code, and a check that cannot see a 5xx at all.
    expect(entry.outcome).not.toBe(PATH_OUTCOME.UNDERSTATED);
    expect(entry.outcome).not.toBe(PATH_OUTCOME.PASS);
  });

  it('withholds the grant-recompute guidance, because nothing was refused', () => {
    const { outcome } = serverErrorOverCleanWindow();
    expect(outcome.outcome).toBe(PATH_OUTCOME.UNCORROBORATED);
    expect(carriesRecomputeGuidance(outcome.reason)).toBe(false);
    // The reason still SAYS the guidance is withheld; that sentence must not read as the guidance.
    expect(outcome.reason).toMatch(/withheld/);
  });
});

describe('carriesRecomputeGuidance — pinned against the real guidance producer', () => {
  // Pinned in BOTH directions. A matcher that stopped matching the real guidance would report every
  // reason as guidance-free, which is how the assertion above goes quietly blind.
  it('matches the guidance `recomputeGuidance` emits, with and without a matched line', () => {
    expect(
      carriesRecomputeGuidance(
        recomputeGuidance('email verification', SERVER_ERROR_PATH, {
          matchedLine: 'not authorized on LibreChat to execute command { find: { find: "keys" } }',
          collection: 'keys',
        }),
      ),
    ).toBe(true);
    expect(carriesRecomputeGuidance(recomputeGuidance('config', '/api/config'))).toBe(true);
  });

  it('does not match a fixture failure, and is null-safe for a `pass` with no reason', () => {
    const { failure } = gatedPathWithNoFixture();
    expect(carriesRecomputeGuidance(failure.reason)).toBe(false);
    expect(carriesRecomputeGuidance(null)).toBe(false);
    expect(carriesRecomputeGuidance('')).toBe(false);
  });
});

describe('a session-gated path with no fixture is a fixture failure, never a pass', () => {
  it('reports it as a FIXTURE FAILURE rather than as any outcome at all', () => {
    const { outcome, failure } = gatedPathWithNoFixture();
    expect(outcome).toBeNull();
    expect(failure.kind).toBe(EXERCISE_FAILURE.FIXTURE);
    expect(failure.path).toBe(GATED_PATH);
    // No recompute guidance either — the exercise refused nothing, it never ran.
    expect(carriesRecomputeGuidance(failure.reason)).toBe(false);
  });

  it('surfaces in the fold as a failure and never as a per-path outcome', () => {
    const report = summarizePathExercise([cleanPassOnAnotherPath(), gatedPathWithNoFixture()]);
    expect(report.pathOutcomes.find((o) => o.path === GATED_PATH)).toBeUndefined();
    expect(report.failures.find((f) => f.path === GATED_PATH).kind).toBe(EXERCISE_FAILURE.FIXTURE);
  });

  it('the guard is the ONLY thing separating it from a pass', () => {
    // Drop the guard and the same 401 over the same clean window is labelled `pass` — the three
    // observations criterion 3.13 names, satisfied by a request that queried nothing. This is the
    // vacuous pass, and it is why the guard is not an optional refinement of the rule.
    const withoutGuard = summarizePathExercise([
      cleanPassOnAnotherPath(),
      gatedPathWithNoFixture({ withFixtureGuard: false }),
    ]);
    expect(withoutGuard.pathOutcomes.find((o) => o.path === GATED_PATH).outcome).toBe(
      PATH_OUTCOME.PASS,
    );
  });

  it('an exercise attributed elsewhere is an ATTRIBUTION failure, not a fixture one', () => {
    // Also "no outcome", and a different failed precondition: the exercise never reached the
    // Auth_Surface, so the fixture guard was never what decided. Collapsing the two would let an
    // allowlist drift read as a withheld session.
    const report = summarizePathExercise([
      cleanPassOnAnotherPath(),
      gatedPathNotAttributedToAuthSurface(),
    ]);
    expect(report.failures.find((f) => f.path === GATED_PATH).kind).toBe(
      EXERCISE_FAILURE.ATTRIBUTION,
    );
  });
});
