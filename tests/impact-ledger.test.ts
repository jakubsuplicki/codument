import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { summarizeImpact, buildImpactLedger } from "../src/lib/impact-ledger.js";
import { emitCaught, emitReview } from "../src/lib/review-events.js";
import type { CodumentEvent } from "../src/lib/events.js";

interface TransitionInput {
  anchorId: string;
  from: string | null;
  to: string | null;
  resolution: "flagged" | "doc-updated" | "file-acked" | "acked";
  comovement: string;
  signatureChanged?: boolean;
}

function caught(data: {
  staleDocs?: string[];
  riskTouches?: string[];
  offPlan?: string[];
  drift?: {
    flagged: number;
    docUpdated: number;
    coMoved: number;
    proseUnchanged: number;
    notReferenced: number;
    acknowledged: number;
    fileAcked?: number;
    sigMoved?: number;
    bodyMoved?: number;
  };
  driftTransitions?: TransitionInput[];
}): CodumentEvent {
  return {
    ts: "2026-06-22T10:00:00.000Z",
    type: "caught",
    data: {
      commit: null,
      staleDocs: data.staleDocs ?? [],
      riskTouches: data.riskTouches ?? [],
      offPlan: data.offPlan ?? [],
      ...(data.drift ? { drift: data.drift } : {}),
      ...(data.driftTransitions ? { driftTransitions: data.driftTransitions } : {}),
    },
  };
}

function transition(partial: Partial<TransitionInput> & { anchorId: string }): TransitionInput {
  return {
    from: "f0",
    to: "f1",
    resolution: "acked",
    comovement: "not-referenced",
    ...partial,
  };
}

function review(tier: string, resolution: string): CodumentEvent {
  return { ts: "2026-06-22T10:00:00.000Z", type: "review", data: { tier, resolution } };
}

describe("summarizeImpact — provable line", () => {
  it("counts DISTINCT identities across snapshots, not per-snapshot repeats", () => {
    const ledger = summarizeImpact([
      caught({ staleDocs: ["docs/a.md", "docs/b.md"], riskTouches: ["auth"] }),
      caught({ staleDocs: ["docs/a.md"], riskTouches: ["auth", "billing"], offPlan: ["src/x.ts"] }),
    ]);
    // docs/a.md flagged in both snapshots → counted once
    assert.equal(ledger.provable.staleDocs, 2);
    assert.equal(ledger.provable.riskTouches, 2);
    assert.equal(ledger.provable.offPlan, 1);
    assert.equal(ledger.provable.snapshots, 2);
    assert.equal(ledger.hasProvable, true);
  });

  it("a clean snapshot (analyzer ran, caught nothing) does not light up the line", () => {
    const ledger = summarizeImpact([caught({}), caught({})]);
    assert.equal(ledger.provable.snapshots, 2);
    assert.equal(ledger.hasProvable, false);
  });
});

describe("summarizeImpact — drift soak line", () => {
  it("computes friction from acked-vs-doc-update (verdict-derived), not co-movement", () => {
    const ledger = summarizeImpact([
      caught({ drift: { flagged: 5, docUpdated: 2, acknowledged: 1, coMoved: 3, proseUnchanged: 1, notReferenced: 0 } }),
      caught({ drift: { flagged: 4, docUpdated: 2, acknowledged: 3, coMoved: 0, proseUnchanged: 0, notReferenced: 1 } }),
    ]);
    assert.equal(ledger.drift.flagged, 9);
    assert.equal(ledger.drift.docUpdated, 4);
    assert.equal(ledger.drift.acknowledged, 4);
    // co-movement is summed as separate info-only telemetry (3), and must NOT feed friction
    assert.equal(ledger.drift.coMoved, 3);
    // friction = acked / (acked + docUpdated) = 4 / 8 = 0.5  (would be 4/7 if it used coMoved)
    assert.equal(ledger.drift.frictionRate, 0.5);
    assert.equal(ledger.hasDrift, true);
  });

  it("counts a file-grain ack on the friction side (no doc owed), not as a doc update", () => {
    const ledger = summarizeImpact([
      caught({
        drift: { flagged: 3, docUpdated: 1, fileAcked: 1, acknowledged: 1, coMoved: 0, proseUnchanged: 0, notReferenced: 0 },
      }),
    ]);
    assert.equal(ledger.drift.fileAcked, 1);
    assert.equal(ledger.drift.docUpdated, 1);
    // friction = (acked + fileAcked) / (acked + fileAcked + docUpdated) = 2 / 3
    assert.equal(ledger.drift.frictionRate, 2 / 3);
  });

  it("treats a pre-docUpdated snapshot's missing field as 0 (backward compatible)", () => {
    // An old `caught` event logged before docUpdated existed.
    const legacy = {
      ts: "2026-06-22T10:00:00.000Z",
      type: "caught" as const,
      data: {
        commit: null,
        staleDocs: [],
        riskTouches: [],
        offPlan: [],
        drift: { flagged: 3, coMoved: 2, proseUnchanged: 0, notReferenced: 1, acknowledged: 1 },
      },
    } as unknown as CodumentEvent;
    const ledger = summarizeImpact([legacy]);
    assert.equal(ledger.drift.docUpdated, 0);
    assert.equal(ledger.drift.frictionRate, 1); // acked 1 / (1 + 0)
  });

  it("is inert (no friction, hidden) when no snapshot carried drift", () => {
    const ledger = summarizeImpact([caught({ staleDocs: ["docs/a.md"] })]);
    assert.equal(ledger.drift.flagged, 0);
    assert.equal(ledger.drift.frictionRate, 0);
    assert.equal(ledger.hasDrift, false);
  });
});

