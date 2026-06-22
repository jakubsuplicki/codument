import { readAllEvents, type CodumentEvent } from "./events.js";
import {
  isCaughtEvent,
  isReviewEvent,
  type ReviewTier,
  type ReviewResolution,
} from "./review-events.js";

// The all-sessions impact ledger: a pure tally of the two flow events into the
// provable/reported split the `watch` frame and `report` render. It never blends
// them — provable is computed by codument's analyzer (ungameable), reported is the
// agent's self-report (labeled, fixes-only headline). Like `cost`, it reads the
// whole append-only events log, so it is cumulative across every session.

export interface ProvableLedger {
  /** Distinct doc paths flagged stale across the whole log (not per-snapshot repeats). */
  staleDocs: number;
  /** Distinct feature names whose risk areas were touched. */
  riskTouches: number;
  /** Distinct file paths that fell off-plan. */
  offPlan: number;
  /** Number of `caught` snapshots — the ship-moments at which the analyzer ran. */
  snapshots: number;
}

export interface ReportedLedger {
  /** Headline = fixed findings at the correctness tier. The only number kept out of the gameable noise. */
  headline: number;
  /** Fixed findings by tier. */
  fixed: Record<ReviewTier, number>;
  /** Deferred findings by tier (never headline-counted). */
  deferred: Record<ReviewTier, number>;
  /** All well-formed self-reported findings (fixed + deferred, both tiers). */
  total: number;
}

export interface ImpactLedger {
  provable: ProvableLedger;
  reported: ReportedLedger;
  /** True when the analyzer caught at least one distinct thing — the provable line renders. */
  hasProvable: boolean;
  /** True when at least one well-formed self-reported finding exists — the reported line renders. */
  hasReported: boolean;
}

/** Pure tally over an event list (the reader splits I/O from logic for testability). */
export function summarizeImpact(events: CodumentEvent[]): ImpactLedger {
  const stale = new Set<string>();
  const risk = new Set<string>();
  const off = new Set<string>();
  let snapshots = 0;

  const fixed: Record<ReviewTier, number> = { correctness: 0, minor: 0 };
  const deferred: Record<ReviewTier, number> = { correctness: 0, minor: 0 };
  let total = 0;

  for (const e of events) {
    if (isCaughtEvent(e)) {
      snapshots++;
      const d = e.data as {
        staleDocs: string[];
        riskTouches: string[];
        offPlan: string[];
      };
      for (const x of d.staleDocs) stale.add(x);
      for (const x of d.riskTouches) risk.add(x);
      for (const x of d.offPlan) off.add(x);
    } else if (isReviewEvent(e)) {
      total++;
      const d = e.data as { tier: ReviewTier; resolution: ReviewResolution };
      if (d.resolution === "fixed") fixed[d.tier]++;
      else deferred[d.tier]++;
    }
  }

  const provable: ProvableLedger = {
    staleDocs: stale.size,
    riskTouches: risk.size,
    offPlan: off.size,
    snapshots,
  };
  const reported: ReportedLedger = {
    headline: fixed.correctness,
    fixed,
    deferred,
    total,
  };

  return {
    provable,
    reported,
    // A clean snapshot (analyzer ran, caught nothing) does not light up the line —
    // the section is about what was caught, not that review ran.
    hasProvable: provable.staleDocs + provable.riskTouches + provable.offPlan > 0,
    hasReported: total > 0,
  };
}

/** Read the whole events log and tally the all-sessions ledger. */
export function buildImpactLedger(root: string): ImpactLedger {
  return summarizeImpact(readAllEvents(root));
}
