import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync, mkdtempSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanNodeTestEnv,
  confirmFindings,
  defaultCommandAvailable,
  confirmCondition,
  resolveTestCommand,
  resolveTestPath,
  resolveTestTimeout,
  makeTestRunner,
  spawnArgvSync,
  winCommandLine,
  DEFAULT_TEST_COMMAND,
  DEFAULT_TEST_TIMEOUT_SECONDS,
  type TestRunner,
  type TestRunResult,
} from "../src/lib/review-confirm.js";
import type { ReviewFinding } from "../src/lib/review-artifact.js";

function finding(partial: Partial<ReviewFinding>): ReviewFinding {
  return {
    citation: "src/x.ts:1",
    detail: "something",
    failingTest: null,
    status: "advisory",
    ...partial,
  };
}

// A runner that returns a fixed outcome per test ref.
function fakeRunner(map: Record<string, TestRunResult>): TestRunner {
  return (ref) => map[ref] ?? { outcome: "unrunnable", detail: "not mapped" };
}

describe("confirmFindings — test outcome decides the verdict, not the claim", () => {
  it("a red test confirms the finding (blocking)", () => {
    const res = confirmFindings(
      [finding({ failingTest: "bug.test.ts", status: "advisory" })],
      fakeRunner({ "bug.test.ts": { outcome: "failed", detail: "exit 1" } }),
    );
    assert.equal(res.findings[0].status, "confirmed");
    assert.equal(res.findings[0].testOutcome, "failed");
    assert.equal(res.hasBlocking, true);
    assert.equal(res.blocking.length, 1);
  });

  it("a green test resolves the finding (not demonstrably present), never blocks", () => {
    const res = confirmFindings(
      [finding({ failingTest: "fixed.test.ts", status: "confirmed" })],
      fakeRunner({ "fixed.test.ts": { outcome: "passed" } }),
    );
    assert.equal(res.findings[0].status, "resolved");
    assert.equal(res.hasBlocking, false);
  });

  it("a CLAIMED-resolved finding whose test is still red is overridden to confirmed", () => {
    // verify, don't trust: the reproduction decides, not the label
    const res = confirmFindings(
      [finding({ failingTest: "still-broken.test.ts", status: "resolved" })],
      fakeRunner({ "still-broken.test.ts": { outcome: "failed" } }),
    );
    assert.equal(res.findings[0].status, "confirmed");
    assert.equal(res.hasBlocking, true);
  });

  it("an unrunnable named test never blocks — it surfaces as advisory with a reason", () => {
    const res = confirmFindings(
      [finding({ failingTest: "ghost.test.ts", status: "advisory" })],
      fakeRunner({ "ghost.test.ts": { outcome: "unrunnable", detail: "test not found: ghost.test.ts" } }),
    );
    assert.equal(res.findings[0].status, "advisory");
    assert.equal(res.findings[0].testOutcome, "unrunnable");
    assert.match(res.findings[0].note ?? "", /not found/);
    assert.equal(res.hasBlocking, false);
  });

  it("a finding with no test stays a judgment call (advisory), preserving a user-set resolved", () => {
    const res = confirmFindings(
      [
        finding({ failingTest: null, status: "advisory" }),
        finding({ failingTest: null, status: "resolved" }),
        // "confirmed" with no test is invalid → downgraded, nothing verifies it
        finding({ failingTest: null, status: "confirmed" }),
      ],
      fakeRunner({}),
    );
    assert.deepEqual(
      res.findings.map((f) => f.status),
      ["advisory", "resolved", "advisory"],
    );
    assert.equal(res.hasBlocking, false);
  });

  it("hasBlocking and blocking reflect the mix", () => {
    const res = confirmFindings(
      [
        finding({ failingTest: "a.test.ts" }),
        finding({ failingTest: "b.test.ts" }),
        finding({ failingTest: null }),
      ],
      fakeRunner({
        "a.test.ts": { outcome: "failed" },
        "b.test.ts": { outcome: "passed" },
      }),
    );
    assert.equal(res.hasBlocking, true);
    assert.deepEqual(res.blocking.map((f) => f.failingTest), ["a.test.ts"]);
  });
});

