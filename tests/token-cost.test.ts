import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODEL_RATES,
  costOf,
  mergeRates,
  loadRates,
  type TokenUsage,
} from "../src/lib/token-cost.js";

function close(actual: number, expected: number, eps = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} to be within ${eps} of ${expected}`,
  );
}

const u = (
  input: number,
  output: number,
  cacheRead: number,
  cacheCreate: number,
): TokenUsage => ({ input, output, cacheRead, cacheCreate });

describe("MODEL_RATES", () => {
  it("has the known models with the documented per-bucket rates", () => {
    assert.deepEqual(Object.keys(MODEL_RATES).sort(), [
      "fable-5",
      "haiku-4.5",
      "mythos-5",
      "opus-4.7",
      "opus-4.8",
      "sonnet-4.6",
    ]);
    assert.deepEqual(MODEL_RATES["opus-4.8"], {
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheCreate: 6.25,
    });
    assert.deepEqual(MODEL_RATES["fable-5"], {
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheCreate: 12.5,
    });
    assert.deepEqual(MODEL_RATES["mythos-5"], MODEL_RATES["fable-5"]);
    assert.deepEqual(MODEL_RATES["opus-4.7"], {
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheCreate: 6.25,
    });
    assert.deepEqual(MODEL_RATES["sonnet-4.6"], {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheCreate: 3.75,
    });
    assert.deepEqual(MODEL_RATES["haiku-4.5"], {
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheCreate: 1.25,
    });
  });

  it("keeps the derived-rate invariants on every row", () => {
    for (const rate of Object.values(MODEL_RATES)) {
      assert.equal(rate.cacheRead, rate.input / 10);
      assert.equal(rate.cacheCreate, rate.input * 1.25);
      assert.equal(rate.output, rate.input * 5);
    }
  });
});

describe("costOf", () => {
  it("prices zero usage on a known model as all-zero, priced (not unpriced)", () => {
    assert.deepEqual(costOf(u(0, 0, 0, 0), "opus-4.8"), {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
      total: 0,
      unpriced: false,
    });
  });

  it("prices each bucket at its own rate (1M of each, opus-4.8)", () => {
    const c = costOf(u(1_000_000, 1_000_000, 1_000_000, 1_000_000), "opus-4.8");
    close(c.input, 5);
    close(c.output, 25);
    close(c.cacheRead, 0.5);
    close(c.cacheCreate, 6.25);
    close(c.total, 36.75);
    assert.equal(c.unpriced, false);
  });

  it("makes cacheRead 10x cheaper than input (the naive-sum over-bill trap)", () => {
    const cacheReadOnly = costOf(u(0, 0, 1_000_000, 0), "opus-4.8");
    const inputOnly = costOf(u(1_000_000, 0, 0, 0), "opus-4.8");
    close(cacheReadOnly.total, 0.5);
    assert.equal(cacheReadOnly.input, 0);
    close(inputOnly.total, 5);
    close(inputOnly.total / cacheReadOnly.total, 10);
  });

  it("prices a realistic cache-heavy mix where cacheRead dominates the bill", () => {
    const c = costOf(u(30_000, 4_000, 2_000_000, 150_000), "opus-4.8");
    close(c.input, 0.15);
    close(c.output, 0.1);
    close(c.cacheRead, 1.0);
    close(c.cacheCreate, 0.9375);
    close(c.total, 2.1875);
  });

  it("selects the sonnet-4.6 rate row", () => {
    const c = costOf(u(100_000, 20_000, 500_000, 40_000), "sonnet-4.6");
    close(c.input, 0.3);
    close(c.output, 0.3);
    close(c.cacheRead, 0.15);
    close(c.cacheCreate, 0.15);
    close(c.total, 0.9);
  });

  it("prices the cheapest model (haiku-4.5) without aliasing", () => {
    const c = costOf(u(1_000_000, 1_000_000, 1_000_000, 1_000_000), "haiku-4.5");
    close(c.total, 7.35);
  });

  it("treats opus-4.7 as its own row with opus-4.8 rates", () => {
    const usage = u(200_000, 10_000, 1_000_000, 80_000);
    const a = costOf(usage, "opus-4.7");
    const b = costOf(usage, "opus-4.8");
    assert.deepEqual(a, b);
    close(a.input, 1.0);
    close(a.output, 0.25);
    close(a.cacheRead, 0.5);
    close(a.cacheCreate, 0.5);
    close(a.total, 2.25);
    assert.equal(a.unpriced, false);
  });

  it("marks an unknown model unpriced with all-zero cost and never throws", () => {
    let c!: ReturnType<typeof costOf>;
    assert.doesNotThrow(() => {
      c = costOf(u(1_000_000, 1_000_000, 1_000_000, 1_000_000), "gpt-4o");
    });
    assert.deepEqual(c, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
      total: 0,
      unpriced: true,
    });
  });

  it("requires an exact key — no case-fold, no trim, no fuzzy match", () => {
    for (const model of ["Opus-4.8", "opus4.8", "opus-4.8 "]) {
      const c = costOf(u(1_000_000, 0, 0, 0), model);
      assert.equal(c.unpriced, true);
      assert.equal(c.total, 0);
    }
  });

  it("treats an empty-string model as unpriced", () => {
    let c!: ReturnType<typeof costOf>;
    assert.doesNotThrow(() => {
      c = costOf(u(1_000_000, 0, 0, 0), "");
    });
    assert.equal(c.unpriced, true);
    assert.equal(c.total, 0);
  });

  it("does not lookup inherited Object prototype keys", () => {
    const c = costOf(u(1_000_000, 0, 0, 0), "constructor");
    assert.equal(c.unpriced, true);
    assert.equal(c.total, 0);
  });

  it("keeps sub-cent precision", () => {
    const c = costOf(u(1234, 0, 0, 0), "opus-4.8");
    close(c.input, 0.00617);
    close(c.total, 0.00617);
    assert.notEqual(c.total, 0);
  });

  it("keeps total === sum of buckets for an asymmetric mix", () => {
    const c = costOf(u(12_345, 6_789, 987_654, 54_321), "sonnet-4.6");
    close(c.total, c.input + c.output + c.cacheRead + c.cacheCreate);
    assert.ok(c.input > 0 && c.output > 0 && c.cacheRead > 0 && c.cacheCreate > 0);
  });

  it("stays finite at large scale", () => {
    const c = costOf(u(0, 1e9, 5e9, 0), "opus-4.8");
    close(c.cacheRead, 2500);
    close(c.output, 25000);
    close(c.total, 27500);
    assert.ok(Number.isFinite(c.total));
  });

  it("clamps a negative bucket to 0", () => {
    const c = costOf(u(-1_000_000, 1_000_000, 0, 0), "opus-4.8");
    assert.equal(c.input, 0);
    close(c.output, 25);
    close(c.total, 25);
    assert.ok(c.total >= 0);
  });

  it("clamps a NaN bucket to 0", () => {
    const c = costOf(u(NaN, 400_000, 0, 0), "opus-4.8");
    assert.equal(c.input, 0);
    close(c.output, 10);
    close(c.total, 10);
    assert.ok(!Number.isNaN(c.total));
  });

  it("clamps an Infinity bucket to 0", () => {
    const c = costOf(u(Infinity, 0, 200_000, 0), "opus-4.8");
    assert.equal(c.input, 0);
    close(c.cacheRead, 0.1);
    close(c.total, 0.1);
    assert.ok(Number.isFinite(c.total));
  });

  it("does not mutate the input usage", () => {
    const usage = u(12_345, 6_789, 987_654, 54_321);
    const snapshot = { ...usage };
    costOf(usage, "opus-4.8");
    assert.deepEqual(usage, snapshot);
  });

  it("isolates each bucket's rate (catches cross-wired rates)", () => {
    close(costOf(u(1_000_000, 0, 0, 0), "opus-4.8").input, 5);
    close(costOf(u(0, 1_000_000, 0, 0), "opus-4.8").output, 25);
    close(costOf(u(0, 0, 1_000_000, 0), "opus-4.8").cacheRead, 0.5);
    const cc = costOf(u(0, 0, 0, 1_000_000), "opus-4.8");
    close(cc.cacheCreate, 6.25);
    assert.equal(cc.output, 0);
  });

  it("prices with a supplied rate table when one is given", () => {
    const rates = { "codex-1": { input: 2, output: 8, cacheRead: 0, cacheCreate: 0 } };
    const c = costOf(u(1_000_000, 1_000_000, 1_000_000, 1_000_000), "codex-1", rates);
    close(c.input, 2);
    close(c.output, 8);
    close(c.cacheRead, 0);
    close(c.cacheCreate, 0);
    close(c.total, 10);
    assert.equal(c.unpriced, false);
  });

  it("prices strictly from the supplied table (a model absent from it is unpriced)", () => {
    const rates = { "codex-1": { input: 2, output: 8, cacheRead: 0, cacheCreate: 0 } };
    assert.equal(costOf(u(1_000_000, 0, 0, 0), "opus-4.8", rates).unpriced, true);
  });
});

describe("mergeRates", () => {
  it("returns the defaults unchanged for empty overrides", () => {
    const merged = mergeRates(MODEL_RATES, {});
    assert.deepEqual(merged["opus-4.8"], MODEL_RATES["opus-4.8"]);
    assert.deepEqual(Object.keys(merged).sort(), Object.keys(MODEL_RATES).sort());
  });

  it("adds a new model, defaulting absent buckets to 0", () => {
    const merged = mergeRates(MODEL_RATES, { "codex-1": { input: 1.5, output: 6 } });
    assert.deepEqual(merged["codex-1"], {
      input: 1.5,
      output: 6,
      cacheRead: 0,
      cacheCreate: 0,
    });
  });

  it("overrides a single bucket of an existing model, keeping the rest", () => {
    const merged = mergeRates(MODEL_RATES, { "opus-4.8": { output: 30 } });
    assert.deepEqual(merged["opus-4.8"], {
      input: 5,
      output: 30,
      cacheRead: 0.5,
      cacheCreate: 6.25,
    });
  });

  it("accepts an explicit 0 bucket (free), but rejects negatives and non-numbers", () => {
    const merged = mergeRates(MODEL_RATES, {
      "free-cache": { input: 2, cacheRead: 0 },
      "bad-row": 5, // not an object -> ignored entirely
      "all-bad": { input: "x", output: -1, cacheRead: NaN }, // no valid bucket -> not added (stays unpriced)
      "opus-4.8": { input: "nope" }, // bad override -> keep default
    });
    assert.deepEqual(merged["free-cache"], { input: 2, output: 0, cacheRead: 0, cacheCreate: 0 });
    assert.equal(merged["bad-row"], undefined);
    assert.equal(merged["all-bad"], undefined);
    assert.equal(merged["opus-4.8"].input, 5);
  });

  it("ignores prototype-polluting keys", () => {
    const merged = mergeRates(MODEL_RATES, {
      __proto__: { input: 999 },
      constructor: { input: 999 },
    } as Record<string, unknown>);
    assert.equal(merged["opus-4.8"].input, 5);
    assert.equal(({} as Record<string, unknown>).input, undefined); // global proto intact
  });

  it("does not mutate the base table", () => {
    const snapshot = structuredClone(MODEL_RATES);
    mergeRates(MODEL_RATES, { "opus-4.8": { output: 99 }, "new-model": { input: 1 } });
    assert.deepEqual(MODEL_RATES, snapshot);
  });
});

describe("loadRates", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "codument-rates-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the built-in defaults when no rates file exists", () => {
    assert.deepEqual(loadRates(tmp)["opus-4.8"], MODEL_RATES["opus-4.8"]);
  });

  it("merges a user .codument/rates.json over the defaults", () => {
    mkdirSync(join(tmp, ".codument"), { recursive: true });
    writeFileSync(
      join(tmp, ".codument", "rates.json"),
      JSON.stringify({ "codex-1": { input: 1.5, output: 6 }, "opus-4.8": { output: 30 } }),
    );
    const rates = loadRates(tmp);
    assert.deepEqual(rates["codex-1"], { input: 1.5, output: 6, cacheRead: 0, cacheCreate: 0 });
    assert.equal(rates["opus-4.8"].output, 30);
    assert.equal(rates["opus-4.8"].input, 5);
    close(costOf(u(0, 1_000_000, 0, 0), "codex-1", rates).output, 6);
  });

  it("falls back to defaults on invalid JSON without throwing", () => {
    mkdirSync(join(tmp, ".codument"), { recursive: true });
    writeFileSync(join(tmp, ".codument", "rates.json"), "{not valid json");
    let rates!: ReturnType<typeof loadRates>;
    assert.doesNotThrow(() => {
      rates = loadRates(tmp);
    });
    assert.deepEqual(rates["opus-4.8"], MODEL_RATES["opus-4.8"]);
  });
});
