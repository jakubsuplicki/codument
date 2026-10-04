import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  requiresAdversarialReview,
  evaluateReviewGate,
  countResolvedMovedSymbols,
  classifyReviewPolicy,
  REVIEW_POLICY_VERSION,
  type ReviewPolicyFacts,
  type ReviewGateInput,
} from "../src/lib/review-gate.js";
import type { ReviewFinding, ReviewFindingStatus } from "../src/lib/review-artifact.js";
import type { TestOutcome } from "../src/lib/review-confirm.js";
import type { Registry } from "../src/lib/registry.js";

function policyFacts(partial: Partial<ReviewPolicyFacts> = {}): ReviewPolicyFacts {
  const registry: Registry = { features: { alpha: {
    doc: "docs/features/alpha.md", type: "feature", status: "current",
    primary_sources: ["src/a.ts"], related_sources: [], docs: [], depends_on: [], risk: [],
  } } };
  return {
    mode: "staged", complete: true,
    sourcePaths: ["src/a.ts"], existingSourcePaths: ["src/a.ts"],
    anchorChanges: { "src/a.ts": [
      { id: "src/a.ts::alpha()", name: "alpha()", kind: "changed", from: "old", to: "new", fromSig: "sig", toSig: "sig" },
      { id: "src/a.ts::beta()", name: "beta()", kind: "changed", from: "old-b", to: "new-b", fromSig: "sig-b", toSig: "sig-b" },
    ] },
    unevaluablePaths: [], otherChangedPaths: [], addedPaths: [], deletedPaths: [], renamedPaths: [],
    contractChanges: [], beforeRegistry: registry, registry, riskTouches: [],
    testImpact: { changedTests: ["tests/a.test.ts"], attributed: [{ test: "tests/a.test.ts", feature: "alpha", via: "direct-import" }], unattributed: [], dependents: [], dependentsSummary: [] },
    ...partial,
  };
}

