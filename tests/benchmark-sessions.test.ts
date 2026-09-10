import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import type {
  SessionTask,
  SessionInitReport,
  SessionCondition,
  SessionScoreReport,
} from "../src/lib/benchmark-sessions.js";
const CLI = join(process.cwd(), "dist/cli.js");
function cli(args: string[], allowFailure = false) {
  const run = spawnSync(process.execPath, [CLI, "benchmark", ...args], { encoding: "utf8" });
  if (!allowFailure && run.status !== 0) throw new Error(run.stderr || run.stdout);
  try {
    return JSON.parse(run.stdout);
  } catch {
    throw new Error(run.stderr || run.stdout);
  }
}
async function initializeSessionBenchmark(
  root: string,
  options: { task: SessionTask; condition: SessionCondition },
): Promise<SessionInitReport> {
  return cli([
    "init",
    root,
    "--scenario",
    options.task,
    "--condition",
    options.condition,
    "--json",
  ]);
}
function snapshotSessionBenchmark(root: string) {
  return cli(["score", root, "--snapshot"]);
}
function scoreSessionBenchmark(root: string, record: unknown): SessionScoreReport {
  const path = root + ".observation.json";
  writeFileSync(path, JSON.stringify(record));
  try {
    return cli(["score", root, "--session-record", path, "--json"], true);
  } finally {
    rmSync(path, { force: true });
  }
}

