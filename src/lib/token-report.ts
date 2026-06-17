import type { CodumentEvent } from "./events.js";
import {
  costOf,
  MODEL_RATES,
  type CostBreakdown,
  type RateTable,
  type TokenUsage,
} from "./token-cost.js";

// Pure reducer that folds a .codument/events.jsonl stream into token totals,
// attributed per feature / step / model, with an ESTIMATED dollar cost derived
// at read time. The log is untrusted (hand edits, other producers, partial
// writes), so every field is coerced defensively and nothing here throws.
//
// Two cost signals, deliberately distinct:
//   - cost === null      → the group has events but NONE were priced (unknown model).
//   - all-zero breakdown → no token events at all (the empty/idle case is $0, not unknown).
// Token COUNTS always include every attributable event; cost prices only the
// known-model portion.

export interface TokenEventData {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  feature?: string;
  step?: string;
}

export interface TokenRollup {
  usage: TokenUsage;
  cost: CostBreakdown | null;
  eventCount: number;
}

export interface TokenSummary {
  totals: TokenRollup;
  byFeature: Record<string, TokenRollup>;
  byStep: Record<string, TokenRollup>;
  byModel: Record<string, TokenRollup>;
  /** Distinct unknown model ids seen, sorted; never contains a known model. */
  unpriced: string[];
}

const BUCKETS = ["input", "output", "cacheRead", "cacheCreate"] as const;

/** Strict guard: a fully well-formed token event (used by producers and the live view). */
export function isTokenEvent(
  event: CodumentEvent,
): event is CodumentEvent & { type: "tokens"; data: TokenEventData } {
  if (event.type !== "tokens") return false;
  const data = event.data;
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (typeof d.model !== "string" || d.model.trim() === "") return false;
  return BUCKETS.every((b) => Number.isFinite(d[b]));
}

/** Coerce an untrusted count: only a finite positive number survives, else 0. */
function num(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;
}

function attribution(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value : "(none)";
}

interface TokenView {
  model: string;
  usage: TokenUsage;
  feature: string;
  step: string;
}

/** Loose read: anything tokens-typed with a usable model id, buckets coerced. */
function tokenView(event: CodumentEvent): TokenView | null {
  if (event.type !== "tokens") return null;
  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.model !== "string" || d.model.trim() === "") return null;
  return {
    model: d.model,
    usage: {
      input: num(d.input),
      output: num(d.output),
      cacheRead: num(d.cacheRead),
      cacheCreate: num(d.cacheCreate),
    },
    feature: attribution(d.feature),
    step: attribution(d.step),
  };
}

function rollup(views: TokenView[], rates: RateTable): TokenRollup {
  const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  const cost: CostBreakdown = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    total: 0,
    unpriced: false,
  };
  let priced = false;
  for (const v of views) {
    usage.input += v.usage.input;
    usage.output += v.usage.output;
    usage.cacheRead += v.usage.cacheRead;
    usage.cacheCreate += v.usage.cacheCreate;
    const c = costOf(v.usage, v.model, rates);
    if (!c.unpriced) {
      priced = true;
      cost.input += c.input;
      cost.output += c.output;
      cost.cacheRead += c.cacheRead;
      cost.cacheCreate += c.cacheCreate;
      cost.total += c.total;
    }
  }
  // No events at all → $0 (priced). Events but none priced → unknown (null).
  const finalCost = views.length === 0 ? cost : priced ? cost : null;
  return { usage, cost: finalCost, eventCount: views.length };
}

function groupBy(
  views: TokenView[],
  key: (v: TokenView) => string,
  rates: RateTable,
): Record<string, TokenRollup> {
  const groups = new Map<string, TokenView[]>();
  for (const v of views) {
    const k = key(v);
    const bucket = groups.get(k);
    if (bucket) bucket.push(v);
    else groups.set(k, [v]);
  }
  const out: Record<string, TokenRollup> = {};
  for (const [k, vs] of groups) out[k] = rollup(vs, rates);
  return out;
}

export function summarizeTokens(
  events: CodumentEvent[],
  rates: RateTable = MODEL_RATES,
): TokenSummary {
  const views: TokenView[] = [];
  for (const event of events) {
    const v = tokenView(event);
    if (v) views.push(v);
  }
  const unpriced = [
    ...new Set(views.filter((v) => costOf(v.usage, v.model, rates).unpriced).map((v) => v.model)),
  ].sort();
  return {
    totals: rollup(views, rates),
    byFeature: groupBy(views, (v) => v.feature, rates),
    byStep: groupBy(views, (v) => v.step, rates),
    byModel: groupBy(views, (v) => v.model, rates),
    unpriced,
  };
}
