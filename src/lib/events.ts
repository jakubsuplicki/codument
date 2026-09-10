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
  realpathSync,
  fstatSync,
  readSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { withStateLock } from "./state-io.js";

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

const heldEventLocks = new Set<string>();
/** Synchronous feed transactions and individual producers share one writer boundary. */
export function withEventLock<T>(root: string, operation: () => T): T {
  let canonical: string;
  try { canonical = realpathSync(root); } catch { canonical = resolve(root); }
  const path = eventsPath(process.platform === "win32" ? canonical.toLowerCase() : canonical);
  if (heldEventLocks.has(path)) return operation();
  return withStateLock(path, () => {
    heldEventLocks.add(path);
    try { return operation(); }
    finally { heldEventLocks.delete(path); }
  });
}

export function appendEvent(root: string, event: Omit<CodumentEvent, "ts"> & { ts?: string }): void {
  withEventLock(root, () => appendUnlocked(root, event));
}

function appendUnlocked(
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
  const line = JSON.stringify(record) + "\n";
  const fd = openSync(eventsPath(root), "a+");
  try {
    const size = fstatSync(fd).size;
    const last = Buffer.alloc(1);
    const needsBoundary = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 10;
    appendFileSync(fd, (needsBoundary ? "\n" : "") + line);
  } finally { closeSync(fd); }
}

export interface EventLogRead {
  events: CodumentEvent[];
  state: "available" | "empty" | "partial" | "unavailable";
  skipped: number;
}

/** Preserve valid events while making missing evidence visible to capture consumers. */
export function readEventLog(root: string): EventLogRead {
  const path = eventsPath(root);
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (error) {
    return {
      events: [],
      state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "empty" : "unavailable",
      skipped: 0,
    };
  }
  const events: CodumentEvent[] = [];
  let skipped = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as CodumentEvent;
      if (parsed && typeof parsed.type === "string") events.push(parsed);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { events, state: skipped ? "partial" : events.length ? "available" : "empty", skipped };
}

/** Compatibility view: readers asking only for events retain their existing behavior. */
export function readAllEvents(root: string): CodumentEvent[] {
  return readEventLog(root).events;
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
  withEventLock(root, () => rewriteUnlocked(root, events));
}

function rewriteUnlocked(root: string, events: CodumentEvent[]): void {
  const dir = join(root, ".codument");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join("\n");
  atomicWriteFileSync(eventsPath(root), body ? body + "\n" : "");
}
