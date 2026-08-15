// Adversarial-review follow-up: the plan's own docs (docs/features/adversarial-review-gate.md,
// docs/features/registry-health.md) claim that a declared `testCommand` refusal
// (`resolveTestCommand`'s `.problem`) is "REFUSED and reported, never silently
// obeyed", and that `review --require-review` and `doctor --verify-invariants` are
// "two consumers of one runner [that] cannot report a toolchain gap differently."
//
// Both tests below construct the exact scenario the docs describe (a project that
// declared a `testCommand` with no `{file}` token) and show that the specific
// `.problem` diagnostic — the one telling the user WHY their declared command was
// refused — never reaches the human when an outcome-keyed message also applies.
// `doctor.ts` drops `resolveTestCommand(...).problem` unconditionally (it only
// reads `.command`); `review.ts` computes `.problem` but an `unadjudicated.length >
// 0` branch short-circuits before it is ever read, so a covering review with a
// broken declared command reports a generic "no test evidence" hint instead of the
// actionable "no {file} token" reason review.ts reports when nothing else masks it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { doctor } from "../src/commands/doctor.js";
import { confirmCondition, makeTestRunner } from "../src/lib/review-confirm.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");

// A shim `npx` that always fails immediately with no TAP output, so the built-in
// default (`npx --no-install tsx --test {file}`) — the fallback a refused
// declaration lands on — is deterministically `unrunnable` regardless of what the
// host machine happens to have cached, matching the pattern the existing
// "--require-review names the could-not-run condition" suite already uses.
async function makeFakeNpxDir(): Promise<string> {
  const fakeBin = await mkdtemp(join(tmpdir(), "codument-fake-npx-"));
  await writeFile(join(fakeBin, "npx"), "#!/bin/sh\nexit 1\n");
  await chmod(join(fakeBin, "npx"), 0o755);
  return fakeBin;
}

describe("doctor --verify-invariants silently drops the testCommand refusal reason", () => {
  let tmp: string;
  let fakeBin: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-doctor-testcmd-"));
    fakeBin = await makeFakeNpxDir();
    await mkdir(join(tmp, "docs", "features"), { recursive: true });
    await writeFile(
      join(tmp, "docs", ".registry.json"),
      JSON.stringify({
        features: {
          f: { doc: "docs/features/f.md", type: "feature", primary_sources: [], status: "current" },
        },
      }),
    );
    await writeFile(
      join(tmp, "docs", "features", "f.md"),
      ["# F", "## Invariants & boundaries", "- **thing.** *(test: some.test.js)*", ""].join("\n"),
    );
    // The cited test file must actually exist, or the finding classifies as
    // invariant-unpinned (missing reference) rather than attempting to run —
    // a different code path than the one under test here.
    await writeFile(join(tmp, "some.test.js"), "// a real file so the reference resolves\n");
    // No {file}: resolveTestCommand refuses this. `codument review --require-review`
    // names the exact reason (review.test.ts "a declared testCommand with no {file}
    // slot is refused out loud, not silently obeyed"); the docs claim doctor's
    // --verify-invariants "reports the same condition."
    await writeFile(
      join(tmp, ".codument-meta.json"),
      JSON.stringify({
        version: "0.13.0",
        initialized: "2026-08-05",
        project: {},
        testCommand: "npm test",
      }),
    );
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  });

  it("names the {file}-token refusal the way review --require-review does", async () => {
    const lines: string[] = [];
    const origLog = console.log;
    const origPath = process.env.PATH;
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
    process.env.PATH = `${fakeBin}:${origPath ?? ""}`;
    try {
      await doctor({ root: tmp, verifyInvariants: true });
    } finally {
      console.log = origLog;
      process.env.PATH = origPath;
    }
    const out = lines.join("\n");
    // Sanity: the outcome-keyed unrunnable path DID fire (this is not a case of
    // nothing running at all).
    assert.match(out, /could not be adjudicated/);
    // The actual bug: resolveTestCommand computed a specific, actionable reason
    // ("has no {file} token") and doctor.ts never reads `.problem` at all, so this
    // never appears — contradicting "the two consumers of one runner cannot report
    // a toolchain gap differently."
    assert.match(out, /no \{file\} token/);
  });
});

