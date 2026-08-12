import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Acknowledgment, ackCovers } from "./acknowledgment.js";
import { type ComovementStatus, classifyComovement } from "./co-movement.js";
import { type AnchorChange, type AnchorChangeKind, isSignatureMove } from "./fingerprint.js";
import { resolveOwner } from "./ownership.js";
import type { Registry } from "./registry.js";
import { MODULE_ANCHOR_NAME } from "./ts-adapter.js";
import { byteNormalize, readBlobAtRef } from "./two-ref.js";

// Per-symbol drift: the agent-judge-centric layer (decided 2026-06-27). For each
// moved OWNED anchor it produces a precise finding — the symbol, its fingerprint
// `from`->`to`, the owning feature + doc — annotated with the co-movement TELEMETRY
// status (info-only) and whether a recorded acknowledgment covers the exact
// transition. An acked move is "adjudicated": it is dropped from the anchor-change
// set handed to the deterministic stale-doc verdict, so a recorded "this was a
// refactor, no doc change needed" decision clears the flag (and auto-invalidates on
// the next move, since the ack is bound to this `to` fingerprint). The verdict
// itself stays deterministic; co-movement only labels the finding.

/**
 * Whether a moved anchor BLOCKS, per ADR 020: the gate blocks only where the
 * event is structurally proven and the fix it demands is checkable.
 *
 * An added or removed symbol is public surface appearing or vanishing — proven.
 * A signature move is a contract change by construction — proven. A move whose
 * two signatures are present and equal is proven body-only: implementation
 * moved, no documented contract can have gone stale from it, and the only fix
 * the gate could demand there is a signature nobody reads back.
 *
 * Body-only is PROVEN, never assumed. An anchor carrying no signature on either
 * side has nothing to compare, so it cannot be shown to have left its contract
 * alone and keeps gating — with one exception that is structural rather than a
 * guess: the module residual holds exactly what did NOT anchor as an export,
 * because every exported symbol anchors on its own, so nothing in it ever
 * carried an export's contract.
 */
export function anchorGates(ch: AnchorChange): boolean {
  if (ch.kind !== "changed") return true;
  if (isSignatureMove(ch)) return true;
  if (ch.fromSig !== undefined && ch.toSig !== undefined) return false;
  return ch.name !== MODULE_ANCHOR_NAME;
}

export interface DriftFinding {
  /** `<path>::<descriptor>` of the moved anchor. */
  anchorId: string;
  /** The symbol name (or `<module>` for the residual backstop). */
  symbol: string;
  kind: AnchorChangeKind;
  /** The feature that owns the symbol. */
  feature: string;
  /** That feature's primary doc — the one a reconciliation must move. */
  doc: string;
  from?: string;
  to?: string;
  /** True when a `changed` anchor's SIGNATURE moved — a contract change. Such a
   *  move is ineligible for any ack (per-symbol or file-grain): the owning doc's
   *  contract needs an update, not an exemption. A body-only move (`false`) keeps
   *  the ackable path. */
  signatureChanged: boolean;
  /** Whether this move GATES (ADR 020). A proven contract event — an added or
   *  removed symbol, or a signature move — blocks and owes its doc a line. A move
   *  proven body-only is reported and never reaches the stale-doc verdict. */
  gates: boolean;
  /** Info-only telemetry: did the doc's lines mentioning this symbol move? */
  comovement: ComovementStatus;
  /** A valid acknowledgment names this exact `from`->`to` transition. */
  acknowledged: boolean;
  /** The recorded reason of the covering acknowledgment, when `acknowledged` — so
   *  review/`--json` can show WHY a move was exempted, not just that it was. */
  ackReason?: string;
  /** The recorded signer of the covering acknowledgment, when `acknowledged` — so
   *  the review/report acks card can badge it self vs independent of the author. */
  ackSigner?: string;
}

