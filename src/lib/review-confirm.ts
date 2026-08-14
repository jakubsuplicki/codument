import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { readMetaSync } from "./codemod.js";
import type { ReviewFinding, ReviewFindingStatus } from "./review-artifact.js";

// ── win32-safe spawning ──────────────────────────────────────────────────
// Since Node's CVE-2024-27980 hardening (18.20/20.12), spawning a `.cmd` shim
// (npx/npm/vitest on Windows) without a shell throws EINVAL. Every such spawn
// error reads as unrunnable → advisory, which made the confirm gate
// STRUCTURALLY always-green on Windows. On win32 the argv is joined into one
// cmd.exe-quoted command line and run with `shell: true`; on POSIX the spawn is
// byte-identical to before (no shell, argv passed as-is).

/** The cmd.exe-quoted command line for `argv` — exported so the construction is
 *  unit-testable on any platform. An arg containing whitespace or cmd
 *  metacharacters is double-quoted with embedded quotes doubled (cmd.exe's
 *  quote escape). Boundary: cmd.exe has no perfect escape for every sequence
 *  (notably `%VAR%` expansion inside quotes); test-file paths and flags — the
 *  args this runner passes — are covered. */
export function winCommandLine(argv: readonly string[]): string {
  const quote = (a: string): string =>
    a.length === 0 || /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
  return argv.map(quote).join(" ");
}

/** spawnSync an argv, shell-safely on win32 and byte-identically on POSIX. */
export function spawnArgvSync(
  argv: readonly string[],
  opts: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
  if (process.platform === "win32") {
    return spawnSync(winCommandLine(argv), { ...opts, shell: true });
  }
  const [cmd, ...args] = argv;
  return spawnSync(cmd, args, opts);
}

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

/**
 * Why a run could not be adjudicated, when that reason has its OWN remedy.
 *
 * Only a timeout does today, and it is the one that matters most: every other
 * unrunnable cause is a fact about the project's toolchain, but an expired budget is
 * codument's own clock running out on a runner that was working perfectly. Collapsing
 * it into the same bucket sent the reader to fix a test command that was never wrong.
 */
export type TestRunCause = "timeout";

export interface TestRunResult {
  outcome: TestOutcome;
  /** Diagnostic for display/audit (exit code, error message). Never a verdict. */
  detail?: string;
  /** Set when the reason needs a different remedy from the rest of `unrunnable`. */
  cause?: TestRunCause;
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
  /** Why, when the reason carries its own remedy (a timeout). Null otherwise. */
  testCause: TestRunCause | null;
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
      return { ...f, status, testOutcome: null, testCause: null, note: null };
    }
    const res = run(f.failingTest);
    const cause = res.cause ?? null;
    if (res.outcome === "failed") {
      return {
        ...f,
        status: "confirmed",
        testOutcome: "failed",
        testCause: cause,
        note: res.detail ?? null,
      };
    }
    if (res.outcome === "passed") {
      return {
        ...f,
        status: "resolved",
        testOutcome: "passed",
        testCause: cause,
        note: res.detail ?? null,
      };
    }
    // unrunnable: we cannot verify the claim, so it never blocks — surfaced as
    // advisory with the reason, so a broken test reference is visible. The cause
    // rides along because an expired budget and a broken toolchain need different
    // advice, and one bucket cannot give both.
    return {
      ...f,
      status: "advisory",
      testOutcome: "unrunnable",
      testCause: cause,
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
  /** Per-test budget (ms). A timeout counts as unrunnable, never as a pass. Omitted
   *  means the project's own declared budget, resolved inside `makeTestRunner` — a
   *  caller that leaves it out must not silently get codument's default. */
  timeoutMs?: number;
  /** Directories to resolve a bare test name against (default repo root + tests). */
  searchDirs?: readonly string[];
}

// `--no-install` makes the default resolution LOCAL-ONLY: the verdict path must
// never fetch and execute unpinned third-party code from the network (nor hang on
// npx's install prompt in CI). When the project has no local tsx the confirm step
// cannot run — a NAMED condition the review summary renders (see
// `defaultCommandAvailable`), never a silent always-green.
export const DEFAULT_TEST_COMMAND: readonly string[] = [
  "npx",
  "--no-install",
  "tsx",
  "--test",
  "{file}",
];

