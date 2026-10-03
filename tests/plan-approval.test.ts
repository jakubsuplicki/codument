import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { approvePlan, readApprovalStore, finalApprovalScope } from "../src/lib/plan-approval.js";
import { loadPlan, parseDeliveryPlan, parsePlanScope } from "../src/lib/plan-steps.js";
import { parseFeatureMap } from "../src/lib/feature-map.js";
import { detectApprovedPlanScopeFromDocuments } from "../src/lib/change-state.js";

const path = "docs/features/alpha.md";
const plan =
  "# Alpha\n\n## Delivery Plan\nStatus: approved\n\n- [ ] Build the reader\n- [ ] Verify the reader\n\n### Scope\n- `src/alpha.ts`\n\n### Outcome\nRead valid records and diagnose invalid inputs.\n";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codument-approval-"));
  mkdirSync(join(root, "docs/features"), { recursive: true });
  writeFileSync(join(root, path), plan);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("revision-bound plan approval", () => {
  const outcome = plan.replace("Status: approved", "Status: approved\nApproval-Model: outcome-v1") +
    "\n### Constraints & non-goals\nKeep compatibility, privacy and spending unchanged.\n" +
    "\n### Acceptance evidence\nInspect valid and invalid records.\n" +
    "\n### Verification\nRun the reader checks.\n";

  it("preserves outcome permission through advisory file and routing discoveries", () => {
    writeFileSync(join(root, path), outcome);
    const record = approvePlan(root, path, { signer: "human" });
    const identified = readFileSync(join(root, path), "utf8");
    writeFileSync(join(root, path), identified.replace("src/alpha.ts", "src/discovered.ts") +
      "\n### Feature Map\n```feature-map\nsrc/discovered.ts | alpha | feature | reader\n```\n" +
      "\n### Implementation notes\nUse the shared parser.\n");
    assert.equal(loadPlan(root, path)?.approved, true);
    assert.equal(loadPlan(root, path)?.approval?.digest, record.digest);
    const projection = detectApprovedPlanScopeFromDocuments([{ path, content: readFileSync(join(root, path), "utf8") }], { approvals: readApprovalStore(root), requireBoundApproval: true });
    assert.equal(projection?.approvalModel, "outcome-v1");
    assert.deepEqual(projection?.scope, ["src/discovered.ts"]);
    assert.equal(finalApprovalScope(record).approvalModel, "outcome-v1");
  });

  it("binds outcome, milestones, constraints, acceptance, verification and other intent", () => {
    writeFileSync(join(root, path), outcome);
    approvePlan(root, path, { signer: "human" });
    const approved = readFileSync(join(root, path), "utf8");
    for (const changed of [
      approved.replace("Read valid records", "Accept every record"),
      approved.replace("Build the reader", "Build the writer"),
      approved.replace("Keep compatibility", "Break compatibility"),
      approved.replace("Inspect valid", "Skip valid"),
      approved.replace("Run the reader checks", "Skip the reader checks"),
      approved + "\n### Decisions\nUpload records.\n",
      approved.replace("outcome-v1", "legacy"),
    ]) {
      writeFileSync(join(root, path), changed);
      assert.equal(loadPlan(root, path)?.approved, false);
    }
  });

  it("requires explicit renewed approval to adopt outcome permission", () => {
    writeFileSync(join(root, path), outcome);
    assert.equal(loadPlan(root, path)?.approved, false, "outcome status alone never grants permission");
    writeFileSync(join(root, path), plan);
    approvePlan(root, path, { signer: "human" });
    writeFileSync(join(root, path), readFileSync(join(root, path), "utf8").replace("Status: approved", "Status: approved\nApproval-Model: outcome-v1") +
      outcome.slice(outcome.indexOf("### Constraints")));
    assert.equal(loadPlan(root, path)?.approved, false);
    approvePlan(root, path, { signer: "human after renewed approval" });
    assert.equal(loadPlan(root, path)?.approved, true);
  });

  it("refuses unsupported or incomplete outcome contracts and advisory executable work", () => {
    for (const invalid of [
      outcome.replace("outcome-v1", "outcome-v2"),
      outcome.replace("Approval-Model: outcome-v1", "Approval-Model: outcome-v1\nApproval-Model: outcome-v1"),
      outcome.replace("### Verification\nRun the reader checks.", ""),
      outcome + "\n### Outcome\nAnother outcome.\n",
      outcome.replace("- `src/alpha.ts`", "- [ ] Execute unapproved extra work"),
      outcome.replace("### Outcome\nRead valid records and diagnose invalid inputs.", "### Outcome\n<!-- later -->"),
      outcome.replace("Read valid records and diagnose invalid inputs.", "Plan-ID: example"),
      outcome.replace("Read valid records and diagnose invalid inputs.", "#### Resume checkpoint\nRead later."),
    ]) {
      writeFileSync(join(root, path), invalid);
      assert.throws(() => approvePlan(root, path, { signer: "human" }), /approval model|outcome contract|advisory/i);
    }
  });

  it("retains an outcome plan identity without any file guidance", () => {
    writeFileSync(join(root, path), outcome.replace("### Scope\n- `src/alpha.ts`\n", ""));
    approvePlan(root, path, { signer: "human" });
    const projection = detectApprovedPlanScopeFromDocuments([{ path, content: readFileSync(join(root, path), "utf8") }], { approvals: readApprovalStore(root), requireBoundApproval: true });
    assert.ok(projection?.approvalDigest);
    assert.deepEqual(projection?.scope, []);
  });

  it("never reinterprets an older record that already contained the model declaration", () => {
    writeFileSync(join(root, path), outcome.replace("### Scope\n- `src/alpha.ts`\n", ""));
    approvePlan(root, path, { signer: "human" });
    const stored = readApprovalStore(root);
    delete stored.records[0].approvalModel;
    writeFileSync(join(root, "docs/.approvals.json"), JSON.stringify(stored));
    assert.equal(loadPlan(root, path)?.approved, false);
    assert.equal(finalApprovalScope(stored.records[0]).approvalModel, undefined);
    const renewed = approvePlan(root, path, { signer: "human after model approval" });
    assert.equal(renewed.revision, stored.revision + 1);
    assert.equal(renewed.approvalModel, "outcome-v1");
    assert.equal(loadPlan(root, path)?.approved, true);
  });

  it("keeps normative map examples bound while excluding only live outcome routing", () => {
    const example = "\n### Decisions\n````markdown\n```feature-map\nsrc/private.ts | private | feature | keep-private\n```\n````\n";
    writeFileSync(join(root, path), outcome + example);
    approvePlan(root, path, { signer: "human" });
    const approved = readFileSync(join(root, path), "utf8");
    assert.equal(parseFeatureMap(approved).rows.length, 0);
    writeFileSync(join(root, path), approved.replace("keep-private", "upload-all-data"));
    assert.equal(loadPlan(root, path)?.approved, false);
  });

  it("keeps supported sibling Scope advisory for a standalone outcome plan", () => {
    const standalone = "# Alpha\nStatus: approved\n\n## Scope\n- `src/alpha.ts`\n\n" +
      outcome.replace("Status: approved\n", "").replace("### Scope\n- `src/alpha.ts`\n", "");
    writeFileSync(join(root, path), standalone);
    approvePlan(root, path, { signer: "human" });
    const approved = readFileSync(join(root, path), "utf8");
    assert.deepEqual(parsePlanScope(approved), ["src/alpha.ts"]);
    writeFileSync(join(root, path), approved.replace("src/alpha.ts", "src/beta.ts"));
    assert.equal(loadPlan(root, path)?.approved, true);
  });

  it("keeps consumed Scope heading variants advisory without hiding executable work", () => {
    for (const heading of ["### Scope (implementation guidance)", "#### Scope details"]) {
      writeFileSync(join(root, path), outcome.replace("### Scope", heading));
      approvePlan(root, path, { signer: "human" });
      const approved = readFileSync(join(root, path), "utf8");
      assert.deepEqual(parsePlanScope(approved), ["src/alpha.ts"]);
      writeFileSync(join(root, path), approved.replace("src/alpha.ts", "src/discovered.ts"));
      assert.equal(loadPlan(root, path)?.approved, true);
      writeFileSync(join(root, path), approved.replace("- `src/alpha.ts`", "- [ ] Extra work"));
      assert.throws(() => approvePlan(root, path, { signer: "human" }), /advisory/i);
    }
  });

  it("retains outer Scope boundaries through nested routing headings", () => {
    const nested = outcome.replace("- `src/alpha.ts`", "#### Scope details\n- `src/alpha.ts`\n#### Further guidance\n- `src/beta.ts`");
    writeFileSync(join(root, path), nested);
    approvePlan(root, path, { signer: "human" });
    const approved = readFileSync(join(root, path), "utf8");
    assert.deepEqual(parsePlanScope(approved), ["src/alpha.ts", "src/beta.ts"]);
    writeFileSync(join(root, path), approved.replace("src/beta.ts", "src/discovered.ts"));
    assert.equal(loadPlan(root, path)?.approved, true);
  });

  it("binds normative decisions following a valid longer Map fence closer", () => {
    const mapped = outcome + "\n```feature-map\nsrc/alpha.ts | alpha | feature | reader\n````\n### Decisions\nKeep every read private.\n";
    writeFileSync(join(root, path), mapped);
    approvePlan(root, path, { signer: "human" });
    const approved = readFileSync(join(root, path), "utf8");
    assert.equal(parseFeatureMap(approved).errors.length, 0);
    assert.equal(parseFeatureMap(approved).rows.length, 1);
    writeFileSync(join(root, path), approved.replace("Keep every read private.", "Upload every read."));
    assert.equal(loadPlan(root, path)?.approved, false);
  });

  it("retains Map-only source guidance in archived approval", () => {
    writeFileSync(join(root, path), plan + "\n## Feature Map\n```feature-map\nsrc/catalogue.ts | catalogue | feature | Catalogue\n```\n");
    const record = approvePlan(root, path, { signer: "human" });
    assert.deepEqual(finalApprovalScope(record).scope, ["src/alpha.ts", "src/catalogue.ts"]);
  });
  it("binds a supported sibling Feature Map consumed outside the delivery section", () => {
    putSibling("alpha");
    approvePlan(root, path, { signer: "human" });
    const recorded = readFileSync(join(root, path), "utf8");
    writeFileSync(join(root, path), recorded.replace("| alpha |", "| beta |"));
    assert.equal(parseFeatureMap(readFileSync(join(root, path), "utf8")).rows[0].feature, "beta");
    assert.equal(loadPlan(root, path)?.approval?.state, "stale");
    function putSibling(feature: string) {
      writeFileSync(join(root, path), plan + `\n## Feature Map\n\`\`\`feature-map\nsrc/alpha.ts | ${feature} | feature | reader\n\`\`\`\n`);
    }
  });
  it("retains approval through progress and line endings but stales changed scope", () => {
    const recorded = approvePlan(root, path, { signer: "human via explicit command" });
    assert.equal(loadPlan(root, path)?.approval?.state, "bound");
    assert.equal(loadPlan(root, path)?.planId, recorded.planId);
    const approved = readFileSync(join(root, path), "utf8");
    writeFileSync(
      join(root, path),
      (
        approved.replace("- [ ] Build", "- [x] Build") +
        "\n### Resume checkpoint\nNext gate: review\n"
      ).replace(/\n/g, "\r\n"),
    );
    assert.equal(loadPlan(root, path)?.approved, true);
    writeFileSync(join(root, path), approved.replace("src/alpha.ts", "src/beta.ts"));
    assert.equal(loadPlan(root, path)?.approved, false);
    assert.equal(loadPlan(root, path)?.approval?.state, "stale");
    assert.equal(readApprovalStore(root).records[0].digest, recorded.digest);
  });

  it("diagnoses legacy plans and supports explicit opt-in without silently upgrading approval", () => {
    assert.equal(loadPlan(root, path)?.approval?.state, "unbound");
    assert.equal(loadPlan(root, path)?.approved, true);
    writeFileSync(
      join(root, ".codument-meta.json"),
      JSON.stringify({ requireBoundApproval: true }),
    );
    assert.equal(loadPlan(root, path)?.approved, false);
    approvePlan(root, path, { signer: "human" });
    assert.equal(loadPlan(root, path)?.approved, true);
  });

  it("never downgrades a previously bound document when its identifier or record disappears", () => {
    approvePlan(root, path, { signer: "human" });
    const identified = readFileSync(join(root, path), "utf8");
    writeFileSync(join(root, path), plan);
    assert.equal(loadPlan(root, path)?.approved, false);
    writeFileSync(join(root, path), identified);
    rmSync(join(root, "docs/.approvals.json"));
    assert.equal(loadPlan(root, path)?.approved, false);
  });

  it("rejects corrupt, inconsistent, unknown-version and duplicate approval records", () => {
    approvePlan(root, path, { signer: "human" });
    const stored = readApprovalStore(root);
    for (const value of [
      "{",
      JSON.stringify({ ...stored, version: 2 }),
      JSON.stringify({ ...stored, records: [...stored.records, ...stored.records] }),
      JSON.stringify({
        ...stored,
        records: [{ ...stored.records[0], contract: "different scope" }],
      }),
    ]) {
      writeFileSync(join(root, "docs/.approvals.json"), value);
      assert.throws(() => loadPlan(root, path), /malformed|inconsistent/);
    }
  });

  it("refuses conflicting revisions and an existing writer lock without overwriting state", () => {
    approvePlan(root, path, { signer: "human" });
    const before = readFileSync(join(root, "docs/.approvals.json"), "utf8");
    assert.throws(
      () => approvePlan(root, path, { signer: "human", expectedRevision: 0 }),
      /another writer/,
    );
    writeFileSync(join(root, "docs/.approvals.json.lock"), "");
    assert.throws(() => approvePlan(root, path, { signer: "human" }), /writer lock/);
    assert.equal(readFileSync(join(root, "docs/.approvals.json"), "utf8"), before);
  });

  it("records idempotently and invalidates changes to steps, examples, decisions and outcomes", () => {
    approvePlan(root, path, { signer: "human" });
    const before = readFileSync(join(root, "docs/.approvals.json"), "utf8");
    approvePlan(root, path, { signer: "another recorder" });
    assert.equal(readFileSync(join(root, "docs/.approvals.json"), "utf8"), before);
    const identified = readFileSync(join(root, path), "utf8");
    for (const changed of [
      identified.replace("Build the reader", "Build a writer"),
      identified.replace("Read valid records", "Accept all records"),
      identified + "\n### Decisions\nStore remote copies.\n",
      identified + "\n```\nStatus: approved\n```\n",
    ]) {
      writeFileSync(join(root, path), changed);
      assert.equal(loadPlan(root, path)?.approval?.state, "stale");
    }
  });

  it("keeps checkpoint examples out of scope, maps and step execution", () => {
    approvePlan(root, path, { signer: "human" });
    const checkpoint =
      readFileSync(join(root, path), "utf8") +
      "\n### Resume checkpoint\n- [ ] unrelated work\n#### Scope\n- `src/beta.ts`\n#### Feature Map\n```feature-map\nsrc/beta.ts | beta | feature | unrelated\n```\n";
    writeFileSync(join(root, path), checkpoint);
    assert.equal(loadPlan(root, path)?.approved, true);
    assert.equal(parseDeliveryPlan(checkpoint).length, 2);
    assert.deepEqual(parsePlanScope(checkpoint), ["src/alpha.ts"]);
    assert.equal(parseFeatureMap(checkpoint).rows.length, 0);
  });

  it("selects the same identified section for approval, steps, scope and map", () => {
    const first = plan.replace("Status: approved", "Plan-ID: first\nStatus: approved");
    const second =
      plan
        .replace("# Alpha\n\n", "")
        .replace("Status: approved", "Plan-ID: second\nStatus: approved")
        .replaceAll("alpha.ts", "beta.ts") +
      "\n### Feature Map\n```feature-map\nsrc/beta.ts | beta | feature | reader\n```\n";
    writeFileSync(join(root, path), first + "\n" + second);
    assert.throws(() => approvePlan(root, path, { signer: "human" }), /plan-id/);
    approvePlan(root, path, { planId: "second", signer: "human" });
    assert.throws(() => loadPlan(root, path), /plan-id/);
    assert.throws(() => detectApprovedPlanScopeFromDocuments([{ path, content: readFileSync(join(root, path), "utf8") }], { approvals: readApprovalStore(root), requireBoundApproval: true }), /plan-id/);
    assert.equal(loadPlan(root, path, "second")?.approved, true);
    assert.equal(loadPlan(root, path, "first")?.approved, false);
    const markdown = readFileSync(join(root, path), "utf8");
    assert.deepEqual(parsePlanScope(markdown, "second"), ["src/beta.ts"]);
    assert.equal(parseFeatureMap(markdown, "second").rows[0].feature, "beta");
    assert.throws(() => loadPlan(root, path, "unknown"), /expected one section/);
  });
});