export interface DriftResult {
  /** Per-symbol findings for every moved owned anchor, sorted by anchor id. */
  findings: DriftFinding[];
  /** `anchorChanges` with acknowledged (adjudicated) changes removed, for the
   *  deterministic stale-doc verdict — an acked move owes no doc change. The file
   *  key is kept even when it empties out (so the verdict treats it as "nothing
   *  woke this doc", not "fall back to file-grain"). */
  filtered: Record<string, AnchorChange[]>;
}

// Resolve drift for the moved owned anchors. Impure: reads each owning doc at the
// base ref (git) and the working tree (disk), cached per doc path.
export function computeDrift(
  root: string,
  baseRef: string,
  registry: Registry,
  anchorChanges: Record<string, AnchorChange[]>,
  acks: Acknowledgment[],
): DriftResult {
  const findings: DriftFinding[] = [];
  const filtered: Record<string, AnchorChange[]> = {};
  const docCache = new Map<string, { base: string | null; head: string | null }>();

  const docContents = (docPath: string) => {
    let c = docCache.get(docPath);
    if (!c) {
      let base: string | null;
      try {
        base = readBlobAtRef(root, baseRef, docPath);
      } catch {
        base = null;
      }
      let head: string | null;
      try {
        head = byteNormalize(readFileSync(join(root, docPath), "utf-8"));
      } catch {
        head = null;
      }
      c = { base, head };
      docCache.set(docPath, c);
    }
    return c;
  };

  for (const [file, changes] of Object.entries(anchorChanges)) {
    const kept: AnchorChange[] = [];
    for (const ch of changes) {
      const owner = resolveOwner(registry, ch.id);
      // Only FEATURE-owned anchors get a per-symbol drift finding; unowned /
      // unassigned / ambiguous are left to the change-state (concept umbrellas,
      // fail-loud lints) and pass through — but through the SAME gating predicate.
      // The ownership lint's fix is checkable, so it was tempting to let it block on
      // any move at all; the other half of ADR 020 forbids it. Under a body-only move
      // no doc is stale, so "which doc owes the line" is a question with no line
      // behind it — and letting it block anyway would keep the field's worst episode
      // (one body edit, three docs woken, prose into five) alive under a new name.
      // The registry may still be wrong; that is rot, and rot is reported, not gated.
      if (owner.kind !== "owned") {
        if (anchorGates(ch)) kept.push(ch);
        continue;
      }
      const doc = registry.features[owner.feature].doc;
      const signatureChanged = isSignatureMove(ch);
      // Acks bind to an exact `changed` transition; an added/removed symbol cannot
      // be refactor-acked (it genuinely needs doc attention). A SIGNATURE move is
      // ineligible too — the gate never honors an ack for a contract change, so a
      // laundering ack cannot clear it (it stays flagged until the doc updates).
      const coveringAck =
        ch.kind === "changed" && !signatureChanged && ch.from !== undefined && ch.to !== undefined
          ? acks.find((a) => ackCovers(a, ch.id, ch.from as string, ch.to as string))
          : undefined;
      const acknowledged = coveringAck !== undefined;
      const gates = anchorGates(ch);
      const { base, head } = docContents(doc);
      const comovement = classifyComovement(base, head, ch.name, ch.kind, {
        module: ch.name === MODULE_ANCHOR_NAME,
      });
      findings.push({
        anchorId: ch.id,
        symbol: ch.name,
        kind: ch.kind,
        feature: owner.feature,
        doc,
        from: ch.from,
        to: ch.to,
        signatureChanged,
        gates,
        comovement,
        acknowledged,
        ...(coveringAck ? { ackReason: coveringAck.reason, ackSigner: coveringAck.signer } : {}),
      });
      // A non-gating move is still REPORTED — it stays in `findings`, in the
      // ledger, and on the verdict line — but it never reaches the stale-doc
      // verdict, so it cannot block and cannot be cleared by a signature.
      if (!acknowledged && gates) kept.push(ch);
    }
    filtered[file] = kept;
  }

  findings.sort((a, b) => (a.anchorId < b.anchorId ? -1 : a.anchorId > b.anchorId ? 1 : 0));
  return { findings, filtered };
}
