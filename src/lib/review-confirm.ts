import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ReviewFinding, ReviewFindingStatus } from "./review-artifact.js";

// The confirm step is where "verify, don't trust" becomes mechanical: a finding
// blocks the gate ONLY when the test it names actually goes red. The adversary's
// prose is never trusted — its claim is adjudicated by running the cited test
// through the project's own runner (the sole sanctioned way to execute the
// agent-authored test that demonstrates the bug; nothing else is eval'd). The
// classifier is a pure function of test outcomes, so the verdict carries no model.
//
//   failingTest present + RED   → confirmed  (the bug reproduces → blocking)
//   failingTest present + GREEN → resolved   (not demonstrably present → cleared)
//   failingTest present + can't run → advisory (an unverifiable claim never blocks)
//   no failingTest              → advisory   (a judgment call → user-adjudicated)
//
// A finding that CLAIMS "confirmed"/"resolved" but whose test disagrees is
// overridden by the test — the whole point is that the reproduction decides, not
// the label. Two failure modes the runner must keep distinct (`makeTestRunner`):
// "the test ran and went red" (failed → blocking) versus "the test could not be
// run" (toolchain/resolution error → unrunnable → advisory). Trusting a nonzero
// exit code alone conflates them and false-blocks every finding when the runner
// itself is missing, so a nonzero exit only counts as red with evidence tests
// actually executed. The other side of trust — clearing a red finding by editing
// its named test instead of fixing the code — is closed upstream: the review's
// fingerprint binds each finding's test content (see review-artifact.ts), so
// tampering a test auto-invalidates the review rather than silently clearing it.

export type TestOutcome = "failed" | "passed" | "unrunnable";

export interface TestRunResult {
  outcome: TestOutcome;
  /** Diagnostic for display/audit (exit code, error message). Never a verdict. */
  detail?: string;
}

/** Runs one named test and reports red/green/unrunnable. Injected so the pure
 *  classifier below is testable without spawning a process. */
export type TestRunner = (testRef: string) => TestRunResult;

// Extends ReviewFinding (citation/detail/failingTest/status) so the base shape
// cannot silently drift from it; status here is the post-confirmation value, set
// by the test outcome rather than the claim.
export interface ConfirmedFinding extends ReviewFinding {
  /** What running the test produced; null when there was no test to run. */
  testOutcome: TestOutcome | null;
  /** A short diagnostic when the test could not be run or to explain the outcome. */
  note: string | null;
}

export interface ConfirmResult {
  findings: ConfirmedFinding[];
  /** The confirmed (test-red) findings — the only ones that block the gate. */
  blocking: ConfirmedFinding[];
  hasBlocking: boolean;
}

// Pure classifier: adjudicate each finding by running its named test (via the
// injected runner) and setting status from the outcome. No I/O here.
export function confirmFindings(
  findings: readonly ReviewFinding[],
  run: TestRunner,
): ConfirmResult {
  const confirmed: ConfirmedFinding[] = findings.map((f) => {
    if (!f.failingTest) {
      // No test to run: confirmation cannot create or sustain a block. Preserve a
      // user-set "resolved" (fixed/deferred); anything else is advisory. A
      // "confirmed" with no test is invalid — nothing verifies it — so it
      // downgrades rather than blocking.
      const status: ReviewFindingStatus = f.status === "resolved" ? "resolved" : "advisory";
      return { ...f, status, testOutcome: null, note: null };
    }
    const res = run(f.failingTest);
    if (res.outcome === "failed") {
      return { ...f, status: "confirmed", testOutcome: "failed", note: res.detail ?? null };
    }
    if (res.outcome === "passed") {
      return { ...f, status: "resolved", testOutcome: "passed", note: res.detail ?? null };
    }
    // unrunnable: we cannot verify the claim, so it never blocks — surfaced as
    // advisory with the reason, so a broken test reference is visible.
    return {
      ...f,
      status: "advisory",
      testOutcome: "unrunnable",
      note: res.detail ?? "named test could not be run",
    };
  });
  const blocking = confirmed.filter((f) => f.status === "confirmed");
  return { findings: confirmed, blocking, hasBlocking: blocking.length > 0 };
}

export interface TestRunnerOptions {
  root: string;
  /** Command argv to run a single test file; the literal `{file}` token is
   *  replaced with the resolved test path. Defaults to node:test via tsx, which
   *  is codument's own convention; a consumer project overrides it. */
  command?: readonly string[];
  /** Per-test timeout (ms). A timeout counts as unrunnable, never as a pass. */
  timeoutMs?: number;
  /** Directories to resolve a bare test name against (default repo root + tests). */
  searchDirs?: readonly string[];
}

