import { readAllEvents, type CodumentEvent } from "./events.js";
import {
  isCaughtEvent,
  isReviewEvent,
  type DriftTally,
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

/** The soak / calibration ledger: per-symbol drift summed across all snapshots.
 *  `frictionRate` is the fraction of RESOLVED fires that were internal-refactor
 *  acks (no doc change owed) rather than real doc updates — high means the gate is
 *  mostly firing on internal moves, the signal for whether it is quiet enough to
 *  become a required CI check. The co-movement fields are info-only telemetry for
 *  calibrating co-movement itself, never a resolution signal. Info-only. */
export interface DriftLedger {
  flagged: number;
  /** Resolved by a doc update (verdict-derived: the owning doc changed). */
  docUpdated: number;
  acknowledged: number;
  coMoved: number;
  proseUnchanged: number;
  notReferenced: number;
  /** acknowledged / (acknowledged + docUpdated); 0 when nothing has resolved yet. */
  frictionRate: number;
}

export interface ImpactLedger {
  provable: ProvableLedger;
  reported: ReportedLedger;
  drift: DriftLedger;
  /** True when the analyzer caught at least one distinct thing — the provable line renders. */
  hasProvable: boolean;
  /** True when at least one well-formed self-reported finding exists — the reported line renders. */
  hasReported: boolean;
  /** True when any drift was evaluated — the soak line renders. */
  hasDrift: boolean;
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

  const drift: DriftLedger = {
    flagged: 0,
    docUpdated: 0,
    acknowledged: 0,
    coMoved: 0,
    proseUnchanged: 0,
    notReferenced: 0,
    frictionRate: 0,
  };

  for (const e of events) {
    if (isCaughtEvent(e)) {
      snapshots++;
      const d = e.data as {
        staleDocs: string[];
        riskTouches: string[];
        offPlan: string[];
        drift?: DriftTally;
      };
      for (const x of d.staleDocs) stale.add(x);
      for (const x of d.riskTouches) risk.add(x);
      for (const x of d.offPlan) off.add(x);
      if (d.drift) {
        drift.flagged += d.drift.flagged;
        // `?? 0`: snapshots logged before docUpdated existed carry no such field.
        drift.docUpdated += d.drift.docUpdated ?? 0;
        drift.acknowledged += d.drift.acknowledged;
        drift.coMoved += d.drift.coMoved;
        drift.proseUnchanged += d.drift.proseUnchanged;
        drift.notReferenced += d.drift.notReferenced;
      }
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

  const resolved = drift.acknowledged + drift.docUpdated;
  drift.frictionRate = resolved > 0 ? drift.acknowledged / resolved : 0;

  return {
    provable,
    reported,
    drift,
    // A clean snapshot (analyzer ran, caught nothing) does not light up the line —
    // the section is about what was caught, not that review ran.
    hasProvable: provable.staleDocs + provable.riskTouches + provable.offPlan > 0,
    hasReported: total > 0,
    hasDrift: drift.flagged > 0,
  };
}

/** Read the whole events log and tally the all-sessions ledger. */
export function buildImpactLedger(root: string): ImpactLedger {
  return summarizeImpact(readAllEvents(root));
}
