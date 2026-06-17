import { emitTokens } from "../lib/emit-producer.js";

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
