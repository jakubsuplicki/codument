import type { ReviewFinding } from "./review-artifact.js";
import type { TestOutcome } from "./review-confirm.js";
import { MODULE_ANCHOR_NAME } from "./ts-adapter.js";
import { createHash } from "node:crypto";
import type { AnchorChange } from "./fingerprint.js";
import type { Registry } from "./registry.js";
import { resolveOwner } from "./ownership.js";
import type { RiskTouch } from "./change-state.js";
import type { ContractChange } from "./review-bundle.js";
import type { TestImpact } from "./test-impact.js";

export const REVIEW_POLICY_VERSION = 1;

export interface ReviewPolicy {
  version: typeof REVIEW_POLICY_VERSION;
  minimum: "none" | "focused" | "adversarial";
  reasons: string[];
  /** Binds the original evidence, including both ownership and risk views. */
  factsFingerprint: string;
}

export interface ReviewPolicyFacts {
  mode: "staged" | "range";
  complete: boolean;
  sourcePaths: readonly string[];
  existingSourcePaths: readonly string[];
  anchorChanges: Readonly<Record<string, readonly AnchorChange[]>>;
  unevaluablePaths: readonly string[];
  otherChangedPaths: readonly string[];
  addedPaths: readonly string[];
  deletedPaths: readonly string[];
  renamedPaths: readonly string[];
  contractChanges: readonly ContractChange[];
  beforeRegistry: Registry;
  registry: Registry;
  /** Union of impacted risks at the base and selected snapshot. */
  riskTouches: readonly RiskTouch[];
  testImpact?: TestImpact;
}

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();
const normalizedProse = (text: string | null): string | null =>
  text === null ? null : text.replace(/^\uFEFF/, "").replace(/\s+/g, " ").trim();