describe("resolveTestPath", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-resolve-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("resolves a bare name under tests/ and a path relative to root, else null", () => {
    writeFileSync(join(tmp, "root-level.test.ts"), "");
    // Returns the canonical (realpath) of the resolved file.
    assert.equal(
      resolveTestPath(tmp, "root-level.test.ts", ["", "tests"]),
      realpathSync(join(tmp, "root-level.test.ts")),
    );
    assert.equal(resolveTestPath(tmp, "missing.test.ts", ["", "tests"]), null);
  });

  it("refuses a reference that escapes root (../../)", () => {
    // even if the escaped path exists on disk, it must not resolve
    assert.equal(resolveTestPath(tmp, "../../../../../../etc/passwd", [""]), null);
  });

  it("refuses a symlinked test whose target escapes root (realpath, not just lexical)", () => {
    // The lexical guard alone is fooled by a symlink: `<root>/evil.test.ts` is
    // in-root by string, but its target is outside the tree. path.resolve never
    // follows links, so without the realpath re-check this would run out-of-tree code.
    const outside = mkdtempSync(join(tmpdir(), "codument-outside-"));
    try {
      writeFileSync(join(outside, "evil.test.ts"), "");
      symlinkSync(join(outside, "evil.test.ts"), join(tmp, "evil.test.ts"));
      assert.equal(resolveTestPath(tmp, "evil.test.ts", [""]), null);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("still resolves a symlink whose target stays inside root (to the canonical path)", () => {
    writeFileSync(join(tmp, "real.test.ts"), "");
    symlinkSync(join(tmp, "real.test.ts"), join(tmp, "link.test.ts"));
    // Resolves, but to the canonical target — the spawn runs the real file, not the link.
    assert.equal(resolveTestPath(tmp, "link.test.ts", [""]), realpathSync(join(tmp, "real.test.ts")));
  });
});

describe("makeTestRunner — exit code maps to outcome", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-runner-"));
    writeFileSync(join(tmp, "x.test.ts"), "");
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  // Deterministic, fast: drive the runner with `node -e` instead of a real test
  // runner, so we exercise the exit-code → outcome mapping without npx/tsx.
  it("exit 0 → passed", () => {
    const run = makeTestRunner({ root: tmp, command: ["node", "-e", "process.exit(0)", "{file}"] });
    assert.equal(run("x.test.ts").outcome, "passed");
  });

  it("nonzero exit WITH test evidence (TAP) → failed", () => {
    // A genuine test run that reports a failure: TAP output + nonzero exit.
    const run = makeTestRunner({
      root: tmp,
      command: ["node", "-e", "console.log('not ok 1 - bug'); process.exit(1)", "{file}"],
    });
    assert.equal(run("x.test.ts").outcome, "failed");
  });

  it("nonzero exit WITHOUT test evidence → unrunnable (toolchain failure, not a false block)", () => {
    // The missing-runner / module-resolution case: exits nonzero but never ran a
    // test. Trusting the exit code here would false-block every finding; with no
    // TAP evidence it must degrade to unrunnable (→ advisory), never `failed`.
    const run = makeTestRunner({
      root: tmp,
      command: ["node", "-e", "console.error('Cannot find module: tsx'); process.exit(1)", "{file}"],
    });
    assert.equal(run("x.test.ts").outcome, "unrunnable");
  });

  it("a missing test file → unrunnable (never a pass)", () => {
    const run = makeTestRunner({ root: tmp, command: ["node", "-e", "process.exit(0)", "{file}"] });
    assert.equal(run("nope.test.ts").outcome, "unrunnable");
  });

  it("a signal-killed run → unrunnable (never a definitive pass/fail)", () => {
    const run = makeTestRunner({
      root: tmp,
      command: ["node", "-e", "process.kill(process.pid, 'SIGTERM')", "{file}"],
    });
    assert.equal(run("x.test.ts").outcome, "unrunnable");
  });

  it("a spawn error (command not found) → unrunnable", () => {
    const run = makeTestRunner({ root: tmp, command: ["this-command-does-not-exist-zzz", "{file}"] });
    assert.equal(run("x.test.ts").outcome, "unrunnable");
  });

  it("strips NODE_TEST_CONTEXT so a spawned node:test child reports its TRUE exit (never a false green)", () => {
    // A failing node:test file exits 1 standalone but exits 0 if it inherits a
    // parent test-runner's NODE_TEST_CONTEXT. When codument's runner is invoked
    // from inside another `node --test` run, it must strip that so a red test is
    // never read as green.
    // Declare the fixture dir ESM so `red.test.js` parses as a module on every Node
    // version (auto ESM detection is only default on 22.7+). Otherwise on Node 18/20
    // the `import` is a CommonJS SyntaxError: the file exits red for the WRONG reason
    // and never actually runs, so the NODE_TEST_CONTEXT stripping this test exists to
    // prove is never exercised.
    writeFileSync(join(tmp, "package.json"), '{"type":"module"}\n');
    writeFileSync(
      join(tmp, "red.test.js"),
      'import{test}from"node:test";import a from"node:assert";test("x",()=>a.equal(1,2));\n',
    );
    const prev = process.env.NODE_TEST_CONTEXT;
    process.env.NODE_TEST_CONTEXT = "child-v8"; // simulate running under `node --test`
    try {
      const run = makeTestRunner({ root: tmp, command: ["node", "--test", "{file}"] });
      assert.equal(run("red.test.js").outcome, "failed");
    } finally {
      if (prev === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = prev;
    }
  });

  it("an ambient NODE_OPTIONS debugger injection cannot flip a real red test to unrunnable", () => {
    // VS Code's "Auto Attach" injects `NODE_OPTIONS=--require <js-debug bootloader>`
    // into the terminal. Inherited by a spawned `node --test`, a bootloader that fails
    // to load crashes the child before it emits any TAP, so a genuinely red test reads
    // as `unrunnable` — the editor silently deciding the gate's verdict. The runner
    // strips ambient NODE_OPTIONS (cleanNodeTestEnv), so the verdict stays a pure
    // function of the code. (Regression: this made `npm publish` fail from a VS Code
    // terminal while passing headless.)
    writeFileSync(join(tmp, "package.json"), '{"type":"module"}\n');
    writeFileSync(
      join(tmp, "red.test.js"),
      'import{test}from"node:test";import a from"node:assert";test("x",()=>a.equal(1,2));\n',
    );
    const prev = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--require /nonexistent-js-debug-bootloader.cjs";
    try {
      const run = makeTestRunner({ root: tmp, command: ["node", "--test", "{file}"] });
      assert.equal(run("red.test.js").outcome, "failed");
    } finally {
      if (prev === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = prev;
    }
  });
});

describe("cleanNodeTestEnv — a spawned test's verdict is a pure function of the code", () => {
  it("strips the parent test context, ambient NODE_OPTIONS, coverage, and the VS Code debugger injection", () => {
    const env = cleanNodeTestEnv({
      PATH: "/usr/bin",
      HOME: "/home/me",
      NODE_OPTIONS: '--require "/ext/js-debug/bootloader.js"',
      NODE_V8_COVERAGE: "/cov",
      NODE_TEST_CONTEXT: "child-v8",
      VSCODE_INSPECTOR_OPTIONS: "{...}",
    });
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.NODE_V8_COVERAGE, undefined);
    assert.equal(env.NODE_TEST_CONTEXT, undefined);
    assert.equal(env.VSCODE_INSPECTOR_OPTIONS, undefined);
    // Non-test environment is preserved untouched.
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/home/me");
  });

  it("does not mutate the source environment", () => {
    const src = { NODE_OPTIONS: "--inspect", KEEP: "1" };
    cleanNodeTestEnv(src);
    assert.equal(src.NODE_OPTIONS, "--inspect");
  });
});

describe("win32-safe spawning (the confirm gate must not be structurally green on Windows)", () => {
  it("winCommandLine quotes args with whitespace and doubles embedded quotes (cmd.exe escape)", () => {
    assert.equal(
      winCommandLine(["npx", "--no-install", "tsx", "--test", "C:\\repo\\my tests\\x.test.ts"]),
      'npx --no-install tsx --test "C:\\repo\\my tests\\x.test.ts"',
    );
    assert.equal(winCommandLine(["node", '-e', 'say "hi"']), 'node -e "say ""hi"""');
    assert.equal(winCommandLine(["a&b"]), '"a&b"', "cmd metacharacters force quoting");
    assert.equal(winCommandLine(["plain", "args.ts"]), "plain args.ts", "plain args untouched");
    assert.equal(winCommandLine([""]), '""', "an empty arg survives as an empty pair");
  });

  it("spawnArgvSync on POSIX is a plain no-shell spawn (byte-identical behavior)", () => {
    const res = spawnArgvSync(["node", "-e", "console.log(process.argv[1])", "a b"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    // No shell: the space-bearing arg arrives as ONE argv element, un-mangled.
    assert.equal(res.stdout.trim(), "a b");
  });
});

describe("default command is local-only (no network on the verdict path)", () => {
  it("the default command pins --no-install, so npx can never fetch unpinned code", () => {
    assert.ok(
      DEFAULT_TEST_COMMAND.includes("--no-install"),
      "default resolution must be local-only",
    );
  });

  it("defaultCommandAvailable: local tsx → available without any spawn", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-cmd-avail-"));
    try {
      const bin = join(tmp, "node_modules", ".bin");
      await (await import("node:fs/promises")).mkdir(bin, { recursive: true });
      writeFileSync(join(bin, "tsx"), "#!/bin/sh\n");
      assert.equal(defaultCommandAvailable(tmp), true, "local tsx: available");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("defaultCommandAvailable: no local tsx falls back to asking npx itself (hoisted/global counts)", async () => {
    // Deterministic on any machine: shadow npx with a shim so the probe's answer
    // is controlled — exit 1 → unavailable, exit 0 → available (a machine whose
    // real npx can resolve tsx without a fetch genuinely CAN run the confirm step).
    // The shim has to be one the PLATFORM will execute and reach through the
    // platform's own PATH separator: a `#!/bin/sh` file called `npx` joined with a
    // colon is invisible to cmd.exe, so on Windows the real npx answered and the
    // assertion became a question about the developer's machine.
    const tmp = await mkdtemp(join(tmpdir(), "codument-cmd-avail-"));
    const fakeBin = await mkdtemp(join(tmpdir(), "codument-fake-npx-"));
    const origPath = process.env.PATH;
    const win = process.platform === "win32";
    const shim = join(fakeBin, win ? "npx.cmd" : "npx");
    const exiting = (code: number) => (win ? `@echo off\r\nexit /b ${code}\r\n` : `#!/bin/sh\nexit ${code}\n`);
    try {
      const { chmod } = await import("node:fs/promises");
      writeFileSync(shim, exiting(1));
      if (!win) await chmod(shim, 0o755);
      process.env.PATH = `${fakeBin}${delimiter}${origPath ?? ""}`;
      assert.equal(defaultCommandAvailable(tmp), false, "npx cannot resolve it: unavailable");

      writeFileSync(shim, exiting(0));
      assert.equal(defaultCommandAvailable(tmp), true, "npx resolves it (global/hoisted): available");
    } finally {
      process.env.PATH = origPath;
      await rm(tmp, { recursive: true, force: true });
      await rm(fakeBin, { recursive: true, force: true });
    }
  });
});

describe("resolveTestCommand (flag > project config > built-in default)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-testcmd-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const meta = (extra: Record<string, unknown>) =>
    writeFileSync(
      join(tmp, ".codument-meta.json"),
      JSON.stringify({ version: "0.13.0", initialized: "2026-08-05", project: {}, ...extra }),
    );

  it("falls back to the built-in default when nothing is declared", () => {
    assert.deepEqual(resolveTestCommand(tmp), { command: undefined, problem: null });
    meta({});
    assert.deepEqual(resolveTestCommand(tmp), { command: undefined, problem: null });
  });

  it("reads testCommand from project config, splitting the quoted string form", () => {
    meta({ testCommand: "vitest run {file}" });
    assert.deepEqual(resolveTestCommand(tmp).command, ["vitest", "run", "{file}"]);
  });

  it("lets the flag win over project config", () => {
    meta({ testCommand: "vitest run {file}" });
    assert.deepEqual(resolveTestCommand(tmp, ["bun test {file}"]).command, [
      "bun",
      "test",
      "{file}",
    ]);
  });

  it("refuses a declared command with no {file} slot and says so, rather than running the whole suite per finding", () => {
    meta({ testCommand: "npm test" });
    const r = resolveTestCommand(tmp);
    assert.equal(r.command, undefined, "falls back to the default");
    assert.match(r.problem ?? "", /no \{file\} token/);
  });

  it("refuses an empty declaration loudly", () => {
    meta({ testCommand: "   " });
    const r = resolveTestCommand(tmp);
    assert.equal(r.command, undefined);
    assert.match(r.problem ?? "", /empty/);
  });

  it("degrades to the default on an unreadable meta file instead of throwing", () => {
    writeFileSync(join(tmp, ".codument-meta.json"), "{ not json");
    assert.deepEqual(resolveTestCommand(tmp), { command: undefined, problem: null });
  });

  it("makeTestRunner picks config up on its own, so a caller that omits the command is not silently on tsx", () => {
    // The test file must EXIST: resolveTestPath runs before the command is read, so
    // a missing file returns unrunnable without ever exercising resolution — an
    // assertion that would pass with the config lookup deleted.
    writeFileSync(join(tmp, "probe.test.ts"), "");
    // A command only the config declares, whose exit code is the whole assertion:
    // node exits 3, and no other runner would. If makeTestRunner fell back to the
    // default (tsx) the outcome could not be a nonzero-with-no-TAP unrunnable
    // carrying exit 3.
    meta({ testCommand: "node -e process.exit(3) {file}" });
    const res = makeTestRunner({ root: tmp })("probe.test.ts");
    assert.equal(res.outcome, "unrunnable", "nonzero exit with no TAP is unrunnable");
    assert.match(res.detail ?? "", /exited 3/, "the CONFIGURED command ran, not the default");

    // And the negative half: with no declaration the same file goes to the default
    // runner, which does not exit 3.
    rmSync(join(tmp, ".codument-meta.json"));
    assert.doesNotMatch(
      makeTestRunner({ root: tmp })("probe.test.ts").detail ?? "",
      /exited 3/,
      "without the declaration the configured command is not used",
    );
  });
});

describe("resolveTestTimeout (the gate's clock is the project's to set)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-testtimeout-"));
  });
  afterEach(async () => {
    // Retried, because the hanging-process test below leaves the child holding this
    // directory as its cwd: on win32 the timeout kills the shell and the grandchild
    // survives it (the runner's named boundary), so the first rmdir hits EBUSY.
    await rm(tmp, { recursive: true, force: true, maxRetries: 40, retryDelay: 300 });
  });

  const meta = (extra: Record<string, unknown>) =>
    writeFileSync(
      join(tmp, ".codument-meta.json"),
      JSON.stringify({ version: "0.18.0", initialized: "2026-08-14", project: {}, ...extra }),
    );

  const DEFAULT_MS = DEFAULT_TEST_TIMEOUT_SECONDS * 1000;

  it("falls back to the measured default when nothing is declared", () => {
    assert.deepEqual(resolveTestTimeout(tmp), { timeoutMs: DEFAULT_MS, problem: null });
    meta({});
    assert.deepEqual(resolveTestTimeout(tmp), { timeoutMs: DEFAULT_MS, problem: null });
  });

  it("the default fits this repository's own slowest test file", () => {
    // Measured at 230s under the default runner. A budget its own suite cannot fit is
    // a budget that leaves the tool unable to gate itself — which is the whole reason
    // this resolver exists, so the number is pinned rather than left to drift back.
    assert.ok(
      DEFAULT_TEST_TIMEOUT_SECONDS >= 240,
      `default is ${DEFAULT_TEST_TIMEOUT_SECONDS}s, under the 230s this repo measures`,
    );
  });

  it("reads testTimeoutSeconds from project config, and lets the flag win", () => {
    meta({ testTimeoutSeconds: 45 });
    assert.deepEqual(resolveTestTimeout(tmp), { timeoutMs: 45_000, problem: null });
    assert.deepEqual(resolveTestTimeout(tmp, "90"), { timeoutMs: 90_000, problem: null });
  });

  it("accepts a numeric string from either source (the flag can only deliver one)", () => {
    meta({ testTimeoutSeconds: "60" });
    assert.deepEqual(resolveTestTimeout(tmp), { timeoutMs: 60_000, problem: null });
  });

  it("refuses a budget that would make every test unrunnable, rather than obeying it", () => {
    // Zero or less is a silently-green gate: nothing can finish, so every finding
    // reads advisory and the commit sails through. Refusing loudly is the only
    // reading of it that is not a lie.
    for (const bad of [0, -5, "nope", null, true]) {
      meta({ testTimeoutSeconds: bad });
      const r = resolveTestTimeout(tmp);
      assert.equal(r.timeoutMs, DEFAULT_MS, `${JSON.stringify(bad)} must fall back`);
      assert.match(r.problem ?? "", /not a positive number of seconds/);
    }
  });

  it("never rounds a tiny budget down to a clock that is switched off", () => {
    // spawnSync reads timeout: 0 as NO timeout, so a sub-millisecond declaration
    // would pass the positive-number guard and then disable the gate entirely —
    // the silent always-green arriving through the rounding rather than the guard.
    meta({ testTimeoutSeconds: 0.0001 });
    assert.equal(resolveTestTimeout(tmp).timeoutMs, 1);
  });

  it("refuses an over-a-day budget and names the unit that was confused", () => {
    meta({ testTimeoutSeconds: 300_000 });
    const r = resolveTestTimeout(tmp);
    assert.equal(r.timeoutMs, DEFAULT_MS);
    assert.match(r.problem ?? "", /seconds, not milliseconds/);
  });

  it("degrades to the default on an unreadable meta file instead of throwing", () => {
    writeFileSync(join(tmp, ".codument-meta.json"), "{ not json");
    assert.deepEqual(resolveTestTimeout(tmp), { timeoutMs: DEFAULT_MS, problem: null });
  });

  it("makeTestRunner picks the declared budget up on its own, so an omitted one is not silently 300s", () => {
    // Proven by wall-clock against a REAL hanging process, not by reading the option
    // back: a runner that ignored the declaration would sit here for five minutes.
    // The child outlives the declared budget but exits well inside any default, so
    // the assertion is the DECLARATION and not merely "some timeout exists": a runner
    // ignoring it would sit here for the child's own six seconds. It also dies soon
    // enough that the orphan it becomes on win32 releases this temp dir for the
    // retrying cleanup above.
    writeFileSync(join(tmp, "hang.test.js"), "setTimeout(() => {}, 6_000);\n");
    meta({ testTimeoutSeconds: 1, testCommand: "node {file}" });
    const started = Date.now();
    const res = makeTestRunner({ root: tmp })("hang.test.js");
    const elapsedMs = Date.now() - started;
    assert.equal(res.outcome, "unrunnable", "a budget that expired is never a pass");
    assert.ok(elapsedMs < 3_500, `waited ${elapsedMs}ms for a 1s budget — the declaration was ignored`);
  });
});

