import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CodumentEvent } from "../src/lib/events.js";
import { summarizeTokens, isTokenEvent } from "../src/lib/token-report.js";

function close(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} to be within ${eps} of ${expected}`,
  );
}

let seq = 0;
function tok(data: Record<string, unknown>, ts?: string): CodumentEvent {
  return {
    type: "tokens",
    ts: ts ?? `2026-06-16T10:00:${String(seq++ % 60).padStart(2, "0")}.000Z`,
    data,
  };
}
const ev = (type: string, message?: string): CodumentEvent => ({
  type,
  ts: "2026-06-16T10:00:00.000Z",
  ...(message !== undefined ? { message } : {}),
});

describe("summarizeTokens", () => {
  it("returns all-zero priced totals for an empty log (NOT null cost)", () => {
    const s = summarizeTokens([]);
    assert.deepEqual(s.totals.usage, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
    assert.equal(s.totals.eventCount, 0);
    assert.deepEqual(s.totals.cost, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
      total: 0,
      unpriced: false,
    });
    assert.deepEqual(s.byFeature, {});
    assert.deepEqual(s.byStep, {});
    assert.deepEqual(s.byModel, {});
    assert.deepEqual(s.unpriced, []);
  });

  it("folds a single fully-attributed event into every grouping", () => {
    const s = summarizeTokens([
      tok({
        model: "opus-4.8",
        input: 1_000_000,
        output: 500_000,
        cacheRead: 2_000_000,
        cacheCreate: 400_000,
        feature: "auth",
        step: "login-form",
      }),
    ]);
    const usage = { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheCreate: 400_000 };
    assert.deepEqual(s.totals.usage, usage);
    assert.equal(s.totals.eventCount, 1);
    const c = s.totals.cost!;
    close(c.input, 5);
    close(c.output, 12.5);
    close(c.cacheRead, 1);
    close(c.cacheCreate, 2.5);
    close(c.total, 21);
    assert.deepEqual(s.byFeature["auth"].usage, usage);
    assert.deepEqual(s.byStep["login-form"].usage, usage);
    assert.deepEqual(s.byModel["opus-4.8"].usage, usage);
    assert.deepEqual(s.unpriced, []);
  });

  it("prices a realistic cache-heavy event with cacheRead cheap despite huge count", () => {
    const s = summarizeTokens([
      tok({ model: "opus-4.8", input: 12_000, output: 3_400, cacheRead: 880_000, cacheCreate: 45_000 }),
    ]);
    close(s.totals.cost!.total, 0.86625);
    assert.ok(s.totals.usage.cacheRead > s.totals.usage.input * 50);
    assert.ok(s.totals.cost!.cacheRead < s.totals.cost!.total);
  });

  it("ignores non-token events — a step's data.feature must not create a bucket", () => {
    const s = summarizeTokens([
      ev("review", "diff clean"),
      { type: "step", ts: "2026-06-16T10:00:00.000Z", data: { feature: "auth" } },
      ev("note", "fyi"),
    ]);
    assert.equal(s.totals.eventCount, 0);
    assert.deepEqual(s.totals.usage, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
    assert.deepEqual(s.byFeature, {});
    assert.deepEqual(s.byModel, {});
    assert.deepEqual(s.unpriced, []);
  });

  it("folds only the token events out of a mixed stream", () => {
    const s = summarizeTokens([
      ev("review"),
      tok({ model: "opus-4.8", input: 1000, output: 200, cacheRead: 50_000, cacheCreate: 3000, feature: "auth" }),
      ev("note", "hi"),
      tok({ model: "opus-4.8", input: 500, output: 100, cacheRead: 20_000, cacheCreate: 1000, feature: "auth" }),
    ]);
    assert.deepEqual(s.totals.usage, { input: 1500, output: 300, cacheRead: 70_000, cacheCreate: 4000 });
    close(s.totals.cost!.total, 0.075);
    close(s.byFeature["auth"].cost!.total, 0.075);
  });

  it("routes missing feature/step into a '(none)' bucket", () => {
    const s = summarizeTokens([
      tok({ model: "opus-4.8", input: 2000, output: 400, cacheRead: 100_000, cacheCreate: 5000, feature: "auth" }),
      tok({ model: "opus-4.8", input: 800, output: 150, cacheRead: 30_000, cacheCreate: 1500 }),
    ]);
    assert.deepEqual(Object.keys(s.byFeature).sort(), ["(none)", "auth"]);
    assert.deepEqual(Object.keys(s.byStep), ["(none)"]);
    assert.deepEqual(s.byFeature["auth"].usage, { input: 2000, output: 400, cacheRead: 100_000, cacheCreate: 5000 });
    assert.deepEqual(s.byFeature["(none)"].usage, { input: 800, output: 150, cacheRead: 30_000, cacheCreate: 1500 });
    assert.deepEqual(s.byStep["(none)"].usage, { input: 2800, output: 550, cacheRead: 130_000, cacheCreate: 6500 });
    close(s.byFeature["(none)"].cost!.total, 0.032125);
  });

  it("coalesces blank and whitespace feature/step into '(none)'", () => {
    const s = summarizeTokens([
      tok({ model: "opus-4.8", input: 1, output: 1, cacheRead: 1, cacheCreate: 1, feature: "", step: "\t" }),
      tok({ model: "opus-4.8", input: 1, output: 1, cacheRead: 1, cacheCreate: 1, feature: "   ", step: "\t" }),
    ]);
    assert.deepEqual(Object.keys(s.byFeature), ["(none)"]);
    assert.deepEqual(Object.keys(s.byStep), ["(none)"]);
    assert.equal(s.byFeature["(none)"].eventCount, 2);
    assert.equal(s.byStep["(none)"].eventCount, 2);
  });

  it("splits per model with the right rate row each (no rate transposition)", () => {
    const s = summarizeTokens([
      tok({ model: "opus-4.8", input: 1500, output: 300, cacheRead: 70_000, cacheCreate: 4000 }),
      tok({ model: "sonnet-4.6", input: 10_000, output: 2000, cacheRead: 100_000, cacheCreate: 8000 }),
      tok({ model: "haiku-4.5", input: 10_000, output: 2000, cacheRead: 100_000, cacheCreate: 8000 }),
    ]);
    assert.deepEqual(Object.keys(s.byModel).sort(), ["haiku-4.5", "opus-4.8", "sonnet-4.6"]);
    assert.deepEqual(s.totals.usage, { input: 21_500, output: 4300, cacheRead: 270_000, cacheCreate: 20_000 });
    close(s.byModel["opus-4.8"].cost!.total, 0.075);
    close(s.byModel["sonnet-4.6"].cost!.total, 0.12);
    close(s.byModel["haiku-4.5"].cost!.total, 0.04);
    close(s.byModel["sonnet-4.6"].cost!.cacheRead, 0.03);
    close(s.byModel["sonnet-4.6"].cost!.cacheCreate, 0.03);
    close(s.totals.cost!.total, 0.235);
    assert.deepEqual(s.unpriced, []);
  });

  it("reconciles per-feature and per-step sums back to the totals", () => {
    const s = summarizeTokens([
      tok({ model: "opus-4.8", input: 3000, output: 300, cacheRead: 30_000, cacheCreate: 1500, feature: "auth", step: "s1" }),
      tok({ model: "opus-4.8", input: 1000, output: 100, cacheRead: 10_000, cacheCreate: 500, feature: "billing", step: "s1" }),
      tok({ model: "opus-4.8", input: 500, output: 50, cacheRead: 5000, cacheCreate: 250, feature: "billing", step: "s2" }),
    ]);
    assert.deepEqual(Object.keys(s.byFeature).sort(), ["auth", "billing"]);
    assert.deepEqual(Object.keys(s.byStep).sort(), ["s1", "s2"]);
    assert.deepEqual(s.byFeature["auth"].usage, { input: 3000, output: 300, cacheRead: 30_000, cacheCreate: 1500 });
    assert.deepEqual(s.byStep["s1"].usage, { input: 4000, output: 400, cacheRead: 40_000, cacheCreate: 2000 });
    const sumBuckets = (rollups: { usage: { input: number; output: number; cacheRead: number; cacheCreate: number } }[]) =>
      rollups.reduce(
        (a, r) => ({
          input: a.input + r.usage.input,
          output: a.output + r.usage.output,
          cacheRead: a.cacheRead + r.usage.cacheRead,
          cacheCreate: a.cacheCreate + r.usage.cacheCreate,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      );
    assert.deepEqual(sumBuckets(Object.values(s.byFeature)), s.totals.usage);
    assert.deepEqual(sumBuckets(Object.values(s.byStep)), s.totals.usage);
  });

  it("defaults missing buckets to 0", () => {
    const s = summarizeTokens([
      tok({ model: "opus-4.8", input: 1000 }),
      tok({ model: "opus-4.8", cacheRead: 100_000 }),
    ]);
    assert.deepEqual(s.totals.usage, { input: 1000, output: 0, cacheRead: 100_000, cacheCreate: 0 });
    close(s.totals.cost!.total, 0.055);
    assert.ok(Number.isFinite(s.totals.cost!.total) && !Number.isNaN(s.totals.cost!.total));
    assert.equal(s.totals.eventCount, 2);
  });

  it("coerces wrong-typed buckets to 0 (numeric string '5000' -> 0, not 5000)", () => {
    const s = summarizeTokens([
      tok({ model: "opus-4.8", input: 1000, output: "5000", cacheRead: 10_000, cacheCreate: null }),
      tok({ model: "opus-4.8", input: NaN, output: 200, cacheRead: true, cacheCreate: 500 }),
    ]);
    assert.deepEqual(s.totals.usage, { input: 1000, output: 200, cacheRead: 10_000, cacheCreate: 500 });
    close(s.totals.cost!.total, 0.018125);
    assert.ok(Number.isFinite(s.totals.cost!.total) && !Number.isNaN(s.totals.cost!.total));
    assert.equal(s.totals.eventCount, 2);
  });

  it("skips token events with missing/empty data or no model", () => {
    const e1 = { type: "tokens", ts: "2026-06-16T10:00:00.000Z" } as CodumentEvent;
    const e2 = tok({});
    const e3 = tok({ input: 1000, output: 100, cacheRead: 5000, cacheCreate: 200 });
    const e4 = tok({ model: "opus-4.8", input: 1000, output: 100, cacheRead: 5000, cacheCreate: 200 });
    const s = summarizeTokens([e1, e2, e3, e4]);
    assert.equal(s.totals.eventCount, 1);
    assert.deepEqual(s.totals.usage, { input: 1000, output: 100, cacheRead: 5000, cacheCreate: 200 });
    assert.deepEqual(
      [e1, e2, e3, e4].map(isTokenEvent),
      [false, false, false, true],
    );
  });

  it("counts unknown-model tokens but leaves their cost null and lists them unpriced", () => {
    const s = summarizeTokens([
      tok({ model: "opus-5.0-preview", input: 1000, output: 200, cacheRead: 50_000, cacheCreate: 3000, feature: "auth" }),
    ]);
    assert.deepEqual(s.totals.usage, { input: 1000, output: 200, cacheRead: 50_000, cacheCreate: 3000 });
    assert.equal(s.byModel["opus-5.0-preview"].cost, null);
    assert.deepEqual(s.unpriced, ["opus-5.0-preview"]);
    assert.deepEqual(s.byFeature["auth"].usage, { input: 1000, output: 200, cacheRead: 50_000, cacheCreate: 3000 });
    assert.equal(s.byFeature["auth"].cost, null);
    assert.equal(s.totals.cost, null);
  });

  it("prices only the priced portion of a mixed priced+unpriced feature", () => {
    const s = summarizeTokens([
      tok({ model: "opus-4.8", input: 1000, output: 200, cacheRead: 50_000, cacheCreate: 3000, feature: "auth" }),
      tok({ model: "mystery-model", input: 999_999, output: 999_999, cacheRead: 999_999, cacheCreate: 999_999, feature: "auth" }),
    ]);
    assert.deepEqual(s.byFeature["auth"].usage, {
      input: 1_000_999,
      output: 1_000_199,
      cacheRead: 1_049_999,
      cacheCreate: 1_002_999,
    });
    assert.notEqual(s.byFeature["auth"].cost, null);
    close(s.byFeature["auth"].cost!.total, 0.05375);
    assert.deepEqual(s.unpriced, ["mystery-model"]);
    close(s.totals.cost!.total, 0.05375);
  });

  it("dedupes and sorts the unpriced model list with no known models leaking in", () => {
    const min = { input: 1, output: 1, cacheRead: 1, cacheCreate: 1 };
    const s = summarizeTokens(
      ["zeta-9", "opus-4.8", "alpha-2", "zeta-9", "sonnet-4.6", "alpha-2"].map((model) =>
        tok({ model, ...min }),
      ),
    );
    assert.deepEqual(s.unpriced, ["alpha-2", "zeta-9"]);
    assert.deepEqual(Object.keys(s.byModel).sort(), ["alpha-2", "opus-4.8", "sonnet-4.6", "zeta-9"]);
  });

  it("is order-independent", () => {
    const a = tok({ model: "opus-4.8", input: 1000, output: 200, cacheRead: 50_000, cacheCreate: 3000 }, "2026-06-16T10:05:00.000Z");
    const b = tok({ model: "opus-4.8", input: 500, output: 100, cacheRead: 20_000, cacheCreate: 1000 }, "2026-06-16T10:01:00.000Z");
    const forward = summarizeTokens([a, b]);
    const backward = summarizeTokens([b, a]);
    assert.deepEqual(forward.totals.usage, backward.totals.usage);
    assert.deepEqual(forward.totals.usage, { input: 1500, output: 300, cacheRead: 70_000, cacheCreate: 4000 });
    close(forward.totals.cost!.total, 0.075);
    close(backward.totals.cost!.total, 0.075);
  });

  it("is deterministic and associative across partitions", () => {
    const A = tok({ model: "opus-4.8", input: 1000, output: 200, cacheRead: 50_000, cacheCreate: 3000 });
    const B = tok({ model: "opus-4.8", input: 500, output: 100, cacheRead: 20_000, cacheCreate: 1000 });
    const C = tok({ model: "sonnet-4.6", input: 800, output: 150, cacheRead: 30_000, cacheCreate: 2000 });
    const whole = summarizeTokens([A, B, C]);
    assert.deepEqual(summarizeTokens([A, B, C]).totals.usage, whole.totals.usage);
    const left = summarizeTokens([A, B]).totals.usage;
    const right = summarizeTokens([C]).totals.usage;
    assert.deepEqual(
      {
        input: left.input + right.input,
        output: left.output + right.output,
        cacheRead: left.cacheRead + right.cacheRead,
        cacheCreate: left.cacheCreate + right.cacheCreate,
      },
      whole.totals.usage,
    );
    close(
      summarizeTokens([A, B]).totals.cost!.total + summarizeTokens([C]).totals.cost!.total,
      whole.totals.cost!.total,
    );
  });

  it("does not mutate its input", () => {
    const events = [
      tok({ model: "opus-4.8", input: 1000, output: 200, cacheRead: 50_000, cacheCreate: 3000, feature: "auth" }),
      ev("review", "x"),
    ];
    const snapshot = structuredClone(events);
    summarizeTokens(events);
    assert.deepEqual(events, snapshot);
  });

  it("keeps large token counts exact integers", () => {
    const big = { model: "opus-4.8", input: 9_000_001, output: 1_500_003, cacheRead: 88_000_007, cacheCreate: 4_000_009 };
    const s = summarizeTokens([tok({ ...big }), tok({ ...big }), tok({ ...big })]);
    assert.deepEqual(s.totals.usage, {
      input: 27_000_003,
      output: 4_500_009,
      cacheRead: 264_000_021,
      cacheCreate: 12_000_027,
    });
    assert.ok(Number.isInteger(s.totals.usage.input));
    assert.ok(Number.isInteger(s.totals.usage.cacheRead));
    assert.equal(s.totals.eventCount, 3);
  });
});

describe("isTokenEvent", () => {
  it("accepts a well-formed token event with and without attribution", () => {
    assert.equal(
      isTokenEvent(tok({ model: "opus-4.8", input: 1, output: 1, cacheRead: 1, cacheCreate: 1 })),
      true,
    );
    assert.equal(
      isTokenEvent(tok({ model: "opus-4.8", input: 1, output: 1, cacheRead: 1, cacheCreate: 1, feature: "f", step: "s" })),
      true,
    );
  });

  it("rejects non-token types even with token-shaped data", () => {
    assert.equal(
      isTokenEvent({
        type: "review",
        ts: "2026-06-16T10:00:00.000Z",
        data: { model: "opus-4.8", input: 1, output: 1, cacheRead: 1, cacheCreate: 1 },
      }),
      false,
    );
  });

  it("rejects token events with missing/non-finite buckets or bad model", () => {
    const bad: Record<string, unknown>[] = [
      { model: "opus-4.8", output: 1, cacheRead: 1, cacheCreate: 1 }, // missing input
      { model: "opus-4.8", input: "1", output: 1, cacheRead: 1, cacheCreate: 1 }, // string bucket
      { model: "opus-4.8", input: 1, output: null, cacheRead: 1, cacheCreate: 1 },
      { model: "opus-4.8", input: 1, output: 1, cacheRead: NaN, cacheCreate: 1 },
      { model: "opus-4.8", input: 1, output: 1, cacheRead: 1, cacheCreate: Infinity },
      { model: "opus-4.8", input: 1, output: 1, cache_read: 1, cacheCreate: 1 }, // wrong key
      { input: 1, output: 1, cacheRead: 1, cacheCreate: 1 }, // no model
      { model: 123, input: 1, output: 1, cacheRead: 1, cacheCreate: 1 }, // non-string model
      { model: "", input: 1, output: 1, cacheRead: 1, cacheCreate: 1 }, // empty model
    ];
    for (const data of bad) {
      assert.equal(isTokenEvent(tok(data)), false, JSON.stringify(data));
    }
    assert.equal(isTokenEvent({ type: "tokens", ts: "2026-06-16T10:00:00.000Z" } as CodumentEvent), false);
  });
});
