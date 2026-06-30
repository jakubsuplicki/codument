import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync, mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  confirmFindings,
  resolveTestPath,
  makeTestRunner,
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
    assert.equal(
      resolveTestPath(tmp, "root-level.test.ts", ["", "tests"]),
      join(tmp, "root-level.test.ts"),
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

  it("still resolves a symlink whose target stays inside root", () => {
    writeFileSync(join(tmp, "real.test.ts"), "");
    symlinkSync(join(tmp, "real.test.ts"), join(tmp, "link.test.ts"));
    assert.equal(resolveTestPath(tmp, "link.test.ts", [""]), join(tmp, "link.test.ts"));
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
});