/** True when the DEFAULT command's runner is resolvable WITHOUT a network fetch —
 *  the same question `npx --no-install tsx` answers. Fast path: the project's own
 *  `node_modules/.bin`. Slow path (only on a local miss, one bounded spawn): ask
 *  npx itself, which also sees hoisted and globally-installed runners, so the
 *  named condition never cries wolf on a project where the confirm step actually
 *  works. False means the confirm step cannot run here with the default command —
 *  the caller surfaces that as a named condition ("pass --test-command"), never a
 *  silent advisory. Only meaningful for the default; a custom command is the
 *  project's own contract. */
export function defaultCommandAvailable(root: string): boolean {
  const local = ["tsx", "tsx.cmd", "tsx.ps1"].some((name) =>
    existsSync(join(root, "node_modules", ".bin", name)),
  );
  if (local) return true;
  const probe = spawnArgvSync(["npx", "--no-install", "tsx", "--version"], {
    cwd: root,
    timeout: 15_000,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
  });
  return !probe.error && probe.status === 0;
}

// Where a bare test name is resolved (repo root, then `tests/`). Shared so the
// gate's fingerprint resolver and the runner look in the same places.
export const DEFAULT_TEST_SEARCH_DIRS: readonly string[] = ["", "tests"];

/** Argv for a command given either as real argv or as one whitespace-joined string
 *  (`--test-command "vitest run {file}"`, or the `testCommand` config value). An
 *  empty/blank command normalizes to undefined — "not specified", never an empty
 *  argv the spawn would choke on. */
export function normalizeTestCommand(command?: readonly string[]): string[] | undefined {
  if (!command || command.length === 0) return undefined;
  if (command.length === 1 && /\s/.test(command[0])) {
    const parts = command[0].trim().split(/\s+/);
    return parts.length > 0 && parts[0] !== "" ? parts : undefined;
  }
  return [...command];
}

/**
 * The one place the "could not run" condition is worded, for every surface that
 * runs tests.
 *
 * Several things can go wrong independently — a declared runner refused, a declared
 * budget refused, claims that ran out of that budget, claims the runner could not
 * decide — and some are usually the SAME incident: a slotless `testCommand` falls back
 * to the default, the default cannot emit evidence, and every claim reads unrunnable.
 * Reporting only the count would name the symptom and drop the cause ("point your
 * runner at TAP" is bad advice when the declared runner was fine and only the `{file}`
 * slot was missing), so every cause present is said.
 *
 * **Each cause carries its own remedy, and only the remedies that apply are offered.**
 * One route stapled to the end of every cause is how this line came to tell a reader
 * whose test command was perfect to go and fix their test command: their tests had
 * simply run out of codument's clock, which is not a fact about their project at all.
 * A route offered where nothing it names can work is the failure the change-control
 * gate spent a release removing ([020](../../docs/architecture/decisions/020-a-block-must-be-provable.md));
 * this is the same rule, in the other gate.
 *
 * Building the line here rather than at each call site is the other half: two consumers
 * of one runner must not be able to describe one toolchain gap differently.
 */
type Remedy = "runner" | "budget";

const REMEDIES: Record<Remedy, string> = {
  runner: 'set testCommand in .codument-meta.json, or pass --test-command "<your runner> {file}"',
  budget: "raise the budget with --test-timeout <seconds>, or set testTimeoutSeconds in .codument-meta.json",
};

