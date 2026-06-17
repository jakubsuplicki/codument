import { appendEvent } from "./events.js";
import type { TokenUsage } from "./token-cost.js";

// Producer side of the vendor-neutral token protocol: append one type:"tokens"
// event to .codument/events.jsonl. An agent (or a thin agent-specific hook that
// reads its session transcript) calls this; codument never computes cost here —
// only raw counts are stored, so the log can't carry a stale dollar figure when
// rates change. isTokenEvent is re-exported from its canonical home so the guard
// can never drift between producer and reducer.
export { isTokenEvent } from "./token-report.js";

export interface EmitTokensMeta {
  model: string;
  feature?: string;
  step?: string;
  /** Override the wall-clock timestamp (tests/replay); defaults to now. */
  ts?: string;
}

/** Normalize an untrusted count: only a finite positive number survives, else 0. */
function clamp(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function emitTokens(
  root: string,
  usage: TokenUsage,
  meta: EmitTokensMeta,
): void {
  // All four buckets are written unconditionally — including 0 — and clamped to
  // a finite, non-negative number, so the strict guard (which requires four
  // finite numbers) always accepts what we emit, even if a caller passes
  // NaN/Infinity/negative. (The CLI clamps too; this guards programmatic callers.)
  const data: Record<string, unknown> = {
    model: meta.model,
    input: clamp(usage.input),
    output: clamp(usage.output),
    cacheRead: clamp(usage.cacheRead),
    cacheCreate: clamp(usage.cacheCreate),
  };
  // Attribution keys are omitted entirely when absent, so the reducer doesn't
  // grow a spurious "undefined" bucket.
  if (meta.feature !== undefined) data.feature = meta.feature;
  if (meta.step !== undefined) data.step = meta.step;

  appendEvent(root, {
    type: "tokens",
    data,
    ...(meta.ts !== undefined ? { ts: meta.ts } : {}),
  });
}