describe("doctor --verify-invariants routes a timed-out invariant to the clock, not the runner", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-doctor-timeout-"));
    await mkdir(join(tmp, "docs", "features"), { recursive: true });
    await writeFile(
      join(tmp, "docs", ".registry.json"),
      JSON.stringify({
        features: {
          f: { doc: "docs/features/f.md", type: "feature", primary_sources: [], status: "current" },
        },
      }),
    );
    await writeFile(
      join(tmp, "docs", "features", "f.md"),
      ["# F", "## Invariants & boundaries", "- **thing.** *(test: slow.test.js)*", ""].join("\n"),
    );
    // A cited test that outlives the budget: the runner is fine, the command is fine,
    // and the only thing that goes wrong is codument's own clock.
    await writeFile(join(tmp, "slow.test.js"), "setTimeout(() => {}, 30_000);\n");
    await writeFile(
      join(tmp, ".codument-meta.json"),
      JSON.stringify({
        version: "0.18.0",
        initialized: "2026-08-14",
        project: {},
        testCommand: "node {file}",
        testTimeoutSeconds: 1,
      }),
    );
  });
  afterEach(async () => {
    // The win32 orphan holds this directory as its cwd until the child exits on its own.
    await rm(tmp, { recursive: true, force: true, maxRetries: 60, retryDelay: 300 });
  });

  it("words it byte-identically to the shared builder, so the two surfaces cannot drift", async () => {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
    try {
      await doctor({ root: tmp, verifyInvariants: true });
    } finally {
      console.log = origLog;
    }
    const out = lines.join("\n");
    // The exact sentence the builder produces for this incident. Asserting equality
    // with the builder rather than a regex over the prose is what makes this a parity
    // test: doctor cannot word a timeout its own way without going red here.
    const expected = confirmCondition({
      commandProblem: null,
      timeoutProblem: null,
      unadjudicated: 1,
      timedOut: 1,
      budgetMs: 1000,
      noun: "invariant",
      consequence: "excluded from the score",
      runnerUnavailable: null,
    });
    assert.ok(expected, "the builder must produce a condition for this incident");
    assert.ok(
      out.includes(expected),
      `doctor did not render the shared wording.\nexpected to contain: ${expected}\ngot:\n${out}`,
    );
    // And the half that is the whole point: the runner remedy must not be offered for
    // a runner that was never the problem.
    assert.doesNotMatch(out, /--test-command/);
  });
});

// ── review.ts: the same reason gets masked once a covering review exists ──