describe("confirmCondition (one wording for every surface that runs tests)", () => {
  const base = {
    commandProblem: null,
    timeoutProblem: null,
    unadjudicated: 0,
    timedOut: 0,
    budgetMs: 300_000,
    noun: "finding",
    consequence: "advisory rather than judged",
    defaultUnavailable: false,
  };
  const RUNNER_ROUTE = /--test-command/;
  const BUDGET_ROUTE = /--test-timeout/;

  it("says nothing when nothing is wrong", () => {
    assert.equal(confirmCondition(base), null);
  });

  it("reports the refused declaration AND the unadjudicated count together", () => {
    // These are usually one incident: a slotless testCommand falls back to a default
    // that cannot emit evidence. Reporting only the count names the symptom and
    // drops the cause, which is the bug this shape exists to prevent.
    const msg = confirmCondition({
      ...base,
      commandProblem: "testCommand in .codument-meta.json has no {file} token (npm test) — …",
      unadjudicated: 2,
    });
    assert.match(msg ?? "", /no \{file\} token/);
    assert.match(msg ?? "", /2 findings could not be adjudicated/);
  });

  it("carries EVERY refused declaration, because a project can get two wrong at once", () => {
    // The runner takes two declarations now. Reporting one and dropping the other
    // sends the reader to fix a setting that was never the problem — the same
    // half-an-incident failure that made this builder shared in the first place.
    const msg = confirmCondition({
      ...base,
      commandProblem: "testCommand in .codument-meta.json has no {file} token (npm test) — …",
      timeoutProblem: "testTimeoutSeconds in .codument-meta.json is not a positive number (nope) — …",
      unadjudicated: 1,
    });
    assert.match(msg ?? "", /no \{file\} token/);
    assert.match(msg ?? "", /not a positive number/);
    assert.match(msg ?? "", RUNNER_ROUTE);
    assert.match(msg ?? "", BUDGET_ROUTE);
  });

  it("offers the budget route for a timeout, and NOT the runner it was never about", () => {
    // The defect this whole step exists to remove: a test that ran out of codument's
    // clock was described as producing no test evidence and routed to --test-command,
    // so a reader whose runner was perfect went and rewrote their runner.
    const msg =
      confirmCondition({ ...base, unadjudicated: 2, timedOut: 2, budgetMs: 300_000 }) ?? "";
    assert.match(msg, /ran out of the 300s budget/);
    assert.match(msg, BUDGET_ROUTE);
    assert.doesNotMatch(msg, RUNNER_ROUTE, "the runner was never the problem");
    assert.doesNotMatch(msg, /no test evidence/, "the runner produced plenty; it was cut off");
  });

  it("offers the runner route alone when nothing timed out", () => {
    // The other direction, so the split cannot be satisfied by always naming both.
    const msg = confirmCondition({ ...base, unadjudicated: 2, timedOut: 0 }) ?? "";
    assert.match(msg, RUNNER_ROUTE);
    assert.doesNotMatch(msg, BUDGET_ROUTE, "no budget expired, so raising one fixes nothing");
  });

  it("names both causes and both routes when the run hit both", () => {
    const msg = confirmCondition({ ...base, unadjudicated: 3, timedOut: 1 }) ?? "";
    assert.match(msg, /1 finding ran out of the 300s budget/);
    assert.match(msg, /2 findings could not be adjudicated/);
    assert.match(msg, RUNNER_ROUTE);
    assert.match(msg, BUDGET_ROUTE);
  });

  it("states the budget that actually expired, not a constant", () => {
    // The number is the one thing the reader needs to pick a bigger one.
    assert.match(
      confirmCondition({ ...base, unadjudicated: 1, timedOut: 1, budgetMs: 45_000 }) ?? "",
      /ran out of the 45s budget/,
    );
  });

  it("a refused budget routes to the budget, never to the test command", () => {
    const msg =
      confirmCondition({
        ...base,
        timeoutProblem: "testTimeoutSeconds in .codument-meta.json is not a positive number (nope) — …",
      }) ?? "";
    assert.match(msg, BUDGET_ROUTE);
    assert.doesNotMatch(msg, RUNNER_ROUTE);
  });

  it("keeps the default-runner probe as a last resort, never alongside a real cause", () => {
    assert.match(
      confirmCondition({ ...base, defaultUnavailable: true }) ?? "",
      /no local tsx/,
    );
    // A declared runner is judged by outcomes, so the probe must not also fire.
    assert.doesNotMatch(
      confirmCondition({ ...base, unadjudicated: 1, defaultUnavailable: true }) ?? "",
      /no local tsx/,
    );
  });

  it("reads in both numbers and for either noun", () => {
    assert.match(confirmCondition({ ...base, unadjudicated: 1 }) ?? "", /1 finding could not/);
    assert.match(
      confirmCondition({ ...base, unadjudicated: 1 }) ?? "",
      /it reads advisory rather than judged/,
    );
    assert.match(
      confirmCondition({
        ...base,
        unadjudicated: 3,
        noun: "invariant",
        consequence: "excluded from the score",
      }) ?? "",
      /3 invariants could not be adjudicated.*they read excluded from the score/,
    );
    // The timeout half has to speak both nouns and both numbers too, or a surface
    // that runs invariants ends up with a sentence written for findings.
    assert.match(
      confirmCondition({
        ...base,
        unadjudicated: 1,
        timedOut: 1,
        noun: "invariant",
        consequence: "excluded from the score",
      }) ?? "",
      /1 invariant ran out of the 300s budget.*it reads excluded from the score/,
    );
  });
});

