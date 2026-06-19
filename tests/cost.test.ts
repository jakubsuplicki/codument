import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeTokens } from "../src/lib/token-report.js";
import { cost, renderCost, sharePercents } from "../src/commands/cost.js";
import type { CodumentEvent } from "../src/lib/events.js";

function tok(
  model: string,
  usage: { input?: number; output?: number; cacheRead?: number; cacheCreate?: number },
  attr: { feature?: string; step?: string } = {},
): CodumentEvent {
  return {
    type: "tokens",
    ts: "2026-06-18T00:00:00.000Z",
    data: {
      source: "feed",
      model,
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheCreate: usage.cacheCreate ?? 0,
      ...attr,
    },
  } as unknown as CodumentEvent;
}

/** Run a thunk with console.log captured. */
function capture(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

describe("renderCost — the full ledger", () => {
  it("lists every feature sorted by cost, with a model breakdown", () => {
    const events = [
      tok("opus-4.8", { input: 2_000_000, output: 400_000 }, { feature: "alpha" }),
      tok("opus-4.8", { input: 100_000, output: 20_000 }, { feature: "beta" }),
      tok("haiku-4.5", { input: 50_000 }, { feature: "beta" }),
    ];
    const out = renderCost(summarizeTokens(events), "proj");

    assert.match(out, /codument cost.*proj/s);
    assert.match(out, /estimated/);
    assert.match(out, /by feature/);
    assert.match(out, /by model/);
    // alpha spent far more than beta → it sorts first.
    assert.ok(out.indexOf("alpha") < out.indexOf("beta"), "alpha should rank above beta");
    assert.match(out, /opus-4\.8/);
    assert.match(out, /\$[\d,]+\.\d{2}/); // a formatted dollar figure appears
  });

  it("shows a step breakdown only when a real step was attributed", () => {
    const noStep = renderCost(
      summarizeTokens([tok("opus-4.8", { input: 1000 }, { feature: "a" })]),
      "proj",
    );
    assert.doesNotMatch(noStep, /by step/);

    const withStep = renderCost(
      summarizeTokens([tok("opus-4.8", { input: 1000 }, { feature: "a", step: "step-1" })]),
      "proj",
    );
    assert.match(withStep, /by step/);
    assert.match(withStep, /step-1/);
  });

  it("flags unknown models as unpriced rather than inventing a cost", () => {
    const out = renderCost(summarizeTokens([tok("ghost-model", { input: 9_999_999 })]), "proj");
    assert.match(out, /unpriced models: ghost-model/);
  });

  it("shows <1% for a real-but-tiny feature, never a false 0%", () => {
    const out = renderCost(
      summarizeTokens([
        tok("opus-4.8", { input: 10_000_000 }, { feature: "big" }),
        tok("opus-4.8", { input: 10_000 }, { feature: "tiny" }), // ~0.1% of spend
      ]),
      "proj",
    );
    assert.match(out, /<1%/, "the tiny feature renders as <1%");
    assert.doesNotMatch(out, /[^0-9]0%/, "no standalone 0% for a feature with real spend");
  });
});

describe("sharePercents — largest-remainder rounding", () => {
  it("rounds to whole percents that sum to exactly 100", () => {
    for (const vs of [
      [1, 1, 1],
      [2, 1, 1],
      [0.4, 0.3, 0.3],
      [100, 50, 25, 12, 6, 3, 1],
    ]) {
      assert.equal(
        sharePercents(vs).reduce((a, b) => a + b, 0),
        100,
        `should sum to 100 for ${JSON.stringify(vs)}`,
      );
    }
  });

  it("hands the leftover point to the largest remainder", () => {
    // 33.33 each → floors 33,33,33 (sum 99); the +1 goes to the first.
    assert.deepEqual(sharePercents([1, 1, 1]), [34, 33, 33]);
  });

  it("returns all-zero for an empty, zero-total, or negative input (no corruption)", () => {
    assert.deepEqual(sharePercents([]), []);
    assert.deepEqual(sharePercents([0, 0]), [0, 0]);
    assert.deepEqual(sharePercents([5, -2, 1]), [0, 0, 0]);
  });

  it("never lets the column exceed 100 across many tiny shares", () => {
    const many = Array.from({ length: 97 }, (_, i) => i + 1); // 97 unequal values
    assert.equal(
      sharePercents(many).reduce((a, b) => a + b, 0),
      100,
      "97-way split still sums to exactly 100",
    );
  });
});

describe("cost command", () => {
  it("reports nothing-captured for an empty project", () => {
    const dir = mkdtempSync(join(tmpdir(), "codument-cost-"));
    const out = capture(() => cost({ root: dir }));
    assert.match(out, /no token usage captured/);
  });

  it("emits the machine-readable summary with --json", () => {
    const dir = mkdtempSync(join(tmpdir(), "codument-cost-"));
    mkdirSync(join(dir, ".codument"));
    writeFileSync(
      join(dir, ".codument", "events.jsonl"),
      JSON.stringify(tok("opus-4.8", { input: 1_000_000 }, { feature: "alpha" })) + "\n",
    );

    const out = capture(() => cost({ root: dir, json: true }));
    const parsed = JSON.parse(out);
    assert.ok(parsed.byFeature.alpha, "byFeature.alpha present in JSON");
    assert.ok(parsed.totals.usage.input === 1_000_000);
  });
});
