import { appendEvent, type CodumentEvent } from "./events.js";

// The impact-ledger event contract. Two flow events in .codument/events.jsonl,
// with opposite trust levels — kept as distinct types so the aggregator and the
// `watch` frame can never blend them into one number:
//
//   "caught"  — DETERMINISTIC. Codument's own analyzer output, snapshotted at a
//               commit boundary by `review --log`. Stores finding IDENTITIES, not
//               bare counts, so the ledger can count DISTINCT things caught and a
//               later pass can derive flagged-then-fixed. Provable: the agent
//               triggers the snapshot but cannot set the numbers.
//   "review"  — SELF-REPORTED. One resolved review finding the agent emitted via
//               `emit review`, with a coarse tier. Gameable by construction, so it
//               is always rendered labeled and only fixed/correctness feeds the
//               headline (enforced by the aggregator, Step 2).

/** Coarse review tier. `correctness` covers safety/security/data-loss/logic; `minor` is nits/style. */
export type ReviewTier = "correctness" | "minor";
export type ReviewResolution = "fixed" | "deferred";

const TIERS: readonly ReviewTier[] = ["correctness", "minor"];
const RESOLUTIONS: readonly ReviewResolution[] = ["fixed", "deferred"];

/** A single review finding the agent resolved (or deferred) before commit — self-reported. */
export interface ReviewFix {
  tier: ReviewTier;
  resolution: ReviewResolution;
  feature?: string;
  step?: string;
  summary?: string;
}

export interface EmitMeta {
  /** Override the wall-clock timestamp (tests/replay); defaults to now. */
  ts?: string;
}

/**
 * Append a `review` event — the self-reported line of the impact ledger. Throws
 * on an invalid tier/resolution rather than writing a malformed event, so the
 * aggregator only ever sees well-formed fixes.
 */
export function emitReview(root: string, fix: ReviewFix, meta: EmitMeta = {}): void {
  if (!TIERS.includes(fix.tier)) {
    throw new Error(`invalid review tier "${fix.tier}" (expected: ${TIERS.join(", ")})`);
  }
  if (!RESOLUTIONS.includes(fix.resolution)) {
    throw new Error(
      `invalid review resolution "${fix.resolution}" (expected: ${RESOLUTIONS.join(", ")})`,
    );
  }
  const data: Record<string, unknown> = {
    tier: fix.tier,
    resolution: fix.resolution,
  };
  // Attribution keys are omitted when absent, so readers don't grow undefined buckets.
  if (fix.feature !== undefined) data.feature = fix.feature;
  if (fix.step !== undefined) data.step = fix.step;
  if (fix.summary !== undefined) data.summary = fix.summary;

  appendEvent(root, {
    type: "review",
    message: fix.summary ?? `${fix.tier} ${fix.resolution}`,
    data,
    ...(meta.ts !== undefined ? { ts: meta.ts } : {}),
  });
}

/** Per-snapshot tally of the per-symbol drift findings — the soak / calibration
 *  signal. Counts (not identities) because each fingerprint transition is unique;
 *  summed across snapshots they give the friction readout that decides if the
 *  deterministic gate is quiet enough to become a required CI check. */
export interface DriftTally {
  /** Moved owned anchors evaluated this snapshot. */
  flagged: number;
  /** Doc's symbol-scoped lines moved (co-movement telemetry: likely reconciled). */
  coMoved: number;
  /** Symbol referenced but its doc lines did not move. */
  proseUnchanged: number;
  /** The doc does not mention the symbol at all. */
  notReferenced: number;
  /** Cleared by a recorded acknowledgment (a "refactor, no doc owed" decision). */
  acknowledged: number;
}

/** Deterministic snapshot of what the analyzer flagged at a commit boundary. Identities, not counts. */
export interface CaughtSnapshot {
  /** HEAD sha the pending change sits on, or null (fresh repo / no git). Provenance, not a dedup key. */
  commit: string | null;
  /** Doc paths flagged stale. */
  staleDocs: string[];
  /** Feature names whose risk-tagged areas were touched. */
  riskTouches: string[];
  /** File paths that fell outside the approved plan. */
  offPlan: string[];
  /** Per-symbol drift tally (soak signal), when the caller computed drift. */
  drift?: DriftTally;
}

/**
 * Append a `caught` event — the provable line of the impact ledger. Each identity
 * list is deduped (a doc flagged twice in one snapshot is one identity); the
 * cross-snapshot distinct count is the aggregator's job (Step 2).
 */
export function emitCaught(root: string, snapshot: CaughtSnapshot, meta: EmitMeta = {}): void {
  const staleDocs = dedupeStrings(snapshot.staleDocs);
  const riskTouches = dedupeStrings(snapshot.riskTouches);
  const offPlan = dedupeStrings(snapshot.offPlan);

  appendEvent(root, {
    type: "caught",
    message: `${staleDocs.length} stale, ${riskTouches.length} risk, ${offPlan.length} off-plan`,
    data: {
      commit: snapshot.commit,
      staleDocs,
      riskTouches,
      offPlan,
      ...(snapshot.drift ? { drift: snapshot.drift } : {}),
    },
    ...(meta.ts !== undefined ? { ts: meta.ts } : {}),
  });
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((v) => typeof v === "string" && v.length > 0))];
}

/** True for a well-formed self-reported review-fix event (legacy bare-message `review` events are not). */
export function isReviewEvent(e: CodumentEvent): boolean {
  if (e.type !== "review" || !e.data || typeof e.data !== "object") return false;
  const d = e.data as Record<string, unknown>;
  return (
    TIERS.includes(d.tier as ReviewTier) &&
    RESOLUTIONS.includes(d.resolution as ReviewResolution)
  );
}

/** True for a well-formed deterministic caught-snapshot event. */
export function isCaughtEvent(e: CodumentEvent): boolean {
  if (e.type !== "caught" || !e.data || typeof e.data !== "object") return false;
  const d = e.data as Record<string, unknown>;
  return (
    Array.isArray(d.staleDocs) && Array.isArray(d.riskTouches) && Array.isArray(d.offPlan)
  );
}