/** Structural minimum only. Understanding, locality and reversibility remain host judgment. */
export function classifyReviewPolicy(facts: ReviewPolicyFacts): ReviewPolicy {
  const reasons = new Set<string>();
  const sources = sortedUnique(facts.sourcePaths);
  const existing = new Set(facts.existingSourcePaths);
  const addReason = (condition: boolean, reason: string) => { if (condition) reasons.add(reason); };
  addReason(facts.mode !== "staged", "branch or range review");
  addReason(!facts.complete, "incomplete boundary analysis");
  addReason(facts.unevaluablePaths.length > 0, "unevaluable source analysis");
  const instructionHousekeeping = new Set(facts.contractChanges.filter((change) =>
    change.kind === "instruction" && !change.requiresReview && change.before !== null && change.after !== null
      && normalizedProse(change.before) === normalizedProse(change.after)).map((change) => change.path));
  addReason(facts.otherChangedPaths.some((path) => !instructionHousekeeping.has(path)), "configuration or other non-source change");
  const addedTestEvidence = new Set((facts.testImpact?.changedTests ?? []).filter((test) =>
    facts.testImpact!.attributed.some((item) => item.test === test)));
  addReason(facts.addedPaths.some((path) => !addedTestEvidence.has(path)), "added path");
  addReason(facts.deletedPaths.length > 0, "deleted path");
  addReason(facts.renamedPaths.length > 0, "renamed path");
  addReason(facts.contractChanges.some((change) =>
    change.requiresReview || normalizedProse(change.before) !== normalizedProse(change.after)),
  "protected documentation or instruction contract changed");
  addReason(facts.riskTouches.some((touch) => touch.risk.length > 0), "risk-tagged feature touched before or after");

  const owners = new Set<string>();
  let movedCount = 0;
  const sourceEvidence = sources.map((path) => {
    const changes = facts.anchorChanges[path];
    addReason(!existing.has(path), "source did not exist at the base");
    addReason(changes === undefined, "coarse or unknown source analysis");
    // Even an empty precise diff needs known ownership; absence is not proof that
    // an ungoverned source is suitable for a lighter review.
    const ids = changes?.length ? changes.map((change) => change.id) : [path];
    const ownership = [...new Set(ids)].sort().map((id) => {
      const before = resolveOwner(facts.beforeRegistry, id);
      const after = resolveOwner(facts.registry, id);
      addReason(before.kind !== "owned" || after.kind !== "owned", "unresolved source ownership before or after");
      addReason(before.kind === "owned" && after.kind === "owned" && before.feature !== after.feature,
        "source ownership changed");
      const beforeRisk = before.kind === "owned" ? sortedUnique(facts.beforeRegistry.features[before.feature].risk) : [];
      const afterRisk = after.kind === "owned" ? sortedUnique(facts.registry.features[after.feature].risk) : [];
      addReason(beforeRisk.length > 0 || afterRisk.length > 0, "risk-tagged feature touched before or after");
      if (after.kind === "owned") owners.add(after.feature);
      return { id, before, after, beforeRisk, afterRisk };
    });
    for (const change of changes ?? []) {
      movedCount++;
      addReason(change.name === MODULE_ANCHOR_NAME, "module residual changed");
      addReason(change.kind !== "changed", "added or removed symbol");
      addReason(!change.fromSig || !change.toSig, "unknown symbol signature");
      addReason(change.fromSig !== undefined && change.toSig !== undefined && change.fromSig !== change.toSig,
        "symbol signature changed");
    }
    return {
      path, existing: existing.has(path), ownership,
      changes: changes === undefined ? null : [...changes]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((change) => [change.id, change.name, change.kind, change.from ?? null, change.to ?? null, change.fromSig ?? null, change.toSig ?? null]),
    };
  });

  if (movedCount > 0) {
    addReason(sources.length !== 1, "behavior spans multiple sources");
    addReason(owners.size !== 1, "behavior spans multiple feature owners");
    const tests = facts.testImpact;
    addReason(!tests || tests.changedTests.length === 0, "no attributable test evidence");
    addReason(!!tests && (tests.unattributed.length > 0 || tests.changedTests.some((test) => {
      const attributed = tests.attributed.filter((item) => item.test === test);
      return attributed.length === 0 || attributed.some((item) => !owners.has(item.feature));
    })), "test evidence is unowned or spans other features");
  } else {
    addReason((facts.testImpact?.changedTests.length ?? 0) > 0, "test change without attributable source behavior");
  }

  const evidence = {
    mode: facts.mode, complete: facts.complete, sources: sourceEvidence,
    unevaluablePaths: sortedUnique(facts.unevaluablePaths), otherChangedPaths: sortedUnique(facts.otherChangedPaths),
    addedPaths: sortedUnique(facts.addedPaths), deletedPaths: sortedUnique(facts.deletedPaths), renamedPaths: sortedUnique(facts.renamedPaths),
    contracts: [...facts.contractChanges].sort((a, b) => a.path.localeCompare(b.path))
      .map((change) => [change.path, change.kind, sortedUnique(change.owners), normalizedProse(change.before), normalizedProse(change.after), change.requiresReview]),
    risks: facts.riskTouches.map((touch) => [touch.feature, sortedUnique(touch.risk), sortedUnique(touch.files)]).sort(),
    tests: facts.testImpact ? {
      changed: sortedUnique(facts.testImpact.changedTests), unattributed: sortedUnique(facts.testImpact.unattributed),
      attributed: facts.testImpact.attributed.map((item) => [item.test, item.feature, item.via]).sort(),
    } : null,
  };
  return {
    version: REVIEW_POLICY_VERSION,
    minimum: reasons.size > 0 ? "adversarial" : movedCount > 0 ? "focused" : "none",
    reasons: [...reasons].sort(),
    factsFingerprint: createHash("sha256").update(JSON.stringify(evidence), "utf8").digest("hex"),
  };
}

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
  reviewPolicy?: ReviewPolicy;
  /** Durable documentation/invariant or declared workflow instruction changed. */
  contractChangeCount?: number;
  /** Registered non-source instructions proven to differ only in formatting. */
  housekeepingInstructionCount?: number;
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
  if (input.reviewPolicy) return input.reviewPolicy.version !== REVIEW_POLICY_VERSION || input.reviewPolicy.minimum !== "none";
  if ((input.contractChangeCount ?? 0) > 0) return true;
  const realChangeCount = input.realChangeCount - (input.housekeepingInstructionCount ?? 0);
  if (realChangeCount === 0) return false;
  if (realChangeCount > 1) return true;
  if (input.deletionCount > 0) return true;
  if (input.otherChangedCount > (input.housekeepingInstructionCount ?? 0)) return true;
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
  reviewPolicy?: ReviewPolicy;
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
  const required = requiresAdversarialReview(input);
  const policy = input.reviewPolicy ? { reviewPolicy: input.reviewPolicy } : {};
  if (findings === null) {
    return {
      ...policy,
      required,
      covered: false,
      blockingFindings: [],
      advisoryFindings: [],
      passed: !required,
      reason: required ? input.reviewPolicy
        ? `no current ${input.reviewPolicy.minimum} review covers this diff`
        : "no current adversarial review covers this diff" : null,
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
      ...policy,
      required,
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
    ...policy,
    required,
    covered: true,
    blockingFindings: [],
    advisoryFindings,
    passed: true,
    reason: null,
    adjudicated,
    unjudged,
  };
}
