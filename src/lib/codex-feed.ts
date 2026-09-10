import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { appendEvent, atomicWriteFileSync, readEventLog, withEventLock, type CodumentEvent } from "./events.js";
import { readBoundedState } from "./state-io.js";
import type { HostCapture } from "./agent-feed.js";
import type { TokenUsage } from "./token-cost.js";

interface Options { home?: string; input?: string; reset?: boolean }
type Format = "rollout" | "json";
interface Cursor {
  offset: number;
  anchor: string;
  session: string | null;
  model: string;
  inherited: boolean;
  total: TokenUsage | null;
  ordinal: number;
  turnOpen: boolean;
  threadStarted: boolean;
  blocked: boolean;
  reasons: string[];
}
interface State { version: 1; files: Record<string, Cursor> }
interface HighWater { format: Format; total: TokenUsage; ordinal: number; checkpoints: Map<number, TokenUsage> }
export interface CodexPumpResult { emitted: number; sessions: number; reasons: string[] }
const ZERO = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
const BUCKETS = ["input", "output", "cacheRead", "cacheCreate"] as const;
const MAX_READ = 8 * 1024 * 1024;
const MAX_STATE = 2 * 1024 * 1024;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
const validUsage = (value: unknown): value is TokenUsage => !!object(value) && BUCKETS.every(bucket => count(object(value)![bucket]));
function key(path: string): string {
  let absolute: string;
  try { absolute = realpathSync(path); } catch { absolute = resolve(path); }
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
function fresh(): Cursor {
  return { offset: 0, anchor: hash(""), session: null, model: "(unknown)", inherited: false, total: null, ordinal: 0, turnOpen: false, threadStarted: false, blocked: false, reasons: [] };
}
function reason(cursor: Cursor, value: string): void { if (!cursor.reasons.includes(value)) cursor.reasons.push(value); }
function statePath(root: string): string { return join(root, ".codument", "codex-feed-state.json"); }
function readState(root: string): State {
  const raw = readBoundedState(statePath(root), MAX_STATE);
  if (raw === null) return { version: 1, files: {} };
  const state = JSON.parse(raw);
  if (state?.version !== 1 || !object(state.files) || Object.keys(state.files).length > 10000) throw new Error("invalid state");
  for (const [path, item] of Object.entries(state.files)) {
    const row = object(item);
    if (!isAbsolute(path) || !row || !count(row.offset) || typeof row.anchor !== "string" || !/^[a-f0-9]{64}$/.test(row.anchor) ||
      !(row.session === null || identifier(row.session)) || typeof row.model !== "string" || row.model.length > 128 ||
      !(row.total === null || validUsage(row.total)) || !count(row.ordinal) ||
      [row.inherited, row.turnOpen, row.threadStarted, row.blocked].some(value => typeof value !== "boolean") ||
      !Array.isArray(row.reasons) || row.reasons.length > 30 || row.reasons.some(value => typeof value !== "string" || !/^[a-z-]{1,80}$/.test(value))) throw new Error("invalid cursor");
  }
  return state;
}
function bytes(file: string, offset: number, length: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, read);
  } finally { closeSync(fd); }
}
function anchor(file: string, offset: number): string {
  const n = Math.min(offset, 4096);
  return hash(Buffer.concat([bytes(file, 0, n), bytes(file, Math.max(0, offset - n), n)]));
}

/** Codex input/cache and output/reasoning are inclusive; normalized buckets must be disjoint. */
export function normalizeCodexUsage(value: unknown): TokenUsage | null {
  const usage = object(value);
  if (!usage || !count(usage.input_tokens) || !count(usage.output_tokens)) return null;
  const cached = usage.cached_input_tokens;
  const written = usage.cache_write_input_tokens === undefined ? 0 : usage.cache_write_input_tokens;
  const reasoning = usage.reasoning_output_tokens === undefined ? 0 : usage.reasoning_output_tokens;
  if (!count(cached) || !count(written) || !count(reasoning) || cached + written > usage.input_tokens || reasoning > usage.output_tokens ||
    (usage.total_tokens !== undefined && (!count(usage.total_tokens) || usage.total_tokens !== usage.input_tokens + usage.output_tokens))) return null;
  return { input: usage.input_tokens - cached - written, output: usage.output_tokens, cacheRead: cached, cacheCreate: written };
}

