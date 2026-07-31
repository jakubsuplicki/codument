import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildManagedSection } from "../src/lib/scaffold.js";

// Plan 31 marks its "## The rule (verbatim)" block "Approved as written, not as
// described" — the strongest fidelity bar this repo's plans use. This test reads
// that block from the plan itself (never a copy of it, which would only compare
// the code to itself) and pins the shipped contract against it, so editing the
// rule in scaffold.ts without re-approving it in the plan goes red.
//
// Lifecycle: this test is bound to a TRANSIENT artifact. The Delivery Plan block
// compacts out on ship (plan-with-docs → Compaction on ship), and this file must
// be deleted in that same compaction. The durable coverage — that the rule exists
// and says what it must — lives in scaffold.test.ts and survives.
const PLAN = "docs/plans/31-response-altitude.md";

/** The plan's approved rule text: the fenced block under "## The rule (verbatim)". */
function approvedRule(): string {
  const plan = readFileSync(PLAN, "utf-8");
  const heading = plan.indexOf("## The rule (verbatim)");
  assert.ok(heading !== -1, `${PLAN} must carry a "## The rule (verbatim)" block`);
  // Exactly one markdown fence may exist, or "the first fence after the heading"
  // is ambiguous: a decoy block (an "example of what NOT to write") could be
  // extracted instead of the real rule, letting a wrong contract pass green.
  const fences = plan.split("```markdown").length - 1;
  assert.equal(
    fences,
    1,
    `${PLAN} must contain exactly one \`\`\`markdown fence — found ${fences}; ` +
      "with more than one, the extracted 'approved' rule is ambiguous.",
  );
  const fence = plan.indexOf("```markdown", heading);
  assert.ok(fence !== -1, `${PLAN} must fence its verbatim rule as \`\`\`markdown`);
  const open = plan.indexOf("\n", fence) + 1;
  const close = plan.indexOf("```", open);
  assert.ok(close !== -1, `${PLAN}'s verbatim rule block must be closed`);
  return plan.slice(open, close).trim();
}

/** Paragraphs with internal line-wrapping collapsed — wrap column is formatting, not content. */
function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.split(/\s+/).filter(Boolean).join(" "))
    .filter(Boolean);
}

describe("response altitude — fidelity to the approved plan text", () => {
  it("ships Plan 31's approved rule, not a paraphrase of it", () => {
    const section = buildManagedSection();
    const start = section.indexOf("### Response altitude");
    const end = section.indexOf("### Intent routing");
    assert.ok(start !== -1 && end !== -1, "Response altitude section must exist");

    assert.deepEqual(
      paragraphs(section.slice(start, end).trim()),
      paragraphs(approvedRule()),
      `buildManagedSection() must ship the rule text ${PLAN} approved ` +
        '("Approved as written, not as described"). A mismatch means the ' +
        "contract was edited without re-approving it in the plan.",
    );
  });

  it("the approved block is a real rule, not an empty fence", () => {
    // guards the extractor itself: a plan edit that empties the block would
    // otherwise make the comparison above pass vacuously.
    const paras = paragraphs(approvedRule());
    assert.ok(paras.length >= 4, "approved rule must carry its full set of clauses");
    assert.ok(paras[0].startsWith("### Response altitude"));
  });
});
