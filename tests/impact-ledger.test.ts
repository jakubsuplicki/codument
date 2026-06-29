import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { summarizeImpact, buildImpactLedger } from "../src/lib/impact-ledger.js";
import { emitCaught, emitReview } from "../src/lib/review-events.js";
import type { CodumentEvent } from "../src/lib/events.js";

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
  };
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
    },
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
