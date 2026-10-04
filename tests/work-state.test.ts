import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, it } from "node:test";
import { approvePlan } from "../src/lib/plan-approval.js";
import { transitionWork, inspectWorkState, readWorkState, workPlanSelection } from "../src/lib/work-state.js";

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
  it("keeps the saved milestone through checked implementation and pending gates without writing state", () => {
    transitionWork(root, "start", { plan: path });
    writeFileSync(join(root, path), readFileSync(join(root, path), "utf8").replaceAll("- [ ]", "- [x]"));
    const saved = readFileSync(join(root, ".codument/work-state.json"), "utf8");
    const work = inspectWorkState(root);
    assert.equal(work.selected?.step, 1);
    assert.equal(work.progress?.step, 1);
    assert.equal(work.progress?.nextGate, "verify");
    assert.equal(work.progress?.canExecute, false);
    assert.deepEqual(work.progress?.steps.map((step) => [step.implemented, step.status, step.delivered]), [
      [true, "in_progress", null], [true, "pending", null],
    ]);
    assert.equal(readFileSync(join(root, ".codument/work-state.json"), "utf8"), saved);
    transitionWork(root, "pause", { reason: "Review pending", gate: "review" });
    const paused = inspectWorkState(root).progress;
    assert.equal(paused?.nextGate, "review");
    assert.equal(paused?.steps[0].status, "pending");
    assert.equal(paused?.interruption?.reason, "Review pending");
    transitionWork(root, "resume", {});
    assert.equal(inspectWorkState(root).progress?.nextGate, "review");
  });

  it("preserves a useful prior advancement checkpoint without inventing exact commit proof", () => {
    const state = transitionWork(root, "start", { plan: path });
    state.records[0].step = 2;
    writeFileSync(join(root, ".codument/work-state.json"), JSON.stringify(state));
    writeFileSync(join(root, path), readFileSync(join(root, path), "utf8").replaceAll("- [ ]", "- [x]"));
    const progress = inspectWorkState(root).progress;
    assert.equal(progress?.steps[0].status, "completed");
    assert.equal(progress?.steps[0].delivered, null);
    assert.equal(progress?.steps[1].status, "in_progress");
    assert.equal(progress?.delivery, null);
  });

  it("does not extend a completed checkpoint to an appended unapproved milestone", () => {
    const state = transitionWork(root, "start", { plan: path });
    state.records[0].status = "completed";
    state.records[0].step = null;
    writeFileSync(join(root, ".codument/work-state.json"), JSON.stringify(state));
    writeFileSync(join(root, path), readFileSync(join(root, path), "utf8").replaceAll("- [ ]", "- [x]").replace("### Scope", "- [ ] Unapproved next milestone\n\n### Scope"));
    const saved = readFileSync(join(root, ".codument/work-state.json"), "utf8");
    const work = inspectWorkState(root);
    assert.equal(work.selected?.status, "completed");
    assert.equal(work.progress?.steps[2].implemented, false);
    assert.equal(work.progress?.steps[2].status, "pending");
    assert.equal(work.progress?.steps[2].delivered, null);
    assert.equal(work.progress?.canExecute, false);
    assert.match(work.issues.join(" "), /approval.*stale/);
    assert.throws(() => transitionWork(root, "resume", { plan: path }), /current approval|completed work/);
    assert.equal(readFileSync(join(root, ".codument/work-state.json"), "utf8"), saved);
  });

  it("previews a new live identity on an archived selected page while default handoff retains the archive", () => {
    const state = transitionWork(root, "start", { plan: path });
    const old = state.records[0];
    old.status = "completed";
    old.step = null;
    writeFileSync(join(root, ".codument/work-state.json"), JSON.stringify(state));
    const approvalsPath = join(root, "docs/.approvals.json");
    const approvals = JSON.parse(readFileSync(approvalsPath, "utf8"));
    approvals.records[0].finalDelivery = { base: "a".repeat(40), fingerprint: "b".repeat(64) };
    writeFileSync(approvalsPath, JSON.stringify(approvals));
    writeFileSync(join(root, path), "# Alpha\n\n## Delivery Plan\nPlan-ID: new-live\nStatus: draft\n\n- [ ] New milestone\n");
    const before = readFileSync(join(root, ".codument/work-state.json"), "utf8");
    assert.equal(inspectWorkState(root).progress?.planId, old.planId);
    assert.deepEqual(workPlanSelection(root, { plan: path }), { plan: path, planId: "new-live" });
    const preview = inspectWorkState(root, { plan: path });
    assert.equal(preview.selected?.planId, old.planId);
    assert.equal(preview.progress?.planId, "new-live");
    assert.equal(preview.progress?.selection, "preview");
    assert.equal(preview.progress?.canExecute, false);
    assert.equal(preview.progress?.steps[0].text, "New milestone");
    writeFileSync(join(root, path), readFileSync(join(root, path), "utf8").replace("- [ ] New milestone", "- [x] New milestone"));
    const implementedPreview = inspectWorkState(root, { plan: path });
    assert.deepEqual(workPlanSelection(root, { plan: path }), { plan: path, planId: "new-live" });
    assert.equal(implementedPreview.progress?.planId, "new-live");
    assert.equal(implementedPreview.progress?.selection, "preview");
    assert.equal(implementedPreview.progress?.canExecute, false);
    assert.equal(implementedPreview.progress?.steps[0].implemented, true);
    assert.equal(implementedPreview.progress?.steps[0].delivered, null);
    assert.equal(inspectWorkState(root).progress?.planId, old.planId);
    assert.equal(readFileSync(join(root, ".codument/work-state.json"), "utf8"), before);
  });

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
