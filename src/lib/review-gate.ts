import type { ReviewFinding } from "./review-artifact.js";
import type { TestOutcome } from "./review-confirm.js";
import { MODULE_ANCHOR_NAME } from "./ts-adapter.js";

// The adversarial-review gate decision, kept pure and separate from the `review`
// command so it is unit-testable. Two parts: a PROPORTIONALITY predicate (does
// this diff even need an adversarial review?) and the VERDICT (given the findings
// the caller RE-DERIVED by running their tests, does the gate pass?).
//
// The caller hands in findings whose status it just re-computed via the confirm
// step (running each finding's named test) — the gate never trusts a status the
// artifact merely claims. A finding blocks only when its test is genuinely red.
//
// Honest boundary (do NOT overclaim): this enforces that a review RITUAL happened
// (a diff-bound artifact exists, enumerating the invariants checked) and verifies
// every DECLARED finding by reproduction. It cannot force a review to be thorough
// — an artifact with no findings passes, so a lazy or fabricated-clean review is
// not caught here. That omission is the audit-trail / soak limit, the same class
// as the change-control gate's inability to verify an ack's semantic truth.

export interface ReviewGateInput {
  /** All real changed paths — sources + config/data + deletions, non-doc and
   *  non-excluded. The proportionality denominator. */
  realChangeCount: number;
  /** TS/JS source files changed (subset of realChange). */
  changedSourceCount: number;
  /** Config/data / non-source files changed, e.g. package.json (subset). */
  otherChangedCount: number;
  /** Files deleted (subset of realChange). */
  deletionCount: number;
  /** Risk-tagged features the diff touched. */
  riskTouchCount: number;
  /** Unresolved ownership ambiguities the diff surfaced (a shared symbol no
   *  feature claims). An ambiguity is by definition NOT a confirmable single-symbol
   *  move, so it is never trivial. */
  ownershipLintCount: number;
  /** Whether the `<module>` residual anchor moved — unresolved module-level content
   *  (a new side-effecting import, a registered global handler, an env mutation).
   *  Never provably small, even riding alongside one resolved symbol, so any
   *  residual move forces a review. */
  moduleResidualMoved: boolean;
  /** Owned, RESOLVED TS symbols that moved across the diff. Excludes the `<module>`
   *  residual backstop (unresolved module-level content) — use
   *  `countResolvedMovedSymbols`; the residual is handled by `moduleResidualMoved`. */
  movedSymbolCount: number;
}

// Owned moved symbols that count toward the "exactly one moved symbol" trivial
// fast-path. The synthetic `<module>` residual is the analyzer's catch-all for
// unresolved module-level content (imports, side-effecting statements, unreferenced
// state) — the OPPOSITE of a precisely-resolved symbol — so a diff whose only moved
// anchor is the residual is not provably small and must not read as trivial.
export function countResolvedMovedSymbols(movedSymbols: readonly string[]): number {
  return movedSymbols.filter((s) => s !== MODULE_ANCHOR_NAME).length;
}

// Proportionality: a heavyweight adversarial review is required for any
// non-trivial diff, so a one-line edit never demands one (waste is how a good
// gate gets disabled), but nothing real slips through as "trivial". Required for
// more than one real change, any deletion, any non-source (config/data) change, a
// risk-tagged touch, or an unresolved ownership ambiguity (a shared symbol no
// feature claims — the fail-loud shape, which cannot be a confirmed single move).
// The ONLY trivial case is exactly one changed source the analyzer fully resolved
// as a SINGLE moved symbol and nothing else — `movedSymbolCount !== 1` covers a
// coarse/non-TS file, an unmapped/unowned file, an unevaluable parse error, or a
// multi-symbol edit, and `moduleResidualMoved` covers a `<module>`-residual move
// (alone OR riding alongside one symbol), none of which we can confirm is small.
// `movedSymbolCount` counts only resolved OWNED symbols (excludes the residual), so
// it can undercount; the residual guard, the ownership-lint, and the full-change-set
// checks above are what keep an unowned or module-level co-moved change from reading
// trivial.
export function requiresAdversarialReview(input: ReviewGateInput): boolean {
  if (input.realChangeCount === 0) return false;
  if (input.realChangeCount > 1) return true;
  if (input.deletionCount > 0) return true;
  if (input.otherChangedCount > 0) return true;
  if (input.riskTouchCount > 0) return true;
  if (input.ownershipLintCount > 0) return true;
  // A moved <module> residual is unresolved module-level content (a side-effecting
  // import, a registered global handler) — never provably small, even alongside one
  // resolved symbol, so any residual move forces a review. Only a lone resolved
  // symbol with no residual is trivial.
  if (input.moduleResidualMoved) return true;
  return input.movedSymbolCount !== 1;
}