export const DEFAULT_TEST_COMMAND: readonly string[] = ["npx", "tsx", "--test", "{file}"];

// Where a bare test name is resolved (repo root, then `tests/`). Shared so the
// gate's fingerprint resolver and the runner look in the same places.
export const DEFAULT_TEST_SEARCH_DIRS: readonly string[] = ["", "tests"];

// Resolve a test reference (a bare name like `foo.test.ts` or a repo-relative
// path) to an existing file under one of the search dirs, or null if none exists.
export function resolveTestPath(
  root: string,
  testRef: string,
  searchDirs: readonly string[],
): string | null {
  const rootAbs = resolve(root);
  // Canonicalize the root once so the symlink re-check compares realpaths.
  let rootReal: string;
  try {
    rootReal = realpathSync(rootAbs);
  } catch {
    rootReal = rootAbs;
  }
  for (const dir of searchDirs) {
    const candidate = dir ? join(root, dir, testRef) : join(root, testRef);
    // Reject a reference that escapes the repo — we are about to spawn the project
    // runner on this path. The lexical check catches a `../../` testRef; the
    // realpath re-check below catches a SYMLINK under root whose target leaves the
    // tree (path.resolve never follows links), so a symlinked test cannot run
    // out-of-tree code.
    const candidateAbs = resolve(candidate);
    if (candidateAbs !== rootAbs && !candidateAbs.startsWith(rootAbs + sep)) continue;
    if (!existsSync(candidate)) continue;
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      continue; // dangling symlink / race → treat as not found
    }
    if (real !== rootReal && !real.startsWith(rootReal + sep)) continue;
    return candidate;
  }
  return null;
}

// The real runner: resolve the test file, run it through the configured command,
// and map the result. A missing file, a spawn error, or a kill/timeout is
// `unrunnable` (never a pass); exit 0 is `passed`; any nonzero exit is `failed`.
export function makeTestRunner(opts: TestRunnerOptions): TestRunner {
  const command = opts.command ?? DEFAULT_TEST_COMMAND;
  const searchDirs = opts.searchDirs ?? DEFAULT_TEST_SEARCH_DIRS;
  const timeout = opts.timeoutMs ?? 120_000;
  return (testRef: string): TestRunResult => {
    const resolved = resolveTestPath(opts.root, testRef, searchDirs);
    if (!resolved) return { outcome: "unrunnable", detail: `test not found: ${testRef}` };
    const argv = command.map((a) => (a === "{file}" ? resolved : a));
    const [cmd, ...args] = argv;
    const res = spawnSync(cmd, args, { cwd: opts.root, timeout, encoding: "utf8" });
    if (res.error) {
      return { outcome: "unrunnable", detail: String(res.error.message ?? res.error) };
    }
    if (res.signal) {
      return { outcome: "unrunnable", detail: `test killed by signal ${res.signal}` };
    }
    if (res.status === null) {
      // Indeterminate: killed without a signal we caught, or no exit code. We
      // cannot conclude failure OR success, so it is unrunnable — consistent with
      // every other unverifiable outcome, never read as a definitive verdict.
      return { outcome: "unrunnable", detail: "test exited without a status code" };
    }
    if (res.status === 0) return { outcome: "passed" };
    // Nonzero exit: distinguish a real test failure from a TOOLCHAIN failure
    // (missing runner, module resolution, npx auto-install error, bad tsconfig).
    // Trusting the exit code alone reads "could not run the test" as "test red" and
    // FALSE-BLOCKS every finding when the runner itself is unavailable. A genuine
    // run emits TAP (node:test, tsx, vitest, jest all do); a toolchain error exits
    // nonzero with no test results. So a nonzero exit counts as `failed` only with
    // evidence tests actually executed; otherwise it is unrunnable (never a block).
    // The residual trust limit is now one-directional and named: a runner that
    // exits 0 AND prints TAP without truly executing the file would still read as
    // passed — accepting a fabricated pass is the soak/audit limit, not a false block.
    const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
    const ranTests = /^(?:TAP version|ok\b|not ok\b|# tests\b|# pass\b|# fail\b|# Subtest)/m.test(out);
    if (!ranTests) {
      return {
        outcome: "unrunnable",
        detail: `runner exited ${res.status} without producing test results (toolchain error?)`,
      };
    }
    return { outcome: "failed", detail: `exit ${res.status}` };
  };
}
