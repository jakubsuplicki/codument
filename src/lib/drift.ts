import { readFileSync } from "node:fs";
import { join } from "node:path";
import { byteNormalize, readBlobAtRef } from "./two-ref.js";
import { resolveOwner } from "./ownership.js";
import { classifyComovement, type ComovementStatus } from "./co-movement.js";
import { ackCovers, type Acknowledgment } from "./acknowledgment.js";
import { MODULE_ANCHOR_NAME } from "./ts-adapter.js";
import type { Registry } from "./registry.js";
import type { AnchorChange, AnchorChangeKind } from "./fingerprint.js";

// Per-symbol drift: the agent-judge-centric layer (decided 2026-06-27). For each
// moved OWNED anchor it produces a precise finding — the symbol, its fingerprint
// `from`->`to`, the owning feature + doc — annotated with the co-movement TELEMETRY
// status (info-only) and whether a recorded acknowledgment covers the exact
// transition. An acked move is "adjudicated": it is dropped from the anchor-change
// set handed to the deterministic stale-doc verdict, so a recorded "this was a
// refactor, no doc change needed" decision clears the flag (and auto-invalidates on
// the next move, since the ack is bound to this `to` fingerprint). The verdict
// itself stays deterministic; co-movement only labels the finding.

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
  /** Info-only telemetry: did the doc's lines mentioning this symbol move? */
  comovement: ComovementStatus;
  /** A valid acknowledgment names this exact `from`->`to` transition. */
  acknowledged: boolean;
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
      // fail-loud lints) and pass through unfiltered.
      if (owner.kind !== "owned") {
        kept.push(ch);
        continue;
      }
      const doc = registry.features[owner.feature].doc;
      // Acks bind to an exact `changed` transition; an added/removed symbol cannot
      // be refactor-acked (it genuinely needs doc attention).
      const acknowledged =
        ch.kind === "changed" &&
        ch.from !== undefined &&
        ch.to !== undefined &&
        acks.some((a) => ackCovers(a, ch.id, ch.from as string, ch.to as string));
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
        comovement,
        acknowledged,
      });
      if (!acknowledged) kept.push(ch);
    }
    filtered[file] = kept;
  }

  findings.sort((a, b) => (a.anchorId < b.anchorId ? -1 : a.anchorId > b.anchorId ? 1 : 0));
  return { findings, filtered };
}