export function confirmCondition(input: {
  /** A refused `testCommand` declaration, if any. */
  commandProblem: string | null;
  /** A refused `testTimeoutSeconds` declaration, if any. Named separately from the
   *  command's because the two route to different remedies, and a project can get
   *  both wrong at once. */
  timeoutProblem: string | null;
  /** How many claims the runner could not decide, for any reason. */
  unadjudicated: number;
  /** How many of `unadjudicated` ran out of the budget rather than failing at the
   *  toolchain — the ones whose remedy is the clock, not the command. */
  timedOut: number;
  /** The budget that expired, so the reader knows the number they are raising. */
  budgetMs: number;
  /** What went unjudged, singular: "finding" or "invariant". */
  noun: string;
  /** What that costs the reader, verb-free so it reads in both numbers:
   *  "advisory rather than judged", "excluded from the score". */
  consequence: string;
  /** True when the BUILT-IN default is in play and cannot resolve locally. */
  defaultUnavailable: boolean;
}): string | null {
  const causes: { text: string; remedy: Remedy }[] = [];
  const count = (n: number) => `${n} ${input.noun}${n === 1 ? "" : "s"}`;
  const reads = (n: number) => (n === 1 ? "it reads " : "they read ");

  if (input.commandProblem) causes.push({ text: input.commandProblem, remedy: "runner" });
  if (input.timeoutProblem) causes.push({ text: input.timeoutProblem, remedy: "budget" });

  // Split by cause, never by total: the two halves need opposite advice, and a reader
  // handed the wrong one composes a fix that cannot work.
  const timedOut = Math.min(input.timedOut, input.unadjudicated);
  if (timedOut > 0) {
    causes.push({
      text: `${count(timedOut)} ran out of the ${Math.round(input.budgetMs / 1000)}s budget before the test finished, so ${reads(timedOut)}${input.consequence}`,
      remedy: "budget",
    });
  }
  const noEvidence = input.unadjudicated - timedOut;
  if (noEvidence > 0) {
    causes.push({
      text: `${count(noEvidence)} could not be adjudicated: the runner produced no test evidence, so ${reads(noEvidence)}${input.consequence}`,
      remedy: "runner",
    });
  }
  // Only when nothing else already explains it: a project that declared a runner is
  // judged by the outcomes above, never by a probe of codument's own default.
  if (causes.length === 0 && input.defaultUnavailable) {
    causes.push({
      text: "confirm step could not run: no local tsx (the default runner resolves local-only, never the network)",
      remedy: "runner",
    });
  }
  if (causes.length === 0) return null;
  // Deduped in the order the causes raised them, so the first remedy answers the first
  // thing the reader is told.
  const routes = [...new Set(causes.map((c) => c.remedy))].map((r) => REMEDIES[r]);
  return `${causes.map((c) => c.text).join("; ")} — ${routes.join("; or ")}`;
}

export interface ResolvedTestCommand {
  /** The argv to run, or undefined for the built-in default. */
  command: string[] | undefined;
  /** Set when a DECLARED command was refused and the default used instead. The
   *  caller must surface it: silently ignoring a project's declared runner is the
   *  same silent-wrong-thing the config exists to prevent. */
  problem: string | null;
}

/**
 * How to run one test file, resolved once for every consumer.
 *
 * Precedence: `--test-command` flag > `testCommand` in `.codument-meta.json` >
 * the built-in local-only default. The config tier exists because a project's test
 * runner is a fact about the project — re-typing it on every `--require-review` run
 * is how the "could not run" warning became background noise.
 *
 * A declared command without the literal `{file}` token is REFUSED, not silently
 * accepted: it would run the whole suite once per finding, which reads as a working
 * gate while adjudicating nothing. Refusal falls back to the default and reports the
 * problem — it does not throw, because `readMetaSync` runs on nearly every command
 * path and a typo here must not break `scan` or `doctor`.
 */
export function resolveTestCommand(root: string, flag?: readonly string[]): ResolvedTestCommand {
  const fromFlag = normalizeTestCommand(flag);
  if (fromFlag) return { command: fromFlag, problem: null };

  let declared: string | undefined;
  try {
    declared = readMetaSync(root)?.testCommand;
  } catch {
    // A malformed meta file is reported by the commands that validate it; the
    // runner degrades to its default rather than adding a second failure mode.
    return { command: undefined, problem: null };
  }
  if (declared === undefined) return { command: undefined, problem: null };

  const argv = normalizeTestCommand([declared]);
  if (!argv) {
    return {
      command: undefined,
      problem: "testCommand in .codument-meta.json is empty — using the default runner",
    };
  }
  if (!argv.includes("{file}")) {
    return {
      command: undefined,
      problem: `testCommand in .codument-meta.json has no {file} token (${declared}) — it would run the whole suite per finding, so the default runner is used instead`,
    };
  }
  return { command: argv, problem: null };
}

/**
 * The confirm gate's per-test budget, in SECONDS.
 *
 * 300 is a measurement, not a round guess: this repository's largest test file takes
 * 230 seconds under the default runner, and a budget its own suite cannot fit leaves
 * the tool unable to gate itself — every finding naming that file came back
 * unadjudicated while the project's toolchain was perfectly fine. Re-measure it
 * rather than inherit it.
 */
export const DEFAULT_TEST_TIMEOUT_SECONDS = 300;

// A budget above a day for ONE test file is the seconds/milliseconds slip the key
// name exists to prevent, arriving anyway. Refusing it is the difference between a
// named fallback and a gate that appears to hang for three days.
const MAX_TEST_TIMEOUT_SECONDS = 86_400;

