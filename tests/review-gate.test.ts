import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  requiresAdversarialReview,
  evaluateReviewGate,
  countResolvedMovedSymbols,
  type ReviewGateInput,
} from "../src/lib/review-gate.js";
import type { ReviewFinding, ReviewFindingStatus } from "../src/lib/review-artifact.js";
import type { TestOutcome } from "../src/lib/review-confirm.js";

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
  it("an empty diff never requires a review", () => {
    assert.equal(
      requiresAdversarialReview(input({ realChangeCount: 0, changedSourceCount: 0, movedSymbolCount: 0 })),
      false,
    );
  });

  it("more than one real change requires a review", () => {
    assert.equal(requiresAdversarialReview(input({ realChangeCount: 2, changedSourceCount: 2 })), true);
  });

  it("a single deletion requires a review", () => {
    assert.equal(
      requiresAdversarialReview(input({ realChangeCount: 1, changedSourceCount: 0, deletionCount: 1, movedSymbolCount: 0 })),
      true,
    );
  });

  it("a single config/data (non-source) change requires a review", () => {
    assert.equal(
      requiresAdversarialReview(input({ realChangeCount: 1, changedSourceCount: 0, otherChangedCount: 1, movedSymbolCount: 0 })),
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
      requiresAdversarialReview(input({ movedSymbolCount: countResolvedMovedSymbols(["<module>"]) })),
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

  it("a required diff with no covering artifact fails", () => {
    const res = evaluateReviewGate(required, null);
    assert.equal(res.required, true);
    assert.equal(res.covered, false);
    assert.equal(res.passed, false);
    assert.match(res.reason ?? "", /no current adversarial review/);
  });

  it("a required diff with a confirmed (test-red) finding is blocked", () => {
    const res = evaluateReviewGate(required, [finding("confirmed", "bug.test.ts"), finding("advisory")]);
    assert.equal(res.passed, false);
    assert.equal(res.blockingFindings.length, 1);
    assert.match(res.reason ?? "", /1 confirmed finding/);
  });

  it("a required diff with only advisory/resolved findings passes, surfacing advisories", () => {
    const res = evaluateReviewGate(required, [finding("advisory"), finding("resolved", "fixed.test.ts")]);
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