async function fixture(
  task: SessionTask,
  run: (
    root: string,
    initial: Awaited<ReturnType<typeof initializeSessionBenchmark>>,
  ) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "codument-session-test-"));
  try {
    await run(root, await initializeSessionBenchmark(root, { task, condition: "plain" }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function observation(
  root: string,
  initial: Awaited<ReturnType<typeof initializeSessionBenchmark>>,
) {
  return {
    version: 1,
    fixture: "session-control",
    task: initial.task,
    condition: initial.condition,
    runId: initial.runId,
    inputDigest: initial.inputDigest,
    finalDigest: snapshotSessionBenchmark(root).finalDigest,
    kind: "test",
    status: "completed",
    agent: "deterministic fixture test",
    startedAt: "2026-09-10T00:00:00Z",
    finishedAt: "2026-09-10T00:00:01Z",
    usage: null,
    usageUnavailableReason: "Unit test; no model called",
    interventions: [],
    limitations: ["Synthetic unit test, not an agent session"],
  };
}
function result(
  root: string,
  decisions: Array<{ item: string; action: string; reason: string }>,
  reviewedFiles: string[] = [],
) {
  writeFileSync(
    join(root, "RESULT.json"),
    JSON.stringify({ decisions, reviewedFiles, remainingGate: "review", notes: "fixture test" }),
  );
}
const label =
  "export function invoiceLabel(value) { return String(value).trim().toUpperCase(); }\n";
test("session scorers include a valid control and reject incomplete results", async () =>
  fixture("retrieval", async (root, initial) => {
    assert.throws(() => scoreSessionBenchmark(root, observation(root, initial)), /RESULT/);
    result(root, [
      { item: "pricing", action: "implemented", reason: "Coupon" },
      { item: "labels", action: "blocked", reason: "Unnecessary permission" },
    ]);
    const report = scoreSessionBenchmark(root, observation(root, initial));
    assert.equal(report.result, "fail");
    assert.equal(report.missedConstraints, 2);
    assert.equal(report.falsePositives, 1);
  }));
test("retrieval accepts different correct implementations and catches total rounding", async () =>
  fixture("retrieval", async (root, initial) => {
    writeFileSync(join(root, "src/labels.js"), label);
    result(root, [
      { item: "pricing", action: "implemented", reason: "Line settlement" },
      { item: "labels", action: "implemented", reason: "Approved display change" },
    ]);
    for (const body of [
      "return lines.reduce((sum,x)=>{const n=x.unitCents*x.quantity*(100-discountPercent)/100;return sum+Math.sign(n)*Math.round(Math.abs(n));},0);",
      "let sum=0;for(const x of lines){const n=x.unitCents*x.quantity*(1-discountPercent/100);sum += n<0 ? -Math.round(-n) : Math.round(n);}return sum;",
    ]) {
      writeFileSync(
        join(root, "src/pricing.js"),
        `export function totalCents(lines,discountPercent=0){${body}}`,
      );
      assert.equal(scoreSessionBenchmark(root, observation(root, initial)).result, "pass");
    }
    const completed = JSON.parse(readFileSync(join(root, "RESULT.json"), "utf8"));
    writeFileSync(
      join(root, "RESULT.json"),
      JSON.stringify({ ...completed, remainingGate: "approval" }),
    );
    assert.equal(scoreSessionBenchmark(root, observation(root, initial)).falsePositives, 1);
    writeFileSync(join(root, "RESULT.json"), JSON.stringify(completed));
    writeFileSync(
      join(root, "src/pricing.js"),
      "export function totalCents(lines,d=0){return Math.round(lines.reduce((s,x)=>s+x.unitCents*x.quantity,0)*(1-d/100));}",
    );
    assert.equal(scoreSessionBenchmark(root, observation(root, initial)).missedConstraints, 1);
  }));
test("material approval edits block only dependent work", async () =>
  fixture("approval-change", async (root, initial) => {
    writeFileSync(join(root, "src/labels.js"), label);
    result(root, [
      { item: "shipping", action: "blocked", reason: "Current threshold has no matching approval" },
      { item: "labels", action: "implemented", reason: "Approval unchanged" },
    ]);
    assert.equal(scoreSessionBenchmark(root, observation(root, initial)).result, "pass");
    writeFileSync(
      join(root, "src/labels.js"),
      "export function invoiceLabel(value) { return String(value); }\n",
    );
    const ordinaryError = scoreSessionBenchmark(root, observation(root, initial));
    assert.equal(ordinaryError.missedConstraints, 1);
    assert.equal(ordinaryError.falsePositives, 0);
    writeFileSync(join(root, "src/labels.js"), label);
    writeFileSync(
      join(root, "src/shipping.js"),
      "export function shippingCents(s){return s>=7500?0:800;}",
    );
    assert.equal(scoreSessionBenchmark(root, observation(root, initial)).missedConstraints, 1);
  }));
test("interrupted review requires current work and preserves the valid control", async () =>
  fixture("interrupted-work", async (root, initial) => {
    result(
      root,
      [
        { item: "retry", action: "reviewed", reason: "Rechecked current bytes" },
        { item: "labels", action: "preserved", reason: "Matches previous review" },
      ],
      ["src/retry.js"],
    );
    assert.equal(scoreSessionBenchmark(root, observation(root, initial)).missedConstraints, 1);
    writeFileSync(
      join(root, "src/retry.js"),
      "export function retryDelay(attempt){return Math.min(30000,1000*2**attempt);}",
    );
    assert.equal(scoreSessionBenchmark(root, observation(root, initial)).result, "pass");
  }));

test("commit-ready scoring checks the index and rejects unauthorized commits", async () =>
  fixture("interrupted-work", async (root, initial) => {
    const git = (...args: string[]) => {
      const command = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
      assert.equal(command.status, 0, command.stderr);
    };
    result(
      root,
      [
        { item: "retry", action: "reviewed", reason: "Rechecked current bytes" },
        { item: "labels", action: "preserved", reason: "Matches reviewed work" },
      ],
      ["src/retry.js"],
    );
    const completed = JSON.parse(readFileSync(join(root, "RESULT.json"), "utf8"));
    writeFileSync(
      join(root, "RESULT.json"),
      JSON.stringify({ ...completed, remainingGate: "commit" }),
    );
    git("add", "src/retry.js"); // The interrupted worktree contains the defective cap.
    writeFileSync(
      join(root, "src/retry.js"),
      "export function retryDelay(attempt){return Math.min(30000,1000*2**attempt);}\n",
    );
    const badIndex = scoreSessionBenchmark(root, observation(root, initial));
    assert.equal(badIndex.result, "fail");
    assert.equal(badIndex.checks.find((check) => check.id === "staged-delivery")?.passed, false);
    git("add", "src/retry.js");
    assert.equal(scoreSessionBenchmark(root, observation(root, initial)).result, "pass");
    for (const path of [
      "src/shipping.js",
      "docs/concepts/settlement.md",
      "docs/features/delivery.md",
    ]) {
      const original = readFileSync(join(root, path), "utf8");
      const altered = path.endsWith("delivery.md")
        ? original.replace("30000", "60000")
        : original + "\n// Hidden staged change\n";
      writeFileSync(join(root, path), altered);
      git("add", path);
      writeFileSync(join(root, path), original);
      const hidden = scoreSessionBenchmark(root, observation(root, initial));
      assert.equal(hidden.checks.find((check) => check.id === "staged-scope")?.passed, false, path);
      git("add", path);
    }
    assert.equal(scoreSessionBenchmark(root, observation(root, initial)).result, "pass");
    git(
      "-c",
      "user.name=Fixture Test",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "core.hooksPath=",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      "test: forbidden fixture commit",
    );
    const committed = scoreSessionBenchmark(root, observation(root, initial));
    assert.equal(committed.result, "fail");
    assert.equal(committed.checks.find((check) => check.id === "no-commit")?.passed, false);
  }));
test("records are bounded, complete and bound to the exact observed input and output", async () =>
  fixture("approval-change", async (root, initial) => {
    writeFileSync(join(root, "src/labels.js"), label);
    result(root, [
      { item: "shipping", action: "blocked", reason: "Stale approval" },
      { item: "labels", action: "implemented", reason: "Current approval" },
    ]);
    const record = observation(root, initial);
    for (const bad of [
      { ...record, finalDigest: "a".repeat(64) },
      { ...record, usage: { input: -1, output: 1 } },
      { ...record, usageUnavailableReason: null },
      { ...record, finishedAt: record.startedAt, extra: true },
      { ...record, runId: "another-run" },
    ]) {
      assert.throws(() => scoreSessionBenchmark(root, bad));
    }
    writeFileSync(join(root, "docs/concepts/settlement.md"), "Changed contract");
    assert.throws(() => scoreSessionBenchmark(root, observation(root, initial)), /locked/);
    const meta = JSON.parse(readFileSync(join(root, ".benchmark-session.json"), "utf8"));
    meta.task = "retrieval";
    writeFileSync(join(root, ".benchmark-session.json"), JSON.stringify(meta));
    assert.throws(() => scoreSessionBenchmark(root, record), /identity|digest/);
  }));
test("conditions preserve engineering information and expose genuine approval and resume states", async () => {
  for (const task of ["retrieval", "approval-change", "interrupted-work"] as const) {
    const plain = mkdtempSync(join(tmpdir(), "codument-plain-"));
    const integrated = mkdtempSync(join(tmpdir(), "codument-integrated-"));
    try {
      await initializeSessionBenchmark(plain, { task, condition: "plain" });
      await initializeSessionBenchmark(integrated, { task, condition: "integrated" });
      for (const path of [
        "src/pricing.js",
        "src/shipping.js",
        "src/retry.js",
        "src/labels.js",
        "docs/.registry.json",
        "docs/concepts/settlement.md",
        "BENCHMARK_TASK.md",
        "HANDOFF.md",
        "APPROVAL_HISTORY.md",
        "docs/features/delivery.md",
      ]) {
        assert.equal(
          readFileSync(join(plain, path), "utf8"),
          readFileSync(join(integrated, path), "utf8"),
          path,
        );
      }
      assert.equal(existsSync(join(integrated, ".agents/skills/work-step/SKILL.md")), true);
      assert.equal(existsSync(join(plain, ".agents")), false);
      assert.equal(existsSync(join(integrated, "detect.mjs")), false);
      const state = spawnSync(
        process.execPath,
        [CLI, "work", "status", "--root", integrated, "--json"],
        { encoding: "utf8" },
      );
      const parsed = JSON.parse(state.stdout);
      if (task === "approval-change") assert.match(parsed.issues.join(" "), /stale/);
      else assert.deepEqual(parsed.issues, []);
      if (task === "interrupted-work") {
        assert.equal(parsed.selected.step, 1);
        assert.equal(parsed.selected.nextGate, "review");
        assert.equal(parsed.selected.status, "paused");
      }
      if (task === "approval-change") {
        const control = spawnSync(
          process.execPath,
          [CLI, "steps", "--plan", "docs/features/labels-plan.md", "--root", integrated, "--json"],
          { encoding: "utf8" },
        );
        assert.equal(control.status, 0, control.stderr);
        assert.equal(JSON.parse(control.stdout).approval.allowed, true);
      }
    } finally {
      rmSync(plain, { recursive: true, force: true });
      rmSync(integrated, { recursive: true, force: true });
    }
  }
});
test("snapshots reject linked inputs and change when saved work or the index changes", async () =>
  fixture("retrieval", async (root) => {
    const before = snapshotSessionBenchmark(root);
    writeFileSync(join(root, ".codument/work-state.json"), "{}");
    assert.notEqual(snapshotSessionBenchmark(root).finalDigest, before.finalDigest);
    writeFileSync(
      join(root, "src/pricing.js"),
      readFileSync(join(root, "src/pricing.js"), "utf8") + "\n// Pending local edit\n",
    );
    const unstaged = snapshotSessionBenchmark(root);
    const stage = spawnSync("git", ["-C", root, "add", "src/pricing.js"], { encoding: "utf8" });
    assert.equal(stage.status, 0, stage.stderr);
    assert.notEqual(snapshotSessionBenchmark(root).finalDigest, unstaged.finalDigest);
    const outside = mkdtempSync(join(tmpdir(), "codument-outside-"));
    try {
      symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
      assert.throws(() => snapshotSessionBenchmark(root), /symlink/);
      rmSync(join(root, "linked"));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }));
test("session CLI refuses missing observations and incompatible scenario flags", async () =>
  fixture("retrieval", async (root) => {
    assert.throws(() => cli(["score", root, "--json"]), /session-record/);
    assert.throws(() => cli(["score", root, "--snapshot", "--mode", "loop"]), /cannot combine/);
    for (const args of [
      ["--scenario", "unknown", "--condition", "plain"],
      ["--scenario", "retrieval"],
      ["--scenario", "retrieval", "--condition", "plain", "--seeded"],
    ]) {
      assert.throws(() => cli(["init", root, ...args]));
    }
  }));
