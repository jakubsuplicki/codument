import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Cost math for agent token usage. codument never calls an LLM, so it can never
// meter tokens itself — it receives usage the agent reports and derives an
// ESTIMATED dollar cost from a rate table at render time. Token counts are the
// source of truth; cost is never persisted, so re-pricing when rates change is
// free and old logs can't carry a stale dollar figure.
//
// The built-in MODEL_RATES below cover Claude (codument's home turf, kept
// accurate). Any other model — Codex/GPT, Gemini, a fine-tune — is priced from a
// user-supplied .codument/rates.json merged over these defaults (loadRates), so
// codument stays agent-neutral without us tracking every vendor's prices. An
// unpriced model isn't an error: its tokens are counted and flagged, never
// silently mispriced.
//
// Anthropic usage splits into four buckets with very different prices. The trap
// to avoid: cache reads are ~10x cheaper than fresh input and dominate the token
// count in agentic coding — summing buckets at a single rate massively over-bills.
// Other providers map approximately (e.g. OpenAI has cached input but no separate
// cache-creation charge) — a bucket a provider doesn't have is simply priced 0.

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/** USD per million tokens, per bucket. */
export interface ModelRate {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/** A model-id → per-bucket-rate lookup. */
export type RateTable = Record<string, ModelRate>;

const BUCKETS = ["input", "output", "cacheRead", "cacheCreate"] as const;

// Keys that would corrupt a plain object's prototype if used as a model id.
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  total: number;
  /** True when the model id was not in MODEL_RATES — tokens counted, cost unknown. */
  unpriced: boolean;
}

// cacheRead = input * 0.1 (stored as the exact literal so it equals input/10),
// cacheCreate = input * 1.25, output = input * 5. Rates current as of 2026-06.
export const MODEL_RATES: Record<string, ModelRate> = {
  "fable-5": { input: 10, output: 50, cacheRead: 1, cacheCreate: 12.5 },
  "mythos-5": { input: 10, output: 50, cacheRead: 1, cacheCreate: 12.5 },
  "opus-4.8": { input: 5, output: 25, cacheRead: 0.5, cacheCreate: 6.25 },
  "opus-4.7": { input: 5, output: 25, cacheRead: 0.5, cacheCreate: 6.25 },
  "sonnet-4.6": { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
  "haiku-4.5": { input: 1, output: 5, cacheRead: 0.1, cacheCreate: 1.25 },
};

const ZERO: CostBreakdown = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  total: 0,
  unpriced: false,
};

/** Clamp untrusted counts: NaN/Infinity/negative all collapse to 0. */
function clamp(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Estimated USD cost of `usage` at `model`'s rates. An unknown model id (exact
 * match only — no case-fold, trim, or fuzzy lookup, so a typo surfaces as a
 * visible "unpriced" flag rather than a plausible-but-wrong bill) yields an
 * all-zero breakdown with `unpriced: true`. Never throws; never mutates `usage`.
 */
export function costOf(
  usage: TokenUsage,
  model: string,
  rates: RateTable = MODEL_RATES,
): CostBreakdown {
  if (!Object.prototype.hasOwnProperty.call(rates, model)) {
    return { ...ZERO, unpriced: true };
  }
  const rate = rates[model];
  const input = (clamp(usage.input) / 1_000_000) * rate.input;
  const output = (clamp(usage.output) / 1_000_000) * rate.output;
  const cacheRead = (clamp(usage.cacheRead) / 1_000_000) * rate.cacheRead;
  const cacheCreate = (clamp(usage.cacheCreate) / 1_000_000) * rate.cacheCreate;
  return {
    input,
    output,
    cacheRead,
    cacheCreate,
    total: input + output + cacheRead + cacheCreate,
    unpriced: false,
  };
}

function isValidRate(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/**
 * Merge user rate overrides onto a base table. Pure — never mutates `base`.
 * Per-bucket override: an existing model keeps its other buckets; a new model
 * defaults absent buckets to 0. Only finite, non-negative bucket values are
 * accepted (0 is allowed — a free bucket). A new model with no valid bucket is
 * skipped entirely (stays unpriced rather than becoming a misleading $0 row).
 * Prototype-polluting keys are ignored.
 */
export function mergeRates(base: RateTable, overrides: unknown): RateTable {
  const out: RateTable = {};
  for (const [model, rate] of Object.entries(base)) out[model] = { ...rate };

  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    return out;
  }
  for (const [model, raw] of Object.entries(overrides as Record<string, unknown>)) {
    if (UNSAFE_KEYS.has(model)) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const incoming = raw as Record<string, unknown>;
    const existing = out[model];
    const row: ModelRate = existing
      ? { ...existing }
      : { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    let applied = false;
    for (const bucket of BUCKETS) {
      const value = incoming[bucket];
      if (isValidRate(value)) {
        row[bucket] = value;
        applied = true;
      }
    }
    // Keep an existing model (override applied or not); add a new one only if it
    // contributed at least one valid bucket.
    if (existing || applied) out[model] = row;
  }
  return out;
}

/**
 * Resolve the effective rate table for a repo: built-in defaults overlaid with
 * `.codument/rates.json` if present. Tolerant by design — a missing,
 * unreadable, or malformed file falls back to the defaults without throwing, so
 * a bad rates file degrades to "Claude priced, everything else unpriced" rather
 * than breaking `watch`.
 */
export function loadRates(root: string): RateTable {
  const path = join(root, ".codument", "rates.json");
  if (!existsSync(path)) return mergeRates(MODEL_RATES, {});
  try {
    return mergeRates(MODEL_RATES, JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return mergeRates(MODEL_RATES, {});
  }
}
