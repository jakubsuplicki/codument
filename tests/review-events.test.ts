import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  emitReview,
  emitCaught,
  isReviewEvent,
  isCaughtEvent,
} from "../src/lib/review-events.js";
import { readAllEvents } from "../src/lib/events.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-revev-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("emitReview (self-reported fix)", () => {
  it("writes a well-formed review event with tier/resolution and attribution", () => {
    emitReview(
      tmp,
      {
        tier: "correctness",
        resolution: "fixed",
        feature: "auth",
        step: "3",
        summary: "off-by-one in token expiry",
      },
      { ts: "2026-06-22T10:00:00.000Z" },
    );
    const events = readAllEvents(tmp);
    assert.equal(events.length, 1);
    const [e] = events;
    assert.equal(e.type, "review");
    assert.equal(e.message, "off-by-one in token expiry");
    assert.deepEqual(e.data, {
      tier: "correctness",
      resolution: "fixed",
      feature: "auth",
      step: "3",
      summary: "off-by-one in token expiry",
    });
    assert.ok(isReviewEvent(e));
  });

  it("omits absent attribution keys (no undefined buckets)", () => {
    emitReview(tmp, { tier: "minor", resolution: "deferred" });
    const [e] = readAllEvents(tmp);
    assert.deepEqual(Object.keys(e.data ?? {}).sort(), ["resolution", "tier"]);
    assert.equal(e.message, "minor deferred");
  });

  it("rejects an invalid tier without writing an event", () => {
    assert.throws(
      () => emitReview(tmp, { tier: "blocker" as never, resolution: "fixed" }),
      /invalid review tier/,
    );
    assert.equal(readAllEvents(tmp).length, 0);
  });

  it("rejects an invalid resolution without writing an event", () => {
    assert.throws(
      () => emitReview(tmp, { tier: "minor", resolution: "ignored" as never }),
      /invalid review resolution/,
    );
    assert.equal(readAllEvents(tmp).length, 0);
  });
});

describe("emitCaught (deterministic snapshot)", () => {
  it("stores identities, dedupes within a snapshot, and records commit provenance", () => {
    emitCaught(
      tmp,
      {
        commit: "abc123",
        staleDocs: ["docs/features/a.md", "docs/features/a.md"],
        riskTouches: ["auth"],
        offPlan: ["src/x.ts", "src/y.ts"],
      },
      { ts: "2026-06-22T11:00:00.000Z" },
    );
    const [e] = readAllEvents(tmp);
    assert.equal(e.type, "caught");
    assert.deepEqual(e.data, {
      commit: "abc123",
      staleDocs: ["docs/features/a.md"],
      riskTouches: ["auth"],
      offPlan: ["src/x.ts", "src/y.ts"],
    });
    assert.ok(isCaughtEvent(e));
  });

  it("accepts a null commit (fresh repo) and empty findings", () => {
    emitCaught(tmp, { commit: null, staleDocs: [], riskTouches: [], offPlan: [] });
    const [e] = readAllEvents(tmp);
    assert.equal((e.data as { commit: unknown }).commit, null);
    assert.ok(isCaughtEvent(e));
  });
});

describe("guards distinguish the two events and reject malformed shapes", () => {
  it("isReviewEvent is false for a caught event and a legacy bare-message review", () => {
    assert.equal(
      isReviewEvent({ ts: "", type: "caught", data: { staleDocs: [], riskTouches: [], offPlan: [] } }),
      false,
    );
    assert.equal(isReviewEvent({ ts: "", type: "review", message: "diff clean" }), false);
  });

  it("isCaughtEvent is false for a review event and for missing identity arrays", () => {
    assert.equal(
      isCaughtEvent({ ts: "", type: "review", data: { tier: "minor", resolution: "fixed" } }),
      false,
    );
    assert.equal(isCaughtEvent({ ts: "", type: "caught", data: { staleDocs: [] } }), false);
  });
});
