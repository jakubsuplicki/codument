import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Append-only flow-event log at .codument/events.jsonl. It carries richer flow
// events than the deterministic coverage artifact — review summaries, work-step
// notes, and the review-effectiveness notes from the review-effectiveness-metric
// concept. `watch` tails it. Timestamps are wall-clock here (it is a live log,
// not the deterministic score), so this log never feeds any coverage number.

export interface CodumentEvent {
  ts: string; // ISO timestamp
  type: string; // "review" | "step" | "note" | ...
  message?: string;
  data?: Record<string, unknown>;
}

function eventsPath(root: string): string {
  return join(root, ".codument", "events.jsonl");
}

export function appendEvent(
  root: string,
  event: Omit<CodumentEvent, "ts"> & { ts?: string },
): void {
  const dir = join(root, ".codument");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const record: CodumentEvent = {
    ts: event.ts ?? new Date().toISOString(),
    type: event.type,
    ...(event.message !== undefined ? { message: event.message } : {}),
    ...(event.data !== undefined ? { data: event.data } : {}),
  };
  appendFileSync(eventsPath(root), JSON.stringify(record) + "\n");
}

/** Reads recent events oldest→newest, capped at `limit` (the most recent). */
export function readRecentEvents(root: string, limit = 20): CodumentEvent[] {
  const path = eventsPath(root);
  if (!existsSync(path)) return [];
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const events: CodumentEvent[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as CodumentEvent;
      if (parsed && typeof parsed.type === "string") events.push(parsed);
    } catch {
      // skip malformed lines
    }
  }
  return events.slice(-limit);
}
