import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, it } from "node:test";
import { approvePlan } from "../src/lib/plan-approval.js";
import { transitionWork, inspectWorkState, readWorkState } from "../src/lib/work-state.js";

let root: string;
const path = "docs/features/alpha.md";
const plan =
  "## Delivery Plan\nStatus: approved\n\n- [ ] Implement\n- [ ] Verify\n\n### Scope\n- `src/alpha.ts`\n";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codument-work-state-"));
  mkdirSync(join(root, "docs/features"), { recursive: true });
  writeFileSync(join(root, path), plan);
  approvePlan(root, path, { signer: "human" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("durable work selection", () => {
  it("resumes explicitly selected final-step work that still owes review", () => {
    transitionWork(root, "start", { plan: path });
    writeFileSync(
      join(root, path),
      readFileSync(join(root, path), "utf8").replaceAll("- [ ]", "- [x]"),
    );
    transitionWork(root, "pause", { reason: "Review pending", gate: "review" });
    transitionWork(root, "resume", { plan: path });
    assert.equal(inspectWorkState(root).selected?.nextGate, "review");
  });
  it("does not ignore explicit section selection or restart completed work", () => {
    assert.throws(() => transitionWork(root, "start", { planId: "unknown" }), /plan path/);
    const state = transitionWork(root, "start", { plan: path });
    state.records[0].status = "completed";
    state.records[0].step = null;
    writeFileSync(join(root, ".codument/work-state.json"), JSON.stringify(state));
    assert.throws(() => transitionWork(root, "resume", { plan: path }), /completed work/);
  });
  it("preserves approval and the pending gate through pause, block and resume", () => {
    const started = transitionWork(root, "start", { plan: path });
    assert.equal(started.records[0].status, "active");
    const approval = readFileSync(join(root, "docs/.approvals.json"), "utf8");
    transitionWork(root, "pause", { reason: "Human requested a break", gate: "review" });
    const before = readFileSync(join(root, ".codument/work-state.json"), "utf8");
    assert.equal(inspectWorkState(root).selected?.status, "paused");
    assert.equal(readFileSync(join(root, ".codument/work-state.json"), "utf8"), before);
    transitionWork(root, "resume", {});
    assert.equal(inspectWorkState(root).selected?.nextGate, "review");
    transitionWork(root, "block", {
      reason: "Fixture unavailable",
      resumeCondition: "Fixture restored",
    });
    assert.equal(inspectWorkState(root).selected?.status, "blocked");
    transitionWork(root, "resume", {});
    assert.equal(inspectWorkState(root).selected?.status, "active");
    assert.equal(readFileSync(join(root, "docs/.approvals.json"), "utf8"), approval);
  });

  it("requires a reason to switch and preserves the interrupted plan", () => {
    transitionWork(root, "start", { plan: path });
    const second = "docs/features/beta.md";
    writeFileSync(join(root, second), plan);
    approvePlan(root, second, { signer: "human" });
    assert.throws(() => transitionWork(root, "start", { plan: second }), /requires a reason/);
    const switched = transitionWork(root, "start", {
      plan: second,
      reason: "Prioritize the prerequisite",
    });
    assert.equal(switched.records.filter((row) => row.status === "active").length, 1);
    assert.equal(switched.records.find((row) => row.path === path)?.status, "paused");
    transitionWork(root, "resume", { plan: path, reason: "Prerequisite inspected" });
    assert.equal(inspectWorkState(root).selected?.path, path);
    assert.equal(readWorkState(root).records.find((row) => row.path === second)?.status, "paused");
  });

  it("supersession names a replacement and cannot silently resume the old work", () => {
    transitionWork(root, "start", { plan: path });
    const second = "docs/features/beta.md";
    writeFileSync(join(root, second), plan);
    const replacement = approvePlan(root, second, { signer: "human" });
    const state = transitionWork(root, "supersede", {
      plan: second,
      reason: "Approved replacement",
    });
    const old = state.records.find((row) => row.path === path)!;
    assert.equal(old.status, "superseded");
    assert.equal(old.replacement, replacement.planId);
    assert.throws(
      () => transitionWork(root, "resume", { plan: path, reason: "Retry" }),
      /superseded/,
    );
    assert.equal(inspectWorkState(root).selected?.path, second);
  });

  it("does not overwrite corrupt, foreign-root or conflicting work state", () => {
    const state = transitionWork(root, "start", { plan: path });
    const file = join(root, ".codument/work-state.json");
    const before = readFileSync(file, "utf8");
    assert.throws(
      () => transitionWork(root, "pause", { reason: "Break", expectedRevision: 0 }),
      /another writer/,
    );
    assert.equal(readFileSync(file, "utf8"), before);
    writeFileSync(join(root, ".codument/work-state.json.lock"), "");
    assert.throws(() => transitionWork(root, "pause", { reason: "Break" }), /writer lock/);
    rmSync(join(root, ".codument/work-state.json.lock"));
    for (const malformed of [
      "{",
      JSON.stringify({ ...state, root: join(root, "other") }),
      JSON.stringify({ ...state, records: [...state.records, ...state.records] }),
      JSON.stringify({ ...state, selected: "missing" }),
    ]) {
      writeFileSync(file, malformed);
      assert.throws(() => transitionWork(root, "start", { plan: path }), /work state/);
      assert.equal(readFileSync(file, "utf8"), malformed);
    }
  });

  it("reports stale approval without changing saved state and requires fresh approval to resume", () => {
    transitionWork(root, "start", { plan: path });
    transitionWork(root, "pause", { reason: "Scope question" });
    const saved = readFileSync(join(root, ".codument/work-state.json"), "utf8");
    writeFileSync(
      join(root, path),
      readFileSync(join(root, path), "utf8").replace("Implement", "Change the public interface"),
    );
    assert.match(inspectWorkState(root).issues.join(" "), /approval.*stale/);
    assert.throws(() => transitionWork(root, "resume", {}), /current approval/);
    assert.equal(readFileSync(join(root, ".codument/work-state.json"), "utf8"), saved);
    approvePlan(root, path, { signer: "human approves changed scope" });
    transitionWork(root, "resume", {});
    assert.deepEqual(inspectWorkState(root).issues, []);
  });

  it("requires a resume condition for blocking and refuses unverified readiness", () => {
    transitionWork(root, "start", { plan: path });
    assert.throws(
      () => transitionWork(root, "block", { reason: "Fixture unavailable" }),
      /resume condition/,
    );
    assert.throws(() => transitionWork(root, "finish", {}), /not complete/);
    writeFileSync(
      join(root, path),
      readFileSync(join(root, path), "utf8").replace("- [ ] Implement", "- [x] Implement"),
    );
    assert.throws(() => transitionWork(root, "finish", {}), /codument verify/);
    assert.throws(() => transitionWork(root, "start", { plan: path }), /previous step/);
    assert.equal(inspectWorkState(root).selected?.status, "active");
  });
});