export interface ResolvedTestTimeout {
  /** The budget to hand the runner. */
  timeoutMs: number;
  /** Set when a DECLARED budget was refused and the default used instead. The caller
   *  must surface it, for the same reason a refused command is surfaced. */
  problem: string | null;
}

/**
 * How long one test file may run, resolved once for every consumer.
 *
 * Precedence mirrors `resolveTestCommand` exactly — `--test-timeout` > `testTimeoutSeconds`
 * in `.codument-meta.json` > the built-in default — because how slow a suite is, like how
 * it is run, is a fact about the project rather than a per-invocation choice.
 *
 * A declaration that cannot mean what its author intended is REFUSED and reported, never
 * silently obeyed: a budget of zero or less would make every test read unrunnable, which
 * is a silent always-green — the precise failure this gate exists to prevent.
 */
export function resolveTestTimeout(root: string, flag?: string | number): ResolvedTestTimeout {
  const fallbackMs = DEFAULT_TEST_TIMEOUT_SECONDS * 1000;
  const settle = (parsed: number | string): ResolvedTestTimeout =>
    typeof parsed === "number"
      ? // Never below 1ms: `spawnSync` reads a timeout of 0 as NO timeout, so a
        // sub-millisecond budget would round to a clock that is switched off — the
        // silent always-green the refusal above exists to prevent, arriving through
        // the rounding instead of through the guard.
        { timeoutMs: Math.max(1, Math.round(parsed * 1000)), problem: null }
      : { timeoutMs: fallbackMs, problem: parsed };

  if (flag !== undefined && String(flag).trim() !== "") {
    return settle(parseTimeoutSeconds(flag, "--test-timeout"));
  }
  let declared: unknown;
  try {
    declared = readMetaSync(root)?.testTimeoutSeconds;
  } catch {
    // Same degrade as the command resolver: a malformed meta file is reported by the
    // commands that validate it, and must not add a second failure mode here.
    return { timeoutMs: fallbackMs, problem: null };
  }
  if (declared === undefined) return { timeoutMs: fallbackMs, problem: null };
  return settle(parseTimeoutSeconds(declared, "testTimeoutSeconds in .codument-meta.json"));
}

/** Seconds, or the sentence explaining why the declaration was refused. A numeric
 *  string is accepted from either source — the flag can only deliver one, and refusing
 *  it in JSON would be a rule the reader has to learn for nothing. */
function parseTimeoutSeconds(value: unknown, source: string): number | string {
  const seconds =
    typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  // JSON-shaped for non-strings so a refusal never reads as empty parentheses
  // (`String([])` is ""), which looks like the tool losing the value it refused.
  const shown = typeof value === "string" ? value.trim() : (JSON.stringify(value) ?? String(value));
  const fell = `the default ${DEFAULT_TEST_TIMEOUT_SECONDS}s budget is used instead`;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return `${source} is not a positive number of seconds (${shown}) — ${fell}`;
  }
  if (seconds > MAX_TEST_TIMEOUT_SECONDS) {
    return `${source} is ${shown}, over a day for one test file — the unit is seconds, not milliseconds, so ${fell}`;
  }
  return seconds;
}

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
    // Return the CANONICAL path, not the (possibly symlinked) candidate: the runner
    // spawns on what we return, so handing back the realpath we just containment-
    // checked closes the check-then-spawn gap (a symlink repointed after the check
    // cannot redirect the spawn out of the tree).
    return real;
  }
  return null;
}

// The environment for a spawned test child, stripped of everything that could flip its
// verdict independently of the target's own code — so a `failed`/`passed` result is a
// pure function of the project, never of the shell the developer happens to run from.
//
// Removed:
//   - `NODE_TEST_CONTEXT` (and any `NODE_TEST_*`): when the runner is itself invoked
//     from inside a `node --test` process (a project wiring `codument review` /
//     `doctor --verify-invariants` in as a test step), the child would inherit the
//     parent's test-runner IPC context and exit 0 even on a FAILING test — a red test
//     read as green, the false-pass the gate exists to forbid.
//   - `NODE_OPTIONS` and `NODE_V8_COVERAGE`: an ambient flag (a coverage hook, a
//     `--test-name-pattern`, and above all an IDE debugger's auto-attach injection —
//     VS Code sets `NODE_OPTIONS=--require <js-debug bootloader>` plus
//     `VSCODE_INSPECTOR_OPTIONS`) can make the child crash before it emits any TAP, so
//     a genuinely red test reads as `unrunnable`. The editor silently deciding the
//     gate's verdict is exactly what "pure function of the code" rules out.
//
// A project whose tests genuinely need a Node flag passes it in the test COMMAND (which
// codument forwards verbatim), never via the ambient environment.
export function cleanNodeTestEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  delete env.NODE_OPTIONS;
  delete env.NODE_V8_COVERAGE;
  delete env.VSCODE_INSPECTOR_OPTIONS;
  for (const key of Object.keys(env)) {
    if (key.startsWith("NODE_TEST_")) delete env[key];
  }
  return env;
}