function metadata(record: Record<string, unknown>, cursor: Cursor, root: string): void {
  if (record.type !== "session_meta" && record.type !== "turn_context") return;
  const payload = object(record.payload);
  if (!payload) { reason(cursor, "unsupported-session-format"); cursor.blocked = true; return; }
  if (record.version !== undefined && record.version !== 1) { reason(cursor, "unsupported-session-format"); cursor.blocked = true; return; }
  if (payload.cwd !== undefined && (typeof payload.cwd !== "string" || !isAbsolute(payload.cwd) || key(payload.cwd) !== key(root))) {
    reason(cursor, "conflicting-session-identity"); cursor.blocked = true;
  }
  if (record.type === "session_meta") {
    const id = payload.id;
    if (!identifier(id) || typeof payload.cwd !== "string" || !isAbsolute(payload.cwd)) {
      reason(cursor, "missing-repository-identity"); cursor.blocked = true; return;
    }
    if (cursor.session !== null && cursor.session !== id) { reason(cursor, "conflicting-session-identity"); cursor.blocked = true; }
    cursor.session = id;
    const spawn = object(object(object(payload.source)?.subagent)?.thread_spawn);
    cursor.inherited ||= [payload.parent_thread_id, payload.forked_from_id, payload.history_base, spawn?.parent_thread_id]
      .some(lineage => lineage !== undefined && lineage !== null);
  }
  if (payload.model !== undefined) cursor.model = typeof payload.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/.test(payload.model) ? payload.model : "(unknown)";
}

interface Discovery { files: string[]; reasons: string[]; missing: boolean }
function discover(root: string, options: Options): Discovery {
  const found: Discovery = { files: [], reasons: [], missing: false };
  const candidates: string[] = [];
  if (options.input) candidates.push(resolve(root, options.input));
  else {
    const base = options.home ? join(options.home, ".codex") : process.env.CODEX_HOME ?? join(homedir(), ".codex");
    let visited = 0;
    const walk = (directory: string, depth: number) => {
      if (++visited > 10000 || depth > 4) { found.reasons.push("discovery-limited"); return; }
      try {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (++visited > 10000) { found.reasons.push("discovery-limited"); break; }
          const path = join(directory, entry.name);
          if (entry.isDirectory()) walk(path, depth + 1);
          else if (entry.isFile() && entry.name.endsWith(".jsonl")) candidates.push(path);
        }
      } catch (error) {
        if (depth === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") found.missing = true;
        else found.reasons.push("unreadable-session-input");
      }
    };
    walk(join(base, "sessions"), 0);
  }
  const seen = new Set<string>();
  for (const file of candidates) {
    const canonical = key(file);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    try {
      if (!statSync(file).isFile()) throw new Error("not a regular file");
      const head = bytes(file, 0, Math.min(statSync(file).size, 1_000_000)).toString("utf8");
      const cursor = fresh();
      // The first complete metadata record supplies provenance. Ingestion checks later records.
      for (const line of head.slice(0, head.lastIndexOf("\n") + 1).split("\n")) {
        try {
          const record = object(JSON.parse(line));
          if (record?.type === "session_meta") { metadata(record, cursor, root); break; }
        } catch { /* discovery does not claim to validate usage */ }
      }
      if (cursor.session && !cursor.blocked) found.files.push(canonical);
      else if (options.input || !cursor.reasons.includes("conflicting-session-identity")) found.reasons.push(...(cursor.reasons.length ? cursor.reasons : ["missing-repository-identity"]));
    } catch { found.reasons.push("unreadable-session-input"); }
  }
  return found;
}

