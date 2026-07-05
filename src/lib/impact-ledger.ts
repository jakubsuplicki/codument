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

/** The soak / calibration ledger: per-symbol drift across all snapshots, deduped
 *  by transition identity (anchorId + from→to, last observation wins) so a
 *  re-logged unchanged diff cannot inflate it; legacy count-only snapshots sum as
 *  recorded. `frictionRate` is the fraction of RESOLVED fires that were
 *  internal-refactor acks (no doc change owed) rather than real doc updates —
 *  high means the gate is mostly firing on internal moves, the signal for
 *  whether it is quiet enough to become a required CI check. The co-movement
 *  fields are info-only telemetry for calibrating co-movement itself, never a
 *  resolution signal. Info-only. */
export interface DriftLedger {
  flagged: number;
  /** Resolved by a doc update (verdict-derived: the owning doc changed). */
  docUpdated: number;
  /** Resolved by a file-grain ack (additive/coarse residue) — a "no doc owed" decision. */
  fileAcked: number;
  acknowledged: number;
  coMoved: number;
  proseUnchanged: number;
  notReferenced: number;
  /** (acknowledged + fileAcked) / (acknowledged + fileAcked + docUpdated) — the
   *  fraction of resolved fires that owed no doc change; 0 when nothing has resolved
   *  yet. Both ack kinds sit on the friction side; only a real doc update is not. */
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
    fileAcked: 0,
    acknowledged: 0,
    coMoved: 0,
    proseUnchanged: 0,
    notReferenced: 0,
    frictionRate: 0,
  };

  // Transition-identity dedup: one entry per anchorId+from→to, LAST observation
  // wins (events are chronological, so a transition first seen flagged and later
  // resolved settles in its final class). Mirrors the provable-line Set dedup —
  // re-logging an unchanged diff cannot inflate the counts frictionRate (the
  // gate-flip calibration signal) is derived from.
  const transitions = new Map<string, { resolution: string; comovement: string }>();

  for (const e of events) {
    if (isCaughtEvent(e)) {
      snapshots++;
      const d = e.data as {
        staleDocs: string[];
        riskTouches: string[];
        offPlan: string[];
        drift?: DriftTally;
        driftTransitions?: { anchorId: string; from: string | null; to: string | null; resolution: string; comovement: string }[];
      };
      for (const x of d.staleDocs) stale.add(x);
      for (const x of d.riskTouches) risk.add(x);
      for (const x of d.offPlan) off.add(x);
      if (Array.isArray(d.driftTransitions)) {
        for (const t of d.driftTransitions) {
          transitions.set(`${t.anchorId}@${t.from}->${t.to}`, {
            resolution: t.resolution,
            comovement: t.comovement,
          });
        }
      } else if (d.drift) {
        // Legacy snapshot (counts only, pre-identity): sum as before — such data
        // cannot be deduped after the fact, an accepted bound on old logs.
        drift.flagged += d.drift.flagged;
        // `?? 0`: snapshots logged before docUpdated/fileAcked existed carry no such field.
        drift.docUpdated += d.drift.docUpdated ?? 0;
        drift.fileAcked += d.drift.fileAcked ?? 0;
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

  // Fold the deduped transition identities into the ledger counts (on top of any
  // legacy count-only snapshots): each transition contributes exactly once, in
  // its settled class.
  for (const t of transitions.values()) {
    drift.flagged++;
    if (t.resolution === "doc-updated") drift.docUpdated++;
    else if (t.resolution === "file-acked") drift.fileAcked++;
    else if (t.resolution === "acked") drift.acknowledged++;
    if (t.comovement === "co-moved") drift.coMoved++;
    else if (t.comovement === "prose-unchanged") drift.proseUnchanged++;
    else if (t.comovement === "not-referenced") drift.notReferenced++;
  }

  // Both ack kinds (per-symbol + file-grain) owe no doc change → the friction side;
  // only a real doc update is not. A file-ack must not deflate friction as if it
  // were a doc update.
  const noDocOwed = drift.acknowledged + drift.fileAcked;
  const resolved = noDocOwed + drift.docUpdated;
  drift.frictionRate = resolved > 0 ? noDocOwed / resolved : 0;

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
