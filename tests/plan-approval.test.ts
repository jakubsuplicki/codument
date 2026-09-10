import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { approvePlan, readApprovalStore } from "../src/lib/plan-approval.js";
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