// Evidence the runner actually EXECUTED tests — not that they passed. node:test,
// tsx, vitest and jest all emit this; a toolchain error emits none of it.
const RAN_TESTS = /^(?:TAP version|ok\b|not ok\b|# tests\b|# pass\b|# fail\b|# Subtest)/m;
// Evidence a test FAILED. Indent-tolerant, because node:test prints subtests nested
// under their parent and that is where a real failure appears first — the sibling
// above can afford to be strict since it also matches the unindented summary lines.
const TEST_FAILED = /^\s*not ok\b/m;

// The real runner: resolve the test file, run it through the configured command,
// and map the result. A missing file, a spawn error, or a kill/timeout is
// `unrunnable` (never a pass); exit 0 is `passed`; any nonzero exit is `failed`.
export function makeTestRunner(opts: TestRunnerOptions): TestRunner {
  // Resolution lives HERE, not at each call site: `invariantProbes` and any future
  // consumer take an optional command, so a caller that omits it must still get the
  // project's declared runner rather than silently falling back to codument's own.
  const command = opts.command ?? resolveTestCommand(opts.root).command ?? DEFAULT_TEST_COMMAND;
  const searchDirs = opts.searchDirs ?? DEFAULT_TEST_SEARCH_DIRS;
  // Resolved here for the same reason the command is: a caller that omits the budget
  // must get the PROJECT's, not codument's own guess about how slow its tests are.
  const timeout = opts.timeoutMs ?? resolveTestTimeout(opts.root).timeoutMs;
  // Spawn the child in a clean env (see cleanNodeTestEnv) so its verdict is a pure
  // function of the project, never the ambient shell: strips the parent test-runner
  // context AND ambient NODE_OPTIONS, incl. an IDE debugger's auto-attach injection
  // that would otherwise make a genuinely red test read as unrunnable.
  const env = cleanNodeTestEnv();
  return (testRef: string): TestRunResult => {
    const resolved = resolveTestPath(opts.root, testRef, searchDirs);
    if (!resolved) return { outcome: "unrunnable", detail: `test not found: ${testRef}` };
    const argv = command.map((a) => (a === "{file}" ? resolved : a));
    // win32-safe: a .cmd shim (npx/npm/vitest) needs a shell since Node's
    // CVE-2024-27980 hardening; POSIX spawns exactly as before.
    const res = spawnArgvSync(argv, { cwd: opts.root, timeout, encoding: "utf8", env });
    // Whatever the child wrote before it stopped — a timeout kill preserves it, which
    // is what makes the partial-evidence rule below possible.
    const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
    // A timeout is not a toolchain gap and must not be described as one: the runner
    // was present, the command was right, and the test was running. What expired was
    // OUR clock — so it is named as itself, with the budget the reader would raise.
    // Left as the raw spawn error it read `spawnSync C:\WINDOWS\system32\cmd.exe
    // ETIMEDOUT`, which names a shell the reader never asked for.
    if ((res.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
      const budget = `timed out after ${Math.round(timeout / 1000)}s`;
      // An expired clock proves nothing about the tests that never ran — but it does
      // not erase what the child already put on the wire. Where a failure is ALREADY
      // in the captured output, the reproduction happened and throwing it away would
      // downgrade a demonstrated bug to a shrug because the file had more to do
      // afterwards. One-directional by construction: a timeout can become a block,
      // never a pass, because the tests that did not get to run are precisely the
      // ones a green reading would be making a claim about.
      if (TEST_FAILED.test(out)) {
        return { outcome: "failed", cause: "timeout", detail: `${budget}, a test having already failed` };
      }
      return { outcome: "unrunnable", cause: "timeout", detail: budget };
    }
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
    if (!RAN_TESTS.test(out)) {
      return {
        outcome: "unrunnable",
        detail: `runner exited ${res.status} without producing test results (toolchain error?)`,
      };
    }
    return { outcome: "failed", detail: `exit ${res.status}` };
  };
}