function captured(root: string): { water: Map<string, HighWater>; count: number; reasons: string[] } {
  const ledger = readEventLog(root);
  const result = { water: new Map<string, HighWater>(), count: 0, reasons: [] as string[] };
  if (ledger.state === "partial" || ledger.state === "unavailable") result.reasons.push("ledger-incomplete");
  for (const event of ledger.events) {
    if (event.type !== "tokens" || event.data?.source !== "codex-feed") continue;
    result.count++;
    const data = event.data;
    if (!identifier(data.session) || !validUsage(data.counter) || !validUsage(data) || !count(data.ordinal) || (data.format !== "json" && data.format !== "rollout")) {
      result.reasons.push("invalid-captured-identity"); continue;
    }
    const previous = result.water.get(data.session);
    if (previous && previous.format !== data.format) { result.reasons.push("conflicting-usage-stream"); continue; }
    const checkpoints = previous?.checkpoints ?? new Map<number, TokenUsage>();
    if (data.format === "json") checkpoints.set(data.ordinal, data.counter);
    result.water.set(data.session, { format: data.format, ordinal: Math.max(previous?.ordinal ?? 0, data.ordinal), total: Object.fromEntries(BUCKETS.map(bucket => [bucket, Math.max(previous?.total[bucket] ?? 0, (data.counter as TokenUsage)[bucket])])) as unknown as TokenUsage, checkpoints });
  }
  return result;
}

function parse(file: string, root: string, cursor: Cursor, water: Map<string, HighWater>): CodumentEvent[] {
  const size = statSync(file).size;
  if (cursor.offset > size || (cursor.offset > 0 && anchor(file, cursor.offset) !== cursor.anchor)) {
    const oldReasons = cursor.reasons;
    Object.assign(cursor, fresh());
    cursor.reasons = [...new Set([...oldReasons, "source-truncated-or-replaced"])];
  }
  if (cursor.blocked || size === cursor.offset) return [];
  const chunk = bytes(file, cursor.offset, Math.min(size - cursor.offset, MAX_READ));
  const end = chunk.lastIndexOf(10);
  if (end < 0) { reason(cursor, chunk.length === MAX_READ ? "record-read-limited" : "incomplete-source-line"); return []; }
  const events: CodumentEvent[] = [];
  for (const line of chunk.subarray(0, end + 1).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown> | null;
    try { record = object(JSON.parse(line)); } catch { record = null; }
    if (!record) { reason(cursor, "malformed-session-records"); continue; }
    metadata(record, cursor, root);
    if (cursor.blocked) break;
    if (record.type === "thread.started") {
      if (record.thread_id !== cursor.session || cursor.threadStarted) { reason(cursor, "conflicting-session-identity"); cursor.blocked = true; break; }
      cursor.threadStarted = true;
    }
    if (record.type === "turn.started") cursor.turnOpen = true;
    const payload = object(record.payload);
    const rollout = record.type === "event_msg" && payload?.type === "token_count";
    if (!rollout && record.type !== "turn.completed") continue;
    if (!cursor.session) { reason(cursor, "missing-repository-identity"); continue; }
    const format: Format = rollout ? "rollout" : "json";
    if (!rollout && (!cursor.threadStarted || !cursor.turnOpen)) { reason(cursor, "missing-turn-identity"); continue; }
    if (!rollout) { cursor.turnOpen = false; cursor.ordinal++; }
    const info = object(payload?.info);
    const usage = normalizeCodexUsage(rollout ? info?.total_token_usage : record.usage);
    if (!usage) { reason(cursor, "invalid-or-missing-usage"); continue; }
    const known = water.get(cursor.session);
    if (known && known.format !== format) { reason(cursor, "conflicting-usage-stream"); continue; }
    if (cursor.model === "(unknown)") reason(cursor, "model-unavailable");
    const total = rollout ? usage : Object.fromEntries(BUCKETS.map(bucket => [bucket, (cursor.total?.[bucket] ?? 0) + usage[bucket]])) as unknown as TokenUsage;
    if (!validUsage(total)) { reason(cursor, "invalid-or-missing-usage"); continue; }
    if (rollout && cursor.inherited) {
      reason(cursor, "inherited-history-unavailable");
      continue;
    }
    const previous = rollout
      ? Object.fromEntries(BUCKETS.map(bucket => [bucket, Math.max(known?.total[bucket] ?? 0, cursor.total?.[bucket] ?? 0)])) as unknown as TokenUsage
      : known?.total ?? ZERO();
    if (!rollout && known && cursor.ordinal <= known.ordinal) {
      const checkpoint = known.checkpoints.get(cursor.ordinal);
      if (checkpoint && BUCKETS.some(bucket => checkpoint[bucket] !== total[bucket])) {
        reason(cursor, "conflicting-usage-stream"); cursor.blocked = true; break;
      }
      cursor.total = total;
      continue;
    }
    if (BUCKETS.some(bucket => total[bucket] < previous[bucket])) { reason(cursor, "counter-reset"); continue; }
    cursor.total = total;
    const delta = Object.fromEntries(BUCKETS.map(bucket => [bucket, total[bucket] - previous[bucket]])) as unknown as TokenUsage;
    if (!BUCKETS.some(bucket => delta[bucket] > 0)) continue;
    const ordinal = rollout ? 0 : cursor.ordinal;
    const data = { source: "codex-feed", host: "codex", session: cursor.session, model: cursor.model, ...delta, format, ordinal, counter: total, captureId: hash(JSON.stringify([cursor.session, format, total, ordinal])) };
    events.push({ type: "tokens", ts: typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString(), data });
    const checkpoints = new Map(known?.checkpoints);
    if (!rollout) checkpoints.set(ordinal, total);
    water.set(cursor.session, { format, total, ordinal, checkpoints });
  }
  cursor.offset += end + 1;
  cursor.anchor = anchor(file, cursor.offset);
  if (cursor.offset < size) reason(cursor, cursor.offset + MAX_READ < size ? "capture-read-limited" : "incomplete-source-line");
  return cursor.blocked ? [] : events;
}