export interface ReviewGateResult {
  /** Did proportionality require an adversarial review for this diff? */
  required: boolean;
  /** Is there an artifact whose fingerprint covers the current diff? */
  covered: boolean;
  /** Confirmed (test-red) findings left unresolved — these block. */
  blockingFindings: ReviewFinding[];
  /** Advisory (judgment-call) findings — surfaced, never blocking. */
  advisoryFindings: ReviewFinding[];
  /** The gate verdict. */
  passed: boolean;
  /** Why the gate failed, or null when it passed. */
  reason: string | null;
  /** Findings the gate actually adjudicated — a named test was located and run, so
   *  the status came from a reproduction rather than from the artifact's claim. */
  adjudicated: number;
  /** Findings that OFFERED a reproduction the gate could not perform: a test was
   *  named and running it failed at the toolchain. `covered` answers whether a review
   *  EXISTS for this diff; this answers whether its checkable claims were checked, and
   *  the two are different questions the verdict used to give one answer to. In the
   *  field they diverged completely — five delivery steps of findings recorded with
   *  named tests, a runner that resolved to nothing, and a verdict that said the
   *  review covered the diff every time.
   *
   *  A finding that named NO test is deliberately not counted here. It is a judgment
   *  call, which the gate has always kept advisory by design, and nothing was ever
   *  going to reproduce it — so warning about it would fire on every honest review
   *  and teach the reader to skip the line. This counts a broken toolchain, which is
   *  actionable, not an untestable claim, which is not. */
  unjudged: number;
}

/** A finding as the gate sees it: the artifact's record plus, where the caller ran
 *  the confirm step, what running its named test produced. */
type JudgedFinding = ReviewFinding & { testOutcome?: TestOutcome | null };

// The verdict. `findings` are the covering artifact's findings AFTER the caller
// re-derived their statuses by running each named test (null when no artifact
// covers the current diff — missing or auto-invalidated). A trivial diff passes
// with no artifact; a non-trivial diff needs a covering artifact with no
// unresolved confirmed (test-red) finding.
export function evaluateReviewGate(
  input: ReviewGateInput,
  findings: readonly JudgedFinding[] | null,
): ReviewGateResult {
  if (!requiresAdversarialReview(input)) {
    return {
      required: false,
      covered: findings !== null,
      blockingFindings: [],
      advisoryFindings: [],
      passed: true,
      reason: null,
      adjudicated: 0,
      unjudged: 0,
    };
  }
  if (findings === null) {
    return {
      required: true,
      covered: false,
      blockingFindings: [],
      advisoryFindings: [],
      passed: false,
      reason: "no current adversarial review covers this diff",
      adjudicated: 0,
      unjudged: 0,
    };
  }
  const adjudicated = findings.filter(
    (f) => f.testOutcome === "failed" || f.testOutcome === "passed",
  ).length;
  const unjudged = findings.filter((f) => f.testOutcome === "unrunnable").length;
  const blockingFindings = findings.filter((f) => f.status === "confirmed");
  const advisoryFindings = findings.filter((f) => f.status === "advisory");
  if (blockingFindings.length > 0) {
    return {
      required: true,
      covered: true,
      blockingFindings,
      advisoryFindings,
      passed: false,
      reason: `${blockingFindings.length} confirmed finding(s) unresolved`,
      adjudicated,
      unjudged,
    };
  }
  return {
    required: true,
    covered: true,
    blockingFindings: [],
    advisoryFindings,
    passed: true,
    reason: null,
    adjudicated,
    unjudged,
  };
}