function gitInit(root: string): void {
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      stdio: "ignore",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
  run(["init"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  run(["add", "-A"]);
  run(["commit", "-m", "baseline"]);
}

const REGISTRY = {
  features: {
    auth: {
      doc: "docs/features/auth.md",
      type: "feature",
      primary_sources: ["src/auth/login.ts"],
      related_sources: [],
      docs: [],
      depends_on: [],
      risk: [],
      last_updated: "2026-06-16",
      status: "current",
    },
  },
};

describe("review --require-review: a covering review masks the {file}-token refusal reason", () => {
  let tmp: string;
  let fakeBin: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-review-testcmd-"));
    fakeBin = await makeFakeNpxDir();
    await mkdir(join(tmp, "docs", "features"), { recursive: true });
    await mkdir(join(tmp, "src", "auth"), { recursive: true });
    await writeFile(join(tmp, "docs", ".registry.json"), JSON.stringify(REGISTRY, null, 2));
    await writeFile(join(tmp, "docs", "features", "auth.md"), "# auth\n");
    await writeFile(join(tmp, "src", "auth", "login.ts"), "export const login = () => 1;\n");
    gitInit(tmp);
    // No {file}: same refused declaration as the doctor case above.
    await writeFile(
      join(tmp, ".codument-meta.json"),
      JSON.stringify({
        version: "0.13.0",
        initialized: "2026-08-05",
        project: {},
        testCommand: "npm test",
      }),
    );
    await writeFile(join(tmp, "broken.test.ts"), "// a real file so the reference resolves\n");
    await writeFile(
      join(tmp, "src", "auth", "login.ts"),
      "export const login = () => { return 2; };\n",
    );
    await writeFile(
      join(tmp, "findings.json"),
      JSON.stringify({
        invariantsChecked: ["login returns a constant"],
        findings: [
          {
            citation: "src/auth/login.ts:1",
            detail: "wrong constant",
            status: "confirmed",
            failingTest: "broken.test.ts",
          },
        ],
        signer: "test",
      }),
    );
    execFileSync("node", [CLI, "review", "--record", "findings.json"], {
      cwd: tmp,
      encoding: "utf-8",
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    });
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  });

  it("still names the {file}-token reason once a review covers the diff", () => {
    let stdout = "";
    try {
      stdout = execFileSync("node", [CLI, "review", "--require-review"], {
        cwd: tmp,
        encoding: "utf-8",
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      });
    } catch (err) {
      const e = err as { stdout?: string };
      stdout = e.stdout ?? "";
    }
    // Sanity: the outcome-keyed unadjudicated path DID fire (the finding's test
    // could not produce evidence via the refused-then-defaulted runner).
    assert.match(stdout, /could not be adjudicated/);
    // The bug: docs/features/adversarial-review-gate.md says a declared command
    // without `{file}` "is REFUSED and reported, never silently obeyed" — but here
    // the unadjudicated-count message wins the `else if` chain in review.ts and the
    // specific reason (missing {file}) is never printed, even though
    // resolveTestCommand computed it.
    assert.match(stdout, /no \{file\} token/);
  });
});

// ── tautology check: the shipped review-confirm.test.ts assertion proves nothing ──
//
// review-confirm.test.ts "resolveTestCommand (flag > project config > built-in
// default)" > "makeTestRunner picks config up on its own, so a caller that omits
// the command is not silently on tsx" asserts only that `run("nope.test.ts")`
// reports `unrunnable`. `makeTestRunner`'s returned function resolves the test
// PATH before it ever reads `command`:
//
//   const resolved = resolveTestPath(opts.root, testRef, searchDirs);
//   if (!resolved) return { outcome: "unrunnable", detail: `test not found: ${testRef}` };
//
// "nope.test.ts" never exists in that test's tmp dir, so the function returns
// `unrunnable` on the resolution check alone — `command` (and therefore
// `resolveTestCommand`, the very thing the test claims to prove) is never reached.
// This is not itself a functional bug (the demonstration below shows the real
// config-pickup behavior IS correct), but the shipped test would pass unchanged
// against a `makeTestRunner` whose config-resolution line was reverted to the
// pre-plan `opts.command ?? DEFAULT_TEST_COMMAND` — exactly the class of tautology
// this project's own field report (docs/plans/README.md, "Field defects") says a
// prior round already caught once.
describe("tautology check: makeTestRunner config pickup, demonstrated for real", () => {
  let tmp: string;
  let fakeBin: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-runner-pickup-"));
    fakeBin = await makeFakeNpxDir();
    await writeFile(
      join(tmp, ".codument-meta.json"),
      JSON.stringify({
        version: "0.13.0",
        initialized: "2026-08-05",
        project: {},
        testCommand: "node -e process.exit(0) {file}",
      }),
    );
    await writeFile(join(tmp, "real.test.ts"), "// exists\n");
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  });

  it("a REAL test file proves makeTestRunner reads the declared config, not just resolveTestPath's null check", () => {
    const origPath = process.env.PATH;
    // Shadow npx so the BUILT-IN default cannot possibly resolve: if makeTestRunner
    // silently ignored the declared testCommand, this run would come back
    // unrunnable instead of passed.
    process.env.PATH = `${fakeBin}:${origPath ?? ""}`;
    try {
      const run = makeTestRunner({ root: tmp });
      assert.equal(run("real.test.ts").outcome, "passed");
    } finally {
      process.env.PATH = origPath;
    }
  });
});
