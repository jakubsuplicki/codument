import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
} from "node:fs";
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

/** Reads every event in the log oldest→newest, skipping malformed lines. */
export function readAllEvents(root: string): CodumentEvent[] {
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
  return events;
}

/** Reads recent events oldest→newest, capped at `limit` (the most recent). */
export function readRecentEvents(root: string, limit = 20): CodumentEvent[] {
  return readAllEvents(root).slice(-limit);
}

/**
 * Atomically replace a file's contents: write a sibling temp file, fsync it,
 * then rename over the target (rename is atomic on POSIX). A crash, SIGKILL, or
 * power loss mid-write leaves the original intact rather than a truncated file —
 * the safety net that lets `feed --reset` rewrite the log without a backup.
 */
export function atomicWriteFileSync(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * Overwrite the event log with exactly `events` (each kept verbatim, including
 * its `ts`). The one writer that isn't append-only — used by `feed --reset` to
 * drop feed-sourced events before rebuilding them. Written atomically so an
 * interrupted reset can never corrupt or truncate the log. An empty list
 * truncates the file rather than leaving a stray blank line.
 */
export function rewriteEvents(root: string, events: CodumentEvent[]): void {
  const dir = join(root, ".codument");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join("\n");
  atomicWriteFileSync(eventsPath(root), body ? body + "\n" : "");
}
