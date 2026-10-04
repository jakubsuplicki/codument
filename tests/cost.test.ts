import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeTokens } from "../src/lib/token-report.js";
import { cost, renderCost, renderWorkflowTiming, sharePercents, summarizeWorkflowTiming } from "../src/commands/cost.js";
import type { CodumentEvent, EventLogRead } from "../src/lib/events.js";

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

function timing(data: Record<string, unknown> = {}): CodumentEvent {
  return {
    type: "workflow-command",
    ts: "2026-10-04T00:00:00.000Z",
    data: { version: 1, command: "context", durationMs: 125, exitCode: 0, ...data },
  };
}

function ledger(events: CodumentEvent[], state: EventLogRead["state"] = "available", skipped = 0): EventLogRead {
  return { events, state, skipped };
}

describe("workflow timing evidence", () => {
  it("groups only valid observed actions with sorted commands and actual outcomes", () => {
    const summary = summarizeWorkflowTiming(ledger([
      timing({ command: "verify", durationMs: 250 }),
      timing(),
      timing({ durationMs: 0, exitCode: 1 }),
      tok("opus-4.8", { input: 1_000_000 }),
    ]));
    assert.equal(summary.state, "available");
    assert.equal(summary.observedCount, 3);
    assert.equal(summary.totalDurationMs, 375);
    assert.deepEqual(summary.byCommand, [
      { command: "context", count: 2, durationMs: 125, succeeded: 1, failed: 1 },
      { command: "verify", count: 1, durationMs: 250, succeeded: 1, failed: 0 },
    ]);
    assert.equal(summary.implementationDurationMs, null);
    assert.equal(summary.invalidTimingEvents, 0);
  });

  it("names invalid timing facts without dropping valid evidence", () => {
    const invalid = [
      timing({ version: 2 }), timing({ version: "1" }),
      timing({ durationMs: -1 }), timing({ durationMs: NaN }),
      timing({ durationMs: Infinity }), timing({ durationMs: "125" }),
      timing({ command: "unknown" }), timing({ command: "context --paths private.ts" }),
      timing({ exitCode: -1 }), timing({ exitCode: 0.5 }),
      timing({ exitCode: "0" }), timing({ path: "private.ts" }),
      { type: "workflow-command", ts: "now", data: null } as unknown as CodumentEvent,
    ];
    const summary = summarizeWorkflowTiming(ledger([timing(), ...invalid]));
    assert.equal(summary.state, "partial");
    assert.equal(summary.invalidTimingEvents, invalid.length);
    assert.equal(summary.observedCount, 1);
    assert.equal(summary.totalDurationMs, 125);
    assert.deepEqual(summary.ledger, { state: "available", skipped: 0 });
  });

  it("excludes overflowing aggregates, retains other facts and reports the loss", () => {
    const summary = summarizeWorkflowTiming(ledger([
      timing({ durationMs: Number.MAX_VALUE }),
      timing({ durationMs: Number.MAX_VALUE }),
      timing({ command: "verify", durationMs: 0 }),
    ]));
    assert.equal(summary.state, "partial");
    assert.equal(summary.observedCount, 2);
    assert.equal(summary.overflowTimingEvents, 1);
    assert.equal(summary.totalDurationMs, Number.MAX_VALUE);
    assert.equal(JSON.parse(JSON.stringify(summary)).totalDurationMs, Number.MAX_VALUE);
    assert.equal(summary.byCommand[1].count, 1, "later usable evidence survives overflow");
  });

  it("distinguishes missing observations from partial or unavailable ledger evidence", () => {
    const empty = summarizeWorkflowTiming(ledger([], "empty"));
    assert.equal(empty.state, "empty");
    assert.equal(empty.implementationDurationMs, null);
    assert.equal(summarizeWorkflowTiming(ledger([tok("opus-4.8", {})])).state, "empty");

    const partial = summarizeWorkflowTiming(ledger([timing()], "partial", 2));
    assert.equal(partial.state, "partial");
    assert.equal(partial.observedCount, 1);
    assert.deepEqual(partial.ledger, { state: "partial", skipped: 2 });

    const unavailable = summarizeWorkflowTiming(ledger([], "unavailable"));
    assert.equal(unavailable.state, "unavailable");
    assert.equal(unavailable.observedCount, 0);
    assert.equal(unavailable.implementationDurationMs, null);
  });

  it("renders the action boundary and uncertainty without a session-time estimate", () => {
    const out = renderWorkflowTiming(summarizeWorkflowTiming(ledger([timing()], "partial", 1)), "proj");
    assert.match(out, /codument cost --timing.*proj/s);
    assert.match(out, /1 observed command action.*125\.00 ms summed/);
    assert.match(out, /Timing evidence: partial; ledger: partial/);
    assert.match(out, /1 malformed ledger/);
    assert.match(out, /Implementation duration: unknown/);
    assert.match(out, /opt-in and incomplete/);
    assert.match(out, /exclude process startup, host thinking, unobserved implementation and user waits/);
    assert.match(out, /may overlap and are not session wall time/);
  });
});

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
  it("reports observed command actions separately from unknown implementation time", () => {
    const dir = mkdtempSync(join(tmpdir(), "codument-timing-"));
    mkdirSync(join(dir, ".codument"));
    writeFileSync(join(dir, ".codument", "events.jsonl"), JSON.stringify({
      type: "workflow-command", ts: "2026-10-04T00:00:00.000Z",
      data: { version: 1, command: "context", durationMs: 125, exitCode: 0 },
    }) + "\n");

    const parsed = JSON.parse(capture(() => cost({ root: dir, json: true, timing: true })));
    assert.equal(parsed.observedCount, 1);
    assert.equal(parsed.totalDurationMs, 125);
    assert.equal(parsed.implementationDurationMs, null);
    assert.equal(parsed.observation, "opt-in");
    assert.equal(parsed.boundary, "command-action");
    assert.equal(parsed.totals, undefined, "timing is an explicit separate view");
  });

  it("reads timing evidence without modifying an existing log or creating an empty ledger", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "codument-timing-empty-"));
    const empty = JSON.parse(capture(() => cost({ root: emptyDir, json: true, timing: true })));
    assert.equal(empty.state, "empty");
    assert.deepEqual(readdirSync(emptyDir), []);

    const dir = mkdtempSync(join(tmpdir(), "codument-timing-read-"));
    mkdirSync(join(dir, ".codument"));
    const path = join(dir, ".codument", "events.jsonl");
    const contents = JSON.stringify(timing()) + "\nmalformed\n";
    writeFileSync(path, contents);
    const before = statSync(path).mtimeMs;
    const parsed = JSON.parse(capture(() => cost({ root: dir, json: true, timing: true })));
    assert.equal(parsed.state, "partial");
    assert.equal(parsed.observedCount, 1);
    assert.equal(parsed.ledger.skipped, 1);
    assert.equal(readFileSync(path, "utf8"), contents);
    assert.equal(statSync(path).mtimeMs, before);
    assert.deepEqual(readdirSync(join(dir, ".codument")), ["events.jsonl"]);
  });

  it("keeps unavailable timing evidence explicit", () => {
    const dir = mkdtempSync(join(tmpdir(), "codument-timing-unavailable-"));
    mkdirSync(join(dir, ".codument", "events.jsonl"), { recursive: true });
    const parsed = JSON.parse(capture(() => cost({ root: dir, json: true, timing: true })));
    assert.equal(parsed.state, "unavailable");
    assert.equal(parsed.ledger.state, "unavailable");
    assert.equal(parsed.implementationDurationMs, null);
  });

  it("leaves ordinary token JSON and usage exports unchanged when timing events are present", () => {
    const dir = mkdtempSync(join(tmpdir(), "codument-cost-timing-compat-"));
    mkdirSync(join(dir, ".codument"));
    const path = join(dir, ".codument", "events.jsonl");
    const tokens = tok("opus-4.8", { input: 1_000_000 }, { feature: "alpha" });
    writeFileSync(path, JSON.stringify(tokens) + "\n");
    const original = JSON.parse(capture(() => cost({ root: dir, json: true })));
    const firstExport = join(dir, "first.json");
    capture(() => cost({ root: dir, json: true, export: firstExport }));

    appendFileSync(path, JSON.stringify(timing()) + "\n");
    const withTiming = JSON.parse(capture(() => cost({ root: dir, json: true })));
    const secondExport = join(dir, "second.json");
    capture(() => cost({ root: dir, json: true, export: secondExport }));
    assert.deepEqual(withTiming, original);
    assert.deepEqual(JSON.parse(readFileSync(secondExport, "utf8")), JSON.parse(readFileSync(firstExport, "utf8")));
    assert.equal(withTiming.totalDurationMs, undefined);
    assert.deepEqual(summarizeTokens([tokens, timing()]), summarizeTokens([tokens]));
  });

  it("refuses timing plus usage export without writing an output file", () => {
    const dir = mkdtempSync(join(tmpdir(), "codument-timing-export-"));
    const target = join(dir, "usage.json");
    const priorExit = process.exitCode;
    try {
      const parsed = JSON.parse(capture(() => cost({ root: dir, timing: true, json: true, export: target })));
      assert.match(parsed.error, /Timing inspection cannot be combined with a usage export/);
      assert.equal(process.exitCode, 1);
      assert.equal(existsSync(target), false);
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      process.exitCode = priorExit;
    }
  });

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