describe("makeTestRunner names a timeout as itself (the clock is ours, not the project's)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-timeout-cause-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true, maxRetries: 40, retryDelay: 300 });
  });

  it("reports cause 'timeout' and the budget, never the shell it happened to spawn", () => {
    // Before this, the detail read `spawnSync C:\WINDOWS\system32\cmd.exe ETIMEDOUT`
    // — a shell the reader never asked for, and no clue that a budget was the thing
    // that ran out. The cause is a FIELD rather than a phrase in the detail because a
    // routing decision must not rest on sniffing prose for the word "timeout".
    writeFileSync(join(tmp, "hang.test.js"), "setTimeout(() => {}, 6_000);\n");
    const res = makeTestRunner({
      root: tmp,
      command: ["node", "{file}"],
      timeoutMs: 1000,
    })("hang.test.js");
    assert.equal(res.outcome, "unrunnable", "an expired budget proves nothing, so it never blocks");
    assert.equal(res.cause, "timeout");
    assert.match(res.detail ?? "", /timed out after 1s/);
    assert.doesNotMatch(res.detail ?? "", /cmd\.exe|spawnSync/i);
  });

  it("leaves every other unrunnable cause uncaused, so only the timeout reroutes", () => {
    // A missing file and a broken toolchain still belong to the runner remedy; giving
    // them a cause would hand them the budget route, which fixes neither.
    const runner = makeTestRunner({ root: tmp, command: ["node", "{file}"] });
    assert.equal(runner("nope.test.js").cause, undefined);
    writeFileSync(join(tmp, "boom.test.js"), "process.exit(7);\n");
    const boom = runner("boom.test.js");
    assert.equal(boom.outcome, "unrunnable");
    assert.equal(boom.cause, undefined);
  });
});