/** Availability is read-only; persisted omissions remain visible after the source moves on. */
export function inspectCodexCapture(root: string, options: Options = {}): HostCapture {
  const discovery = discover(root, options);
  const ledger = captured(root);
  const reasons = [...discovery.reasons, ...ledger.reasons];
  try {
    const state = readState(root);
    for (const cursor of Object.values(state.files)) reasons.push(...cursor.reasons);
    for (const file of discovery.files) {
      try {
        const cursor = structuredClone(state.files[file] ?? fresh());
        parse(file, root, cursor, new Map(ledger.water));
        reasons.push(...cursor.reasons);
      } catch { reasons.push("unreadable-session-input"); }
    }
  } catch { reasons.push("invalid-capture-state"); }
  if (discovery.missing) reasons.push("session-directory-missing");
  if (!discovery.files.length && ledger.count) reasons.push("no-matching-session");
  return { host: "codex", state: discovery.missing || (reasons.includes("unreadable-session-input") && !discovery.files.length) ? "unavailable" : !discovery.files.length && reasons.includes("unsupported-session-format") ? "unsupported" : reasons.length ? "partial" : ledger.count ? "available" : "empty", sessions: discovery.files.length, capturedEvents: ledger.count, reasons: [...new Set(reasons)].sort() };
}

/** Best-effort bounded ingestion. Captured high-water marks survive cursor resets and copies. */
export function pumpCodexFeed(root: string, options: Options = {}): CodexPumpResult {
  const discovery = discover(root, options);
  const result: CodexPumpResult = { emitted: 0, sessions: discovery.files.length, reasons: [...discovery.reasons] };
  if (discovery.missing) result.reasons.push("session-directory-missing");
  if (!discovery.files.length) return result;
  try {
    return withEventLock(root, () => {
      let state: State;
      try { state = readState(root); } catch { result.reasons.push("invalid-capture-state"); return result; }
      const ledger = captured(root);
      result.reasons.push(...ledger.reasons);
      if (ledger.reasons.length) return result;
      for (const file of discovery.files) {
        const prior = state.files[file];
        const cursor = options.reset ? fresh() : prior ?? fresh();
        if (options.reset) cursor.reasons = [...new Set([...(prior?.reasons ?? []), "capture-cursor-reset"])];
        try {
          const nextWater = new Map(ledger.water);
          const events = parse(file, root, cursor, nextWater);
          for (const event of events) { appendEvent(root, event); result.emitted++; }
          if (!cursor.blocked) ledger.water = nextWater;
          state.files[file] = cursor;
          result.reasons.push(...cursor.reasons);
        } catch { result.reasons.push("unreadable-session-input"); }
      }
      const serialized = JSON.stringify(state) + "\n";
      if (Buffer.byteLength(serialized) > MAX_STATE) result.reasons.push("capture-state-limited");
      else atomicWriteFileSync(statePath(root), serialized);
      result.reasons = [...new Set(result.reasons)].sort();
      return result;
    });
  } catch { result.reasons.push("capture-writer-unavailable"); return result; }
}
