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
  /** Of the moved anchors, those whose SIGNATURE changed — a contract move, never
   *  ackable. Splitting the fire volume into contract vs implementation churn is the
   *  signal the gate-flip decision needs: high `sigMoved` is unavoidable high-signal
   *  work; high `bodyMoved` is the noise the ack path absorbs. */
  sigMoved: number;
  /** Of the moved anchors, `changed` body-only moves — the ackable cheap-relief path. */
  bodyMoved: number;
  /** Resolved by a doc update: the owning doc changed in the diff (verdict-derived,
   *  the same signal `review` shows as "resolved by doc update"). */
  docUpdated: number;
  /** Cleared by a file-grain ack (`codument ack <path>`): an additive/coarse residue
   *  the file ack vouched for. Counted with acks (no doc change owed), not with doc
   *  updates, so the friction rate stays honest. */
  fileAcked: number;
  /** Cleared by a recorded per-symbol acknowledgment (a "refactor, no doc owed" decision). */
  acknowledged: number;
  /** Co-movement telemetry (info-only, never a resolution signal): the doc's
   *  symbol-scoped lines moved. Kept for calibrating co-movement itself. */
  coMoved: number;
  /** Co-movement telemetry: symbol referenced but its doc lines did not move. */
  proseUnchanged: number;
  /** Co-movement telemetry: the doc does not mention the symbol at all. */
  notReferenced: number;
}

/** One drift transition with its settled classification — the identity-bearing
 *  form of the tally. Identity is `anchorId` + `from`→`to` (the same binding an
 *  acknowledgment uses), so the ledger counts each transition ONCE no matter how
 *  many snapshots observed it: re-reviewing an unchanged diff with `--log`
 *  re-logs the same transitions, and raw counts would double every resolved fire
 *  the gate-flip decision is calibrated from. When later snapshots re-observe a
 *  transition in a different state (flagged, then doc-updated), the LAST
 *  observation is the settled one. */
export interface DriftTransitionRecord {
  anchorId: string;
  from: string | null;
  to: string | null;
  resolution: "flagged" | "doc-updated" | "file-acked" | "acked";
  /** Info-only co-movement class, for calibrating co-movement itself. */
  comovement: string;
  /** True when this transition is a SIGNATURE move (a contract change). Carried on
   *  the identity record so the deduped ledger can split contract vs body churn
   *  without re-deriving it. Absent on legacy snapshots (treated as false). */
  signatureChanged?: boolean;
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
  /** Per-symbol drift tally (soak signal), when the caller computed drift.
   *  Counts only — kept for the event message and for snapshots written before
   *  transitions existed; the ledger prefers `driftTransitions` when present. */
  drift?: DriftTally;
  /** The identity-bearing form the ledger dedupes on (see DriftTransitionRecord). */
  driftTransitions?: DriftTransitionRecord[];
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
      ...(snapshot.driftTransitions ? { driftTransitions: snapshot.driftTransitions } : {}),
    },
    ...(meta.ts !== undefined ? { ts: meta.ts } : {}),
  });
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((v) => typeof v === "string" && v.length > 0))];
}

/** A recorded acknowledgment, mirrored into the events log as a durable,
 *  identity-bearing AUDIT record. The loose `.codument/acks/*.json` file is the
 *  gate input but is mutable by its author; this append-only event is the trail
 *  that answers "who exempted what, on what grounds, and was it independent" from
 *  the log alone. `kind` distinguishes a self-ack (signer == the change author)
 *  from an independent sign-off. */
export interface AckEvent {
  anchorId: string;
  fromHash: string;
  toHash: string;
  reason: string;
  signer: string;
  kind: "self" | "independent";
  /** Tree grain only: how many files this one exemption covered. The log is the
   *  record of who exempted what, so a vouch that covered a whole tree must not read
   *  there as a vouch over one path. */
  covers?: number;
}

/** Append an `ack` event when an acknowledgment is recorded — full identity, not
 *  a count, so a self-exemption is auditable (and visible as a self-ack) from the
 *  events log, not only from a file the author controls. */
export function emitAck(root: string, ack: AckEvent, meta: EmitMeta = {}): void {
  appendEvent(root, {
    type: "ack",
    message: `ack (${ack.kind}) ${ack.anchorId}`,
    data: { ...ack },
    ...(meta.ts !== undefined ? { ts: meta.ts } : {}),
  });
}

/** Append an `ack-remove` event when an acknowledgment is retracted, so a cleared
 *  gate can never be silently un-recorded. */
export function emitAckRemove(
  root: string,
  handle: string,
  anchorId: string | null,
  meta: EmitMeta = {},
): void {
  appendEvent(root, {
    type: "ack-remove",
    message: `ack-remove ${handle}`,
    data: { handle, anchorId },
    ...(meta.ts !== undefined ? { ts: meta.ts } : {}),
  });
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