describe("summarizeImpact — signature/body split (contract vs implementation churn)", () => {
  it("splits deduped transitions into contract (signature) vs body moves", () => {
    const ledger = summarizeImpact([
      caught({
        driftTransitions: [
          transition({ anchorId: "src/a.ts::foo().", signatureChanged: true, resolution: "flagged" }),
          transition({ anchorId: "src/a.ts::bar().", signatureChanged: false, resolution: "acked" }),
          transition({ anchorId: "src/a.ts::baz().", signatureChanged: false, resolution: "doc-updated" }),
        ],
      }),
    ]);
    assert.equal(ledger.drift.flagged, 3);
    assert.equal(ledger.drift.sigMoved, 1, "one contract move");
    assert.equal(ledger.drift.bodyMoved, 2, "two body-only moves");
  });

  it("does not count an added/removed transition as a body move (only `changed` transitions)", () => {
    const ledger = summarizeImpact([
      caught({
        driftTransitions: [
          transition({ anchorId: "src/a.ts::added().", from: null, to: "f1", resolution: "doc-updated" }),
          transition({ anchorId: "src/a.ts::removed().", from: "f0", to: null, resolution: "doc-updated" }),
          transition({ anchorId: "src/a.ts::changed().", from: "f0", to: "f1", resolution: "acked" }),
        ],
      }),
    ]);
    assert.equal(ledger.drift.flagged, 3);
    assert.equal(ledger.drift.sigMoved, 0);
    assert.equal(ledger.drift.bodyMoved, 1, "only the changed transition is a body move");
  });

  it("dedupes the split across re-logged snapshots (last observation wins)", () => {
    const t = transition({ anchorId: "src/a.ts::foo().", signatureChanged: true, resolution: "flagged" });
    const ledger = summarizeImpact([
      caught({ driftTransitions: [t] }),
      // the same transition re-logged, now doc-updated — still ONE contract move
      caught({ driftTransitions: [{ ...t, resolution: "doc-updated" }] }),
    ]);
    assert.equal(ledger.drift.flagged, 1);
    assert.equal(ledger.drift.sigMoved, 1);
    assert.equal(ledger.drift.docUpdated, 1);
  });

  it("sums a legacy count-only snapshot's split, and treats a pre-split snapshot as 0", () => {
    const ledger = summarizeImpact([
      caught({
        drift: { flagged: 4, sigMoved: 1, bodyMoved: 3, docUpdated: 2, acknowledged: 2, coMoved: 0, proseUnchanged: 0, notReferenced: 0 },
      }),
      // a snapshot logged before the split existed carries neither field → 0
      caught({
        drift: { flagged: 2, docUpdated: 1, acknowledged: 1, coMoved: 0, proseUnchanged: 0, notReferenced: 0 },
      }),
    ]);
    assert.equal(ledger.drift.sigMoved, 1);
    assert.equal(ledger.drift.bodyMoved, 3);
  });
});

