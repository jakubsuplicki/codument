import { emitTokens } from "../lib/emit-producer.js";
import { emitReview, type ReviewTier, type ReviewResolution } from "../lib/review-events.js";

export interface EmitTokensCliOptions {
  model: string;
  input?: string;
  output?: string;
  cacheRead?: string;
  cacheCreate?: string;
  feature?: string;
  step?: string;
  root?: string;
}

/** Parse a CLI count: only a finite positive number survives, else 0. */
function count(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * `codument emit tokens` — record agent token usage into .codument/events.jsonl.
 * This is the producer seam: an agent (or a thin transcript-reading hook) reports
 * what it spent; codument prices and attributes it later. Counts only — no cost.
 */
export function emitTokensCommand(options: EmitTokensCliOptions): void {
  const root = options.root ?? process.cwd();
  emitTokens(
    root,
    {
      input: count(options.input),
      output: count(options.output),
      cacheRead: count(options.cacheRead),
      cacheCreate: count(options.cacheCreate),
    },
    {
      model: options.model,
      ...(options.feature !== undefined ? { feature: options.feature } : {}),
      ...(options.step !== undefined ? { step: options.step } : {}),
    },
  );
}

export interface EmitReviewCliOptions {
  tier: string;
  resolution: string;
  feature?: string;
  step?: string;
  summary?: string;
  root?: string;
}

/**
 * `codument emit review` — record one resolved review finding (self-reported,
 * tiered) into .codument/events.jsonl. The agent's `review-work` step shells this
 * once per finding it fixed/deferred. Invalid tier/resolution exits nonzero
 * without writing a malformed event.
 */
export function emitReviewCommand(options: EmitReviewCliOptions): void {
  const root = options.root ?? process.cwd();
  try {
    emitReview(root, {
      tier: options.tier as ReviewTier,
      resolution: options.resolution as ReviewResolution,
      ...(options.feature !== undefined ? { feature: options.feature } : {}),
      ...(options.step !== undefined ? { step: options.step } : {}),
      ...(options.summary !== undefined ? { summary: options.summary } : {}),
    });
  } catch (err) {
    console.error(`codument emit review: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
