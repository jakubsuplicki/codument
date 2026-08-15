import pc from "picocolors";
import { emitTokens } from "../lib/emit-producer.js";
import {
  emitReview,
  type RecordedReview,
  type ReviewTier,
  type ReviewResolution,
} from "../lib/review-events.js";

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
    const recorded = emitReview(root, {
      tier: options.tier as ReviewTier,
      resolution: options.resolution as ReviewResolution,
      ...(options.feature !== undefined ? { feature: options.feature } : {}),
      ...(options.step !== undefined ? { step: options.step } : {}),
      ...(options.summary !== undefined ? { summary: options.summary } : {}),
    });
    console.log(renderRecordedReview(recorded));
  } catch (err) {
    console.error(`codument emit review: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

/**
 * The echo for a recorded review finding.
 *
 * A command that changes state and prints nothing leaves the caller to trust that
 * it worked; the agent loop runs this once per finding and, in the field, ran it
 * many times into silence with no way to tell a recorded finding from a typo'd
 * flag. So it says what it wrote — from the record, never re-derived from the
 * inputs beside it.
 *
 * What it must NOT be is a green tick. This event is the SELF-REPORTED line of
 * the ledger: an agent's claim about its own work, which codument stores and does
 * not check, and which the `watch` headline deliberately discounts. A success
 * mark here would be codument appearing to vouch for it — a fourth confident
 * green in a loop whose greens were already the problem. Informational mark,
 * dim, and the words "self-reported" in the line itself.
 */
export function renderRecordedReview(recorded: RecordedReview): string {
  // Presence is tested exactly as the writer tests it — `!== undefined`, never
  // truthiness. `--feature ""` is recorded, so it must be echoed; dropping it
  // because it is falsy would make the line disagree with the log on the one
  // input where a caller most needs to see what actually landed.
  const parts: string[] = [recorded.tier, recorded.resolution];
  if (recorded.feature !== undefined) parts.push(recorded.feature);
  if (recorded.step !== undefined) parts.push(`step ${recorded.step}`);
  const label = recorded.summary !== undefined ? ` — ${recorded.summary}` : "";
  return `  ${pc.cyan("ℹ")} ${pc.dim(`recorded, self-reported: ${parts.join(" · ")}${label}`)}`;
}