describe("summarizeImpact — transition-identity dedup (idempotent soak data)", () => {
  const resolvedDiff = [
    transition({ anchorId: "src/a.ts::foo().", resolution: "acked", comovement: "co-moved" }),
    transition({ anchorId: "src/a.ts::bar().", resolution: "doc-updated", comovement: "prose-unchanged" }),
  ];

  it("re-logging the same resolved diff yields IDENTICAL tallies to logging it once", () => {
    const once = summarizeImpact([caught({ driftTransitions: resolvedDiff })]);
    const twice = summarizeImpact([
      caught({ driftTransitions: resolvedDiff }),
      caught({ driftTransitions: resolvedDiff }),
    ]);
    assert.deepStrictEqual(twice.drift, once.drift, "frictionRate inputs are idempotent under re-review");
    assert.equal(twice.drift.flagged, 2);
    assert.equal(twice.drift.acknowledged, 1);
    assert.equal(twice.drift.docUpdated, 1);
    assert.equal(twice.drift.frictionRate, 0.5);
  });

  it("distinct transitions still accumulate (a re-moved anchor is a NEW transition)", () => {
    const ledger = summarizeImpact([
      caught({ driftTransitions: [transition({ anchorId: "src/a.ts::foo().", from: "f0", to: "f1" })] }),
      // same anchor moved AGAIN — different to-hash, a genuinely new fire
      caught({ driftTransitions: [transition({ anchorId: "src/a.ts::foo().", from: "f1", to: "f2" })] }),
    ]);
    assert.equal(ledger.drift.flagged, 2);
  });

  it("the LAST observation of a transition settles its class (flagged → doc-updated counts once, resolved)", () => {
    const ledger = summarizeImpact([
      caught({
        driftTransitions: [
          transition({ anchorId: "src/a.ts::foo().", resolution: "flagged", comovement: "not-referenced" }),
        ],
      }),
      caught({
        driftTransitions: [
          transition({ anchorId: "src/a.ts::foo().", resolution: "doc-updated", comovement: "not-referenced" }),
        ],
      }),
    ]);
    assert.equal(ledger.drift.flagged, 1, "one transition, not two");
    assert.equal(ledger.drift.docUpdated, 1, "settled in its final class");
    assert.equal(ledger.drift.frictionRate, 0);
  });

  it("legacy count-only snapshots still sum, alongside deduped transitions", () => {
    const ledger = summarizeImpact([
      caught({ drift: { flagged: 2, docUpdated: 1, acknowledged: 1, coMoved: 0, proseUnchanged: 0, notReferenced: 2 } }),
      caught({ driftTransitions: [transition({ anchorId: "src/b.ts::baz()." })] }),
    ]);
    assert.equal(ledger.drift.flagged, 3, "2 legacy + 1 deduped");
    assert.equal(ledger.drift.acknowledged, 2);
  });
});

describe("summarizeImpact — reported line", () => {
  it("headline counts only fixed×correctness; deferred and minor are tracked but excluded", () => {
    const ledger = summarizeImpact([
      review("correctness", "fixed"),
      review("correctness", "fixed"),
      review("correctness", "deferred"),
      review("minor", "fixed"),
      review("minor", "deferred"),
    ]);
    assert.equal(ledger.reported.headline, 2);
    assert.deepEqual(ledger.reported.fixed, { correctness: 2, minor: 1 });
    assert.deepEqual(ledger.reported.deferred, { correctness: 1, minor: 1 });
    assert.equal(ledger.reported.total, 5);
    assert.equal(ledger.hasReported, true);
  });

  it("ignores legacy bare-message review events (no tier/resolution)", () => {
    const ledger = summarizeImpact([
      { ts: "", type: "review", message: "diff clean" },
      review("correctness", "fixed"),
    ]);
    assert.equal(ledger.reported.total, 1);
    assert.equal(ledger.reported.headline, 1);
  });
});

describe("summarizeImpact — section visibility", () => {
  it("an empty log yields zeros and hides both lines", () => {
    const ledger = summarizeImpact([]);
    assert.equal(ledger.hasProvable, false);
    assert.equal(ledger.hasReported, false);
    assert.equal(ledger.reported.headline, 0);
  });

  it("caught-only log shows provable but not reported", () => {
    const ledger = summarizeImpact([caught({ staleDocs: ["docs/a.md"] })]);
    assert.equal(ledger.hasProvable, true);
    assert.equal(ledger.hasReported, false);
  });
});

describe("buildImpactLedger — reads the events log", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "codument-ledger-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("tallies events written by the real producers", () => {
    emitCaught(tmp, { commit: "a", staleDocs: ["docs/a.md"], riskTouches: ["auth"], offPlan: [] });
    emitCaught(tmp, { commit: "b", staleDocs: ["docs/a.md", "docs/b.md"], riskTouches: [], offPlan: [] });
    emitReview(tmp, { tier: "correctness", resolution: "fixed", summary: "x" });
    emitReview(tmp, { tier: "minor", resolution: "deferred" });

    const ledger = buildImpactLedger(tmp);
    assert.equal(ledger.provable.staleDocs, 2);
    assert.equal(ledger.provable.riskTouches, 1);
    assert.equal(ledger.provable.snapshots, 2);
    assert.equal(ledger.reported.headline, 1);
    assert.equal(ledger.reported.total, 2);
  });
});
