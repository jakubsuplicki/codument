import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { contextCommand } from "../src/commands/context.js";
import { mapRoute } from "../src/commands/map.js";
import type { ChangeSet } from "../src/lib/change-set.js";
import { parseFeatureMap } from "../src/lib/feature-map.js";
import {
  approvalDigest,
  finalApprovalScope,
  finalDeliveryFingerprint,
  readApprovalStore,
  retainedPlanMarkdown,
  type PlanApprovalRecord,
} from "../src/lib/plan-approval.js";
import { identifyPlan, planContractMarkdown } from "../src/lib/plan-steps.js";
import { workPlanContext, workPlanMarkdown } from "../src/lib/work-state.js";

const planPath = "docs/features/alpha.md";
const planId = "archived-alpha";
const compacted = "# Alpha\n\n## In plain terms\nReturns an alpha value.\n";
const nestedMap = "\n### Notes\n````markdown\n```feature-map\nsrc/nested.ts | nested | feature | historical example mapping\n```\n````\n";
let root: string;

function put(path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function archive(contract: string, approvalModel?: "outcome-v1"): PlanApprovalRecord {
  const record: PlanApprovalRecord = {
    planId,
    path: planPath,
    revision: 1,
    digest: approvalDigest(planPath, planId, contract),
    contract,
    approvedAt: "2026-10-04T00:00:00.000Z",
    signer: "historical fixture approver",
    finalDelivery: { base: "a".repeat(40), fingerprint: "b".repeat(64) },
    ...(approvalModel ? { approvalModel } : {}),
  };
  put("docs/.approvals.json", JSON.stringify({ version: 1, revision: 1, records: [record] }));
  return record;
}

function jsonOutput(run: () => void): unknown {
  const output: string[] = [];
  const previousLog = console.log;
  const previousExit = process.exitCode;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  process.exitCode = undefined;
  try {
    run();
    assert.equal(process.exitCode, undefined, output.join("\n"));
    return JSON.parse(output.join("\n"));
  } finally {
    console.log = previousLog;
    process.exitCode = previousExit;
  }
}

const boundary: ChangeSet = {
  version: 1,
  mode: "staged",
  bases: [{ prefix: "", sha: "a".repeat(40) }],
  head: "INDEX",
  complete: true,
  changes: [{ path: planPath, status: "modified", contentOid: "c".repeat(40) }],
  changedFiles: [planPath],
  additions: [],
  deletions: [],
  renames: [],
  unselectedStagedPaths: [],
  dirtyOutside: [],
  fingerprint: "d".repeat(64),
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codument-archive-compat-"));
  put(planPath, compacted);
  put("docs/features/nested.md", "# Nested\n\n## In plain terms\nHistorical routing owner.\n");
  const feature = (doc: string, source: string) => ({
    doc,
    type: "feature",
    primary_sources: [source],
    related_sources: [],
    docs: [],
    depends_on: [],
    risk: [],
    last_updated: "2026-10-04",
    status: "current",
  });
  put("docs/.registry.json", JSON.stringify({ features: {
    alpha: feature(planPath, "src/alpha.ts"),
    nested: feature("docs/features/nested.md", "src/nested.ts"),
  } }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("archived approval interpretation compatibility", () => {
  for (const declaration of ["example-value", "outcome-v1"]) {
    it(`preserves unmarked ${declaration} contract routing and final binding`, () => {
      const contract = `## Delivery Plan\nApproval-Model: ${declaration}\n\n- [ ] Deliver alpha\n\n### Scope\n- \`src/alpha.ts\`\n` + nestedMap;
      const record = archive(contract);
      const before = readFileSync(join(root, "docs/.approvals.json"), "utf8");
      const store = readApprovalStore(root);
      const finalBinding = finalDeliveryFingerprint(boundary, store, planId);

      assert.deepEqual(finalApprovalScope(record).scope, ["src/alpha.ts", "src/nested.ts"]);
      assert.equal(finalApprovalScope(record).approvalModel, undefined);
      assert.equal(finalApprovalScope(record).approvalDigest, record.digest);
      assert.equal(retainedPlanMarkdown(record), identifyPlan(contract, planId));
      const retained = workPlanContext(root, planPath, compacted, planId);
      assert.equal(retained.approvalModel, "legacy");
      assert.equal(retained.markdown, retainedPlanMarkdown(record));
      assert.equal(workPlanMarkdown(root, planPath, compacted, planId), retained.markdown);
      assert.equal(parseFeatureMap(retained.markdown, planId, retained.approvalModel).rows[0].feature, "nested");

      const context = jsonOutput(() => contextCommand({ root, plan: planPath, planId, json: true })) as { entries: Array<{ feature: string }> };
      assert.deepEqual(context.entries.map(entry => entry.feature), ["alpha", "nested"]);
      const route = jsonOutput(() => mapRoute({ root, plan: planPath, planId, file: "src/nested.ts", json: true })) as { feature: string | null };
      assert.equal(route.feature, "nested");
      assert.equal(readFileSync(join(root, "docs/.approvals.json"), "utf8"), before);
      assert.equal(finalDeliveryFingerprint(boundary, readApprovalStore(root), planId), finalBinding);
      assert.equal(record.contract, contract);
    });
  }

  it("keeps explicitly recorded outcome archives under outcome interpretation", () => {
    const markdown = "## Delivery Plan\nApproval-Model: outcome-v1\n\n- [ ] Deliver alpha\n" +
      "\n### Outcome\nReturn alpha values.\n### Constraints & non-goals\nKeep compatibility and privacy.\n" +
      "### Acceptance evidence\nInspect alpha values.\n### Verification\nRun alpha checks.\n" + nestedMap;
    const contract = planContractMarkdown(markdown);
    const record = archive(contract, "outcome-v1");
    const retained = workPlanContext(root, planPath, compacted, planId);
    assert.equal(retained.approvalModel, "outcome-v1");
    assert.equal(retained.markdown, identifyPlan(contract, planId));
    assert.equal(finalApprovalScope(record).approvalModel, "outcome-v1");
    assert.deepEqual(finalApprovalScope(record).scope, []);
    assert.deepEqual(parseFeatureMap(retained.markdown, planId, retained.approvalModel).rows, []);
    const context = jsonOutput(() => contextCommand({ root, plan: planPath, planId, json: true })) as { entries: Array<{ feature: string }> };
    assert.deepEqual(context.entries.map(entry => entry.feature), ["alpha"]);
    const route = jsonOutput(() => mapRoute({ root, plan: planPath, planId, file: "src/nested.ts", json: true })) as { feature: string | null };
    assert.equal(route.feature, null);
    assert.equal(readApprovalStore(root).records[0].digest, record.digest);
  });

  it("leaves live plan context and explicit sibling previews unchanged", () => {
    archive("## Delivery Plan\nApproval-Model: example-value\n- [ ] Deliver alpha\n" + nestedMap);
    const live = "## Delivery Plan\nPlan-ID: new-alpha\nStatus: draft\n- [ ] Deliver new alpha\n";
    assert.deepEqual(workPlanContext(root, planPath, live, "new-alpha"), { markdown: live });
    assert.deepEqual(workPlanContext(root, planPath, compacted), { markdown: compacted });
  });
});
