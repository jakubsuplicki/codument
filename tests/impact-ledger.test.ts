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
}): CodumentEvent {
  return {
    ts: "2026-06-22T10:00:00.000Z",
    type: "caught",
    data: {
      commit: null,
      staleDocs: data.staleDocs ?? [],
      riskTouches: data.riskTouches ?? [],
      offPlan: data.offPlan ?? [],
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