describe("classifyReviewPolicy — exact structural minimum", () => {
  it("permits focused review for attributable body-only changes rather than counting symbols or test files", () => {
    const policy = classifyReviewPolicy(policyFacts());
    assert.equal(policy.minimum, "focused");
    assert.equal(policy.version, REVIEW_POLICY_VERSION);
    assert.match(policy.factsFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(evaluateReviewGate(input({ reviewPolicy: policy }), null).passed, false);
    assert.equal(evaluateReviewGate(input({ reviewPolicy: policy }), []).passed, true);
  });

  it("still adjudicates covering reproduced findings when the minimum is none", () => {
    const policy = classifyReviewPolicy(policyFacts({ anchorChanges: { "src/a.ts": [] }, testImpact: undefined }));
    assert.equal(policy.minimum, "none");
    assert.equal(evaluateReviewGate(input({ reviewPolicy: policy }), null).passed, true);
    const gate = evaluateReviewGate(input({ reviewPolicy: policy }), [
      { ...finding("confirmed", "bug.test.ts"), testOutcome: "failed" },
      { ...finding("advisory", "gap.test.ts"), testOutcome: "unrunnable" },
    ]);
    assert.equal(gate.required, false);
    assert.equal(gate.passed, false);
    assert.equal(gate.blockingFindings.length, 1);
    assert.equal(gate.adjudicated, 1);
    assert.equal(gate.unjudged, 1);
  });

  it("allows new attributable tests without treating them as new production code", () => {
    assert.equal(classifyReviewPolicy(policyFacts({ addedPaths: ["tests/a.test.ts"] })).minimum, "focused");
    assert.equal(classifyReviewPolicy(policyFacts({ addedPaths: ["src/new.ts"] })).minimum, "adversarial");
  });

  it("requires positive documentation evidence and preserves every stronger control", () => {
    const facts = policyFacts({ sourcePaths: [], existingSourcePaths: [], anchorChanges: {},
      testImpact: undefined, addedPaths: ["docs/note.md"], housekeepingDocs: ["docs/note.md"] });
    const plain = classifyReviewPolicy(facts);
    assert.equal(plain.minimum, "none");
    assert.equal(classifyReviewPolicy({ ...facts, housekeepingDocs: [] }).minimum, "adversarial");
    for (const stronger of [
      { unverifiedDocs: ["docs/note.md"] },
      { riskTouches: [{ feature: "alpha", risk: ["security"], files: ["docs/note.md"] }] },
      { complete: false }, { deletedPaths: ["docs/old.md"] }, { renamedPaths: ["docs/note.md"] },
      { otherChangedPaths: ["package.json"] },
      { contractChanges: [{ path: "docs/note.md", owners: [], kind: "documentation" as const,
        before: null, after: "A new promise", testPointers: [], requiresReview: true }] },
    ]) {
      assert.equal(classifyReviewPolicy({ ...facts, ...stronger }).minimum, "adversarial");
    }
    assert.notEqual(plain.factsFingerprint, classifyReviewPolicy({ ...facts, housekeepingDocs: [] }).factsFingerprint);
    assert.equal(evaluateReviewGate(input({ reviewPolicy: plain }), [
      { ...finding("confirmed", "proof.test.ts"), testOutcome: "failed" },
    ]).passed, false);
  });

  it("enforces each static floor independently of source or symbol counts", () => {
    const defaults = policyFacts();
    const moved = defaults.anchorChanges["src/a.ts"][0];
    const oldRisk = { features: { alpha: { ...defaults.registry.features.alpha, risk: ["security"] } } };
    const otherOwner = { features: { beta: { ...defaults.registry.features.alpha } } };
    const cases: Partial<ReviewPolicyFacts>[] = [
      { mode: "range" }, { complete: false }, { unevaluablePaths: ["src/a.ts"] },
      { anchorChanges: {} }, { existingSourcePaths: [] },
      { otherChangedPaths: ["package.json"] }, { deletedPaths: ["src/old.ts"] },
      { renamedPaths: ["src/a.ts"] }, { testImpact: undefined },
      { beforeRegistry: { features: {} } }, { registry: { features: {} } },
      { beforeRegistry: oldRisk }, { registry: oldRisk }, { registry: otherOwner },
      { riskTouches: [{ feature: "secondary", risk: ["privacy"], files: ["src/a.ts"] }] },
      { anchorChanges: { "src/a.ts": [moved, { ...moved, id: "src/a.ts::<module>", name: "<module>" }] } },
      { anchorChanges: { "src/a.ts": [{ ...moved, kind: "added" }] } },
      { anchorChanges: { "src/a.ts": [{ ...moved, kind: "removed" }] } },
      { anchorChanges: { "src/a.ts": [{ ...moved, toSig: undefined }] } },
      { anchorChanges: { "src/a.ts": [{ ...moved, toSig: "different" }] } },
      { testImpact: { ...defaults.testImpact!, unattributed: ["tests/a.test.ts"] } },
      { testImpact: { ...defaults.testImpact!, attributed: [{ test: "tests/a.test.ts", feature: "other", via: "direct-import" }] } },
      { contractChanges: [{ path: "docs/features/alpha.md", owners: ["alpha"], kind: "documentation", before: "old contract", after: "new contract", testPointers: [], requiresReview: false }] },
    ];
    for (const partial of cases) {
      const policy = classifyReviewPolicy(policyFacts(partial));
      assert.equal(policy.minimum, "adversarial", JSON.stringify(partial));
      assert.ok(policy.reasons.length > 0);
    }
  });

  it("cannot launder an unowned original co-moved symbol through a filtered owned count", () => {
    const defaults = policyFacts();
    const split = { features: {
      alpha: { ...defaults.registry.features.alpha, owned_symbols: { "src/a.ts": ["alpha()"] } },
      beta: { ...defaults.registry.features.alpha },
    } };
    assert.equal(classifyReviewPolicy(policyFacts({ beforeRegistry: split, registry: split })).minimum, "adversarial");
  });

  it("treats proven existing instruction formatting as housekeeping while binding the selected facts", () => {
    const policy = classifyReviewPolicy(policyFacts({ sourcePaths: [], existingSourcePaths: [], anchorChanges: {}, testImpact: undefined,
      otherChangedPaths: ["skills/work-step/SKILL.md"], contractChanges: [{ path: "skills/work-step/SKILL.md", owners: ["alpha"], kind: "instruction", before: "Wait for approval", after: "Wait  for approval", testPointers: [], requiresReview: false }],
    }));
    assert.equal(policy.minimum, "none");
    assert.notEqual(policy.factsFingerprint, classifyReviewPolicy(policyFacts({ sourcePaths: [], existingSourcePaths: [], anchorChanges: {}, testImpact: undefined })).factsFingerprint);
  });

  it("binds original ownership, risks and attribution deterministically", () => {
    const defaults = policyFacts();
    const policy = classifyReviewPolicy(defaults);
    assert.deepEqual(classifyReviewPolicy({ ...defaults, anchorChanges: { "src/a.ts": [...defaults.anchorChanges["src/a.ts"]].reverse() } }), policy);
    const changedRisk = { features: { alpha: { ...defaults.registry.features.alpha, risk: ["security"] } } };
    assert.notEqual(classifyReviewPolicy({ ...defaults, beforeRegistry: changedRisk }).factsFingerprint, policy.factsFingerprint);
    assert.notEqual(classifyReviewPolicy({ ...defaults, testImpact: { ...defaults.testImpact!, attributed: [{ test: "tests/a.test.ts", feature: "alpha", via: "invariant-pin" }] } }).factsFingerprint, policy.factsFingerprint);
    assert.equal(evaluateReviewGate(input({ reviewPolicy: policy }), []).reviewPolicy, policy);
    assert.equal("reviewPolicy" in evaluateReviewGate(input(), []), false);
  });
});

// Default: a single changed source resolved as exactly one moved symbol — the one
// genuinely-trivial shape.
function input(partial: Partial<ReviewGateInput> = {}): ReviewGateInput {
  return {
    realChangeCount: 1,
    changedSourceCount: 1,
    otherChangedCount: 0,
    deletionCount: 0,
    riskTouchCount: 0,
    ownershipLintCount: 0,
    moduleResidualMoved: false,
    movedSymbolCount: 1,
    ...partial,
  };
}

function finding(status: ReviewFindingStatus, failingTest: string | null = null): ReviewFinding {
  return { citation: "a.ts:1", detail: "d", failingTest, status };
}

describe("requiresAdversarialReview — proportionality (full change set)", () => {
  it("requires contract review independently and excludes proven instruction housekeeping from size", () => {
    assert.equal(
      requiresAdversarialReview(
        input({ realChangeCount: 0, changedSourceCount: 0, contractChangeCount: 1 }),
      ),
      true,
    );
    assert.equal(
      requiresAdversarialReview(
        input({ realChangeCount: 2, otherChangedCount: 1, housekeepingInstructionCount: 1 }),
      ),
      false,
    );
    assert.equal(
      requiresAdversarialReview(
        input({
          realChangeCount: 2,
          otherChangedCount: 1,
          housekeepingInstructionCount: 1,
          contractChangeCount: 1,
        }),
      ),
      true,
    );
  });
  it("an empty diff never requires a review", () => {
    assert.equal(
      requiresAdversarialReview(
        input({ realChangeCount: 0, changedSourceCount: 0, movedSymbolCount: 0 }),
      ),
      false,
    );
  });

  it("more than one real change requires a review", () => {
    assert.equal(
      requiresAdversarialReview(input({ realChangeCount: 2, changedSourceCount: 2 })),
      true,
    );
  });

  it("a single deletion requires a review", () => {
    assert.equal(
      requiresAdversarialReview(
        input({ realChangeCount: 1, changedSourceCount: 0, deletionCount: 1, movedSymbolCount: 0 }),
      ),
      true,
    );
  });

  it("a single config/data (non-source) change requires a review", () => {
    assert.equal(
      requiresAdversarialReview(
        input({
          realChangeCount: 1,
          changedSourceCount: 0,
          otherChangedCount: 1,
          movedSymbolCount: 0,
        }),
      ),
      true,
    );
  });

  it("a risk-tagged single-source diff requires a review", () => {
    assert.equal(requiresAdversarialReview(input({ riskTouchCount: 1 })), true);
  });

  it("an unresolved ownership ambiguity (unassigned shared symbol) requires a review", () => {
    // The fail-loud shape: a shared file moves one owned symbol (movedSymbolCount 1)
    // AND a co-moved symbol no feature claims. The owned count alone reads trivial;
    // the ownership lint is what forces the review.
    assert.equal(requiresAdversarialReview(input({ ownershipLintCount: 1 })), true);
  });

  it("a moved <module> residual requires a review even alongside exactly one resolved symbol", () => {
    // The false-negative the re-verify caught: a behavior edit PLUS a new
    // side-effecting import/global handler moves [symbol, <module>]; the resolved
    // count is 1, so without the residual guard it would read trivial. The residual
    // is unresolved module-level content → never provably small.
    assert.equal(requiresAdversarialReview(input({ moduleResidualMoved: true })), true);
    assert.equal(
      requiresAdversarialReview(input({ moduleResidualMoved: true, movedSymbolCount: 1 })),
      true,
    );
  });

  it("a single source moving more than one symbol requires a review", () => {
    assert.equal(requiresAdversarialReview(input({ movedSymbolCount: 2 })), true);
  });

  it("a single source the analyzer could NOT resolve to one symbol (coarse/non-TS/unmapped) requires a review", () => {
    // movedSymbolCount 0 = coarse/non-TS/unmapped/unevaluable — not provably small
    assert.equal(requiresAdversarialReview(input({ movedSymbolCount: 0 })), true);
  });

  it("the one trivial case: a single source resolved as exactly one moved symbol, no risk", () => {
    assert.equal(requiresAdversarialReview(input()), false);
  });
});

describe("countResolvedMovedSymbols — the <module> residual is not a resolved symbol", () => {
  it("counts real owned symbols", () => {
    assert.equal(countResolvedMovedSymbols(["alpha()", "bravo()"]), 2);
    assert.equal(countResolvedMovedSymbols([]), 0);
  });

  it("excludes the <module> residual backstop, so a side-effect-only edit is not 'one symbol'", () => {
    assert.equal(countResolvedMovedSymbols(["<module>"]), 0);
    assert.equal(countResolvedMovedSymbols(["alpha()", "<module>"]), 1);
  });

  it("a <module>-only move resolves to 0 → requires a review (movedSymbolCount !== 1)", () => {
    assert.equal(
      requiresAdversarialReview(
        input({ movedSymbolCount: countResolvedMovedSymbols(["<module>"]) }),
      ),
      true,
    );
  });
});

describe("evaluateReviewGate — verdict over re-derived findings", () => {
  const required = input({ realChangeCount: 3, changedSourceCount: 3 });

  it("a trivial diff passes with no findings at all", () => {
    const res = evaluateReviewGate(input(), null);
    assert.equal(res.required, false);
    assert.equal(res.passed, true);
  });

  it("a legacy trivial diff cannot erase covering red or advisory findings", () => {
    const res = evaluateReviewGate(input(), [
      { ...finding("confirmed", "bug.test.ts"), testOutcome: "failed" },
      finding("advisory"),
    ]);
    assert.equal(res.required, false);
    assert.equal(res.passed, false);
    assert.equal(res.blockingFindings.length, 1);
    assert.equal(res.advisoryFindings.length, 1);
    assert.equal(res.adjudicated, 1);
  });

  it("a required diff with no covering artifact fails", () => {
    const res = evaluateReviewGate(required, null);
    assert.equal(res.required, true);
    assert.equal(res.covered, false);
    assert.equal(res.passed, false);
    assert.match(res.reason ?? "", /no current adversarial review/);
  });

  it("a required diff with a confirmed (test-red) finding is blocked", () => {
    const res = evaluateReviewGate(required, [
      finding("confirmed", "bug.test.ts"),
      finding("advisory"),
    ]);
    assert.equal(res.passed, false);
    assert.equal(res.blockingFindings.length, 1);
    assert.match(res.reason ?? "", /1 confirmed finding/);
  });

  it("a required diff with only advisory/resolved findings passes, surfacing advisories", () => {
    const res = evaluateReviewGate(required, [
      finding("advisory"),
      finding("resolved", "fixed.test.ts"),
    ]);
    assert.equal(res.passed, true);
    assert.equal(res.blockingFindings.length, 0);
    assert.equal(res.advisoryFindings.length, 1);
  });
});

// "Does a review exist for this diff" and "was anything in it checked" are two
// questions, and the gate used to give one answer to both. In the field they came
// apart completely: five delivery steps of findings recorded with named tests, a
// runner that resolved to nothing, and a passing verdict every time.
describe("evaluateReviewGate — what it adjudicated is not what it covers", () => {
  const required = input({ realChangeCount: 3, changedSourceCount: 3 });
  const judged = (status: ReviewFindingStatus, testOutcome: TestOutcome | null) => ({
    ...finding(status, testOutcome === null ? null : "some.test.ts"),
    testOutcome,
  });

  it("a test that ran is adjudicated; one that could not be run is not", () => {
    const res = evaluateReviewGate(required, [
      judged("resolved", "passed"),
      judged("advisory", "unrunnable"),
    ]);
    assert.equal(res.passed, true, "an unrunnable claim still never blocks");
    assert.equal(res.adjudicated, 1);
    assert.equal(res.unjudged, 1);
  });

  it("a finding that named NO test is a judgment call, not a broken toolchain", () => {
    // Counting it as unadjudicated would fire the warning on every honest review that
    // reported judgment calls — the cries-wolf failure, arriving through the fix for
    // a different one. The gate has always kept a non-testable finding advisory by
    // design; nothing was ever going to reproduce it, and the reader has no next move.
    const res = evaluateReviewGate(required, [judged("advisory", null)]);
    assert.equal(res.adjudicated, 0);
    assert.equal(res.unjudged, 0);
    assert.equal(res.passed, true);
  });

  it("the field's shape: every finding recorded, not one of them run", () => {
    const res = evaluateReviewGate(required, [
      judged("advisory", "unrunnable"),
      judged("advisory", "unrunnable"),
      judged("advisory", "unrunnable"),
    ]);
    assert.equal(res.covered, true, "a review does exist for this diff");
    assert.equal(res.adjudicated, 0, "and nothing in it was checked");
    assert.equal(res.unjudged, 3);
  });

  it("a review that found nothing has nothing to adjudicate, and claims nothing", () => {
    const res = evaluateReviewGate(required, []);
    assert.equal(res.passed, true);
    assert.equal(res.adjudicated, 0);
    assert.equal(res.unjudged, 0, "zero of zero is not an unjudged claim");
  });
});
