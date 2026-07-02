import {
  existsSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  realpathSync,
  mkdirSync,
} from "node:fs";
import { join, relative, resolve, basename, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { allSources, type Registry, readRegistrySync } from "./registry.js";
import {
  appendEvent,
  readAllEvents,
  rewriteEvents,
  atomicWriteFileSync,
  type CodumentEvent,
} from "./events.js";

// Adapter that turns a coding agent's own session telemetry into codument
// events. Claude Code writes an append-only JSONL transcript per session under
// ~/.claude/projects/<slug>/<session>.jsonl; every assistant turn carries exact
// per-turn token usage (input/output/cache, incl. the thinking and reading
// turns) plus the tool calls it made. We tail that file — the agent's existing
// "exhaust" — and normalize it into .codument/events.jsonl, attributing each
// turn to a feature via the registry's file→feature map. Zero token cost (we
// read what already exists), no model instrumentation, and `watch` — along with
// any downstream reader of the event stream — consumes the one normalized stream.
//
// The transcript is an internal Claude Code format, so this is a best-effort
// adapter: every field is read defensively and a shape change degrades to fewer
// events, never a crash.

// ── Session-log discovery ───────────────────────────────────────────────

export function claudeProjectsDir(home = homedir()): string {
  return join(home, ".claude", "projects");
}

function jsonlFilesIn(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".jsonl")).map((n) => join(dir, n));
}

/** Bounded head read — enough to find the session's `cwd` without slurping a
 *  multi-megabyte transcript. */
function readHead(file: string, bytes = 65536): string {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const size = statSync(file).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, 0);
    return buf.toString("utf-8");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

/** The `cwd` a transcript belongs to. Regex over a generous head window so a
 *  giant first line (a big paste) or early records that lack `cwd` can't hide
 *  it — matches the raw JSON field without needing a complete parseable line. */
function sessionCwd(file: string): string | null {
  const head = readHead(file, 1_000_000);
  const m = /"cwd"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(head);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

/** A transcript's recorded `cwd` is constant for the life of the file, so cache
 *  it per path: the fallback scan in `resolveSessionLogs` runs every pump and
 *  would otherwise re-read a head window per file per tick. Only positive
 *  results are cached — a just-created transcript may not have written its `cwd`
 *  yet, and must be re-read until it does rather than be excluded forever. */
const sessionCwdCache = new Map<string, string>();
function cachedSessionCwd(file: string): string | null {
  const key = canonSession(file);
  const cached = sessionCwdCache.get(key);
  if (cached !== undefined) return cached;
  const cwd = sessionCwd(file);
  if (cwd !== null) sessionCwdCache.set(key, cwd);
  return cwd;
}

/** The `sessionId` a transcript records (constant within a file). Regex over a
 *  head window, like `sessionCwd`, so it doesn't depend on a fully parseable
 *  first line. Used to match feed events (which carry `data.session`) back to a
 *  transcript file when deciding whether their source still exists. */
function sessionIdOf(file: string): string | null {
  const head = readHead(file, 65536);
  const m = /"sessionId"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(head);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

/** Newest .jsonl in a directory by mtime, or null. */
function newestJsonl(dir: string): string | null {
  let best: string | null = null;
  let bestMtime = -1;
  for (const file of jsonlFilesIn(dir)) {
    let m: number;
    try {
      m = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (m > bestMtime) {
      bestMtime = m;
      best = file;
    }
  }
  return best;
}

/** Newest of an explicit file list by mtime, or null. */
function newestOf(files: string[]): string | null {
  let best: string | null = null;
  let bestMtime = -1;
  for (const file of files) {
    let m: number;
    try {
      m = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (m > bestMtime) {
      bestMtime = m;
      best = file;
    }
  }
  return best;
}

/**
 * The active Claude Code transcript for `root`: the most-recently-modified
 * session whose recorded `cwd` matches the project root. Matching on `cwd`
 * (rather than reverse-engineering the dir-name slug) is robust to how Claude
 * encodes paths. Returns null when no matching session exists.
 */
export function resolveSessionLog(root: string, home = homedir()): string | null {
  const projects = claudeProjectsDir(home);
  if (!existsSync(projects)) return null;

  // Primary: Claude names each project dir by the cwd with separators replaced,
  // so the dir name *is* the slug. A direct lookup needs no file read and is
  // immune to giant pastes / early records that lack `cwd`.
  const slug = root.replace(/[/.]/g, "-");
  const slugDir = join(projects, slug);
  if (existsSync(slugDir)) {
    const newest = newestJsonl(slugDir);
    if (newest) return newest;
  }

  // Fallback: scan every project dir and match the recorded cwd — covers any
  // slug encoding we didn't anticipate.
  let best: string | null = null;
  let bestMtime = -1;
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projects).map((n) => join(projects, n));
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const newest = newestJsonl(dir); // each project's active session
    if (!newest) continue;
    let mtime: number;
    try {
      mtime = statSync(newest).mtimeMs;
    } catch {
      continue;
    }
    if (mtime <= bestMtime) continue;
    if (sessionCwd(newest) === root) {
      best = newest;
      bestMtime = mtime;
    }
  }
  return best;
}

/**
 * Every Claude Code transcript whose recorded `cwd` matches `root` — the
 * complete set the feed should pump, not just the newest. Concurrent windows
 * each write their own session file, so following only the newest (see
 * `resolveSessionLog`) under-counts spend and makes the live total jump between
 * windows. Returns de-duplicated original paths (canonicalized only for the
 * dedupe key). Cheap on repeat calls: the slug dir needs no per-file read, and
 * the fallback scan caches each file's constant `cwd`.
 */
export function resolveSessionLogs(root: string, home = homedir()): string[] {
  const projects = claudeProjectsDir(home);
  if (!existsSync(projects)) return [];

  const byCanon = new Map<string, string>(); // canonical path -> original path
  const add = (file: string): void => {
    const c = canonSession(file);
    if (!byCanon.has(c)) byCanon.set(c, file);
  };

  // Primary: Claude names each project dir for the cwd, so every transcript in
  // the slug dir belongs to root — no per-file `cwd` read needed (the trust
  // `resolveSessionLog` places in the slug dir, extended to its siblings).
  const slug = root.replace(/[/.]/g, "-");
  const slugDir = join(projects, slug);
  const slugExists = existsSync(slugDir);
  if (slugExists) for (const file of jsonlFilesIn(slugDir)) add(file);

  // Fallback: scan the other project dirs and match the recorded `cwd`, covering
  // any slug encoding we didn't anticipate.
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projects);
  } catch {
    return [...byCanon.values()];
  }
  for (const name of projectDirs) {
    const dir = join(projects, name);
    if (slugExists && dir === slugDir) continue;
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of jsonlFilesIn(dir)) {
      if (cachedSessionCwd(file) === root) add(file);
    }
  }
  return [...byCanon.values()];
}

// ── Feature attribution ─────────────────────────────────────────────────

/** The feature that owns `file` (repo-relative path), preferring a primary
 *  owner over a related one, deterministic by feature name. */
export function featureForFile(file: string, registry: Registry): string | null {
  const entries = Object.entries(registry.features).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const [key, entry] of entries) {
    if (entry.primary_sources.includes(file)) return key;
  }
  for (const [key, entry] of entries) {
    if (entry.related_sources.includes(file)) return key;
  }
  // last resort: any source mention (kept for forward-compat with allSources)
  for (const [key, entry] of entries) {
    if (allSources(entry).includes(file)) return key;
  }
  return null;
}

/**
 * Canonicalize a Claude Code transcript model id to codument's rate-table key.
 * Transcripts carry the full id (e.g. `claude-opus-4-8`, occasionally with a
 * trailing date), while MODEL_RATES keys on the short `<family>-<major>.<minor>`
 * form (`opus-4.8`). This is a deterministic canonicalization of the known
 * Claude id shape — NOT fuzzy matching: anything that doesn't fit is returned
 * unchanged, so it still exact-matches the table or surfaces as unpriced (the
 * pricing layer's typo-safety is preserved).
 */
export function normalizeModelId(model: string): string {
  if (typeof model !== "string") return model;
  // Drop a context-variant suffix like the `[1m]` on `claude-opus-4-8[1m]` —
  // same model, same price — and an optional dated snapshot suffix.
  const base = model.trim().replace(/\[[^\]]*\]$/, "");
  // Two-segment families: claude-opus-4-8 -> opus-4.8
  const versioned = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-\d{6,8})?$/.exec(base);
  if (versioned) return `${versioned[1]}-${versioned[2]}.${versioned[3]}`;
  // Single-segment families: claude-fable-5 -> fable-5
  const single = /^claude-(fable|mythos)-(\d+)(?:-\d{6,8})?$/.exec(base);
  if (single) return `${single[1]}-${single[2]}`;
  return model;
}

/** Absolute tool path → repo-relative POSIX path; null when outside the repo. */
function toRepoRelative(filePath: string, root: string): string | null {
  if (typeof filePath !== "string" || filePath === "") return null;
  const abs = isAbsolute(filePath) ? filePath : join(root, filePath);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..")) return null;
  return rel.split("\\").join("/");
}

// ── Record → events ─────────────────────────────────────────────────────

// Tool name → activity tape kind. Tools not listed produce no activity line
// (TodoWrite/AskUserQuestion/ToolSearch/etc. are UI noise), though their file
// paths still inform feature attribution.
const ACTIVITY_KIND: Record<string, string> = {
  Read: "read",
  Edit: "edit",
  Write: "write",
  NotebookEdit: "edit",
  Bash: "bash",
  Grep: "grep",
  Glob: "glob",
  Task: "agent",
  Agent: "agent",
};
const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];
const READ_TOOLS = ["Read", "Grep", "Glob"];

export interface FeedContext {
  root: string;
  registry: Registry;
  /** Carried from the previous turn so a pure thinking/reading turn is still
   *  attributed to the feature currently being worked on. */
  prevFeature?: string | null;
  sessionId?: string;
}

export interface RecordResult {
  events: Array<Omit<CodumentEvent, "ts"> & { ts: string }>;
  /** Resolved feature for this turn, to carry into the next. */
  feature: string | null;
}

function coerceNum(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Normalize one parsed transcript record into codument events: a `tokens` event
 * per assistant turn (usage + model + attributed feature) plus an activity event
 * per meaningful tool call. Pure and defensive — unknown/partial shapes yield
 * fewer events, never throw. Returns the turn's feature for carry-forward.
 */
export function recordToEvents(record: unknown, ctx: FeedContext): RecordResult {
  const prev = ctx.prevFeature ?? null;
  const rec = record as Record<string, unknown>;
  if (!rec || rec.type !== "assistant") return { events: [], feature: prev };

  const msg = rec.message as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== "object") return { events: [], feature: prev };

  const ts = typeof rec.timestamp === "string" ? rec.timestamp : null;
  if (!ts) return { events: [], feature: prev };

  const uuid = typeof rec.uuid === "string" ? rec.uuid : undefined;
  const session =
    ctx.sessionId ?? (typeof rec.sessionId === "string" ? rec.sessionId : undefined);

  const content = Array.isArray(msg.content) ? msg.content : [];
  const toolUses = content.filter(
    (c): c is Record<string, unknown> =>
      !!c && typeof c === "object" && (c as Record<string, unknown>).type === "tool_use",
  );

  // Resolve this turn's feature: an edit/write is the strongest signal, then a
  // read, then carry-forward (so reasoning turns attribute to current work).
  const featureFromTools = (toolNames: string[]): string | null => {
    for (const tu of toolUses) {
      if (!toolNames.includes(tu.name as string)) continue;
      const input = tu.input as Record<string, unknown> | undefined;
      const rel = toRepoRelative(input?.file_path as string, ctx.root);
      if (!rel) continue;
      const f = featureForFile(rel, ctx.registry);
      if (f) return f;
    }
    return null;
  };
  const feature =
    featureFromTools(EDIT_TOOLS) ?? featureFromTools(READ_TOOLS) ?? prev;

  const events: RecordResult["events"] = [];

  // Token event for the turn (input/output/cache, incl. thinking & reading).
  const usage = msg.usage as Record<string, unknown> | undefined;
  const model = typeof msg.model === "string" ? msg.model : undefined;
  if (usage && model) {
    const input = coerceNum(usage.input_tokens);
    const output = coerceNum(usage.output_tokens);
    const cacheRead = coerceNum(usage.cache_read_input_tokens);
    const cacheCreate = coerceNum(usage.cache_creation_input_tokens);
    // Skip zero-usage turns: Claude Code emits `<synthetic>` assistant notices
    // (model-selection errors, "No response requested.") with an all-zero usage
    // block. They are no real inference — recording them only inflates the event
    // count and pollutes the "unpriced models" signal with a non-model id.
    if (input + output + cacheRead + cacheCreate > 0) {
      events.push({
        type: "tokens",
        ts,
        data: {
          source: "feed",
          model: normalizeModelId(model),
          input,
          output,
          cacheRead,
          cacheCreate,
          ...(feature ? { feature } : {}),
          ...(session ? { session } : {}),
          ...(uuid ? { uuid } : {}),
        },
      });
    }
  }

  // Activity events for meaningful tool calls.
  for (const tu of toolUses) {
    const name = tu.name as string;
    const kind = ACTIVITY_KIND[name];
    if (!kind) continue;
    const input = (tu.input as Record<string, unknown>) ?? {};
    let label: string;
    let file: string | null = null;
    if (kind === "bash") {
      const desc = typeof input.description === "string" ? input.description : "";
      const cmd = typeof input.command === "string" ? input.command : "";
      label = desc || truncate(cmd, 60) || "command";
    } else if (kind === "agent") {
      label =
        typeof input.description === "string" ? input.description : "subagent";
    } else {
      file = toRepoRelative(input.file_path as string, ctx.root);
      const f = file ? featureForFile(file, ctx.registry) : null;
      const base = file ? basename(file) : "?";
      label = f ? `${f} → ${base}` : base;
    }
    events.push({
      type: kind,
      ts,
      message: label,
      data: {
        source: "feed",
        tool: name,
        ...(file ? { file } : {}),
        ...(feature ? { feature } : {}),
        ...(session ? { session } : {}),
        ...(uuid ? { uuid } : {}),
      },
    });
  }

  return { events, feature: feature ?? prev };
}

// ── Tailer (stateful runtime) ───────────────────────────────────────────

interface FeedState {
  /** Byte offset consumed per session-log path (append-only files). */
  offsets: Record<string, number>;
  /** Last attributed feature per session, for carry-forward across restarts. */
  feature: Record<string, string>;
}

function feedStatePath(root: string): string {
  return join(root, ".codument", "feed-state.json");
}

function readFeedState(root: string): FeedState {
  try {
    const parsed = JSON.parse(readFileSync(feedStatePath(root), "utf-8"));
    return {
      offsets: parsed.offsets ?? {},
      feature: parsed.feature ?? {},
    };
  } catch {
    return { offsets: {}, feature: {} };
  }
}

function writeFeedState(root: string, state: FeedState): void {
  const dir = join(root, ".codument");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(feedStatePath(root), JSON.stringify(state, null, 2) + "\n");
}

/** Collapse path aliases (symlinks, `.`/`..`, case) to one canonical key so a
 *  session isn't pumped twice when it appears under two spellings. Falls back to
 *  lexical resolution when the file no longer exists. */
function canonSession(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Reads bytes [offset, size) of a file and returns the decoded text. */
function readFrom(file: string, offset: number, size: number): string {
  const len = size - offset;
  if (len <= 0) return "";
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, offset);
    return buf.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

export interface PumpResult {
  emitted: number;
  session: string | null;
}

interface ParsedSession {
  /** Normalized events for the lines consumed this pass. */
  events: Array<Omit<CodumentEvent, "ts"> & { ts: string }>;
  /** Byte offset after the consumed whole lines. */
  offset: number;
  /** Feature to carry forward for this session. */
  feature: string | null;
  /** Whether the offset advanced — i.e. there was work to persist. */
  advanced: boolean;
}

/**
 * Parse one session log from its recorded offset to end-of-file into normalized
 * events — pure with respect to the event log (it does NOT append or write
 * state; the caller decides what to do with the result). Only whole lines are
 * consumed (a half-written trailing line waits for the next pass). The registry
 * is read lazily, only once there is actual work, so idle polls stay cheap. When
 * `skipUuids` is given, records whose `uuid` is already captured are still
 * parsed (advancing the offset and the feature carry-forward) but not
 * re-emitted — the idempotency hook for backfill.
 */
function parseSession(
  root: string,
  session: string,
  state: FeedState,
  registry?: Registry,
  skipUuids?: Set<string>,
): ParsedSession {
  const carried = state.feature[session] ?? null;
  const idle = (offset: number): ParsedSession => ({
    events: [],
    offset,
    feature: carried,
    advanced: false,
  });

  let size: number;
  try {
    size = statSync(session).size;
  } catch {
    return idle(state.offsets[session] ?? 0); // session log vanished — nothing to parse
  }

  let offset = state.offsets[session] ?? 0;
  if (offset > size) offset = 0; // truncated/rotated — restart this file
  if (offset === size) return idle(offset);

  const chunk = readFrom(session, offset, size);
  const lastNL = chunk.lastIndexOf("\n");
  if (lastNL === -1) return idle(offset); // no complete line yet
  const complete = chunk.slice(0, lastNL + 1);
  const consumedBytes = Buffer.byteLength(complete, "utf-8");

  const reg = registry ?? readRegistrySync(join(root, "docs", ".registry.json"));
  let feature: string | null = carried;
  const events: ParsedSession["events"] = [];
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // skip malformed lines, keep advancing the offset
    }
    const result = recordToEvents(record, { root, registry: reg, prevFeature: feature });
    feature = result.feature;
    // Backfill skips turns already captured (keyed by the record's uuid), but
    // only after carrying the feature forward — so a later un-captured turn in
    // the same file still attributes correctly across the skipped one.
    if (skipUuids) {
      const uid = (record as Record<string, unknown>)?.uuid;
      if (typeof uid === "string" && skipUuids.has(uid)) continue;
    }
    events.push(...result.events);
  }

  return { events, offset: offset + consumedBytes, feature, advanced: true };
}

/**
 * Tail every session log for this repo once: parse transcript lines appended
 * since the last pump (per-file byte offsets), append normalized events to
 * .codument/events.jsonl, and persist offsets so restarts never double-emit.
 * Follows ALL transcripts whose `cwd` matches root — not just the newest — so
 * concurrent windows are fully counted and the live total never jumps between
 * them. Per-file offsets keep it idempotent and cheap: a file with no new bytes
 * is skipped before the registry is even read. Returns how many events were
 * appended and the newest matching session (for display continuity).
 */
export function pumpFeed(root: string, home = homedir()): PumpResult {
  const matching = resolveSessionLogs(root, home);
  if (matching.length === 0) return { emitted: 0, session: null };
  const active = newestOf(matching);

  const state = readFeedState(root);
  // Key feed-state by canonical path so an alias can't reset an offset and
  // re-emit (the same key `resetFeed` uses).
  const sessions = matching.map(canonSession);

  let registry: Registry | undefined;
  let emitted = 0;
  let advancedAny = false;
  for (const session of sessions) {
    const off = state.offsets[session] ?? 0;
    let size: number;
    try {
      size = statSync(session).size;
    } catch {
      continue; // transcript vanished — nothing to pump from it
    }
    if (size === off) continue; // no new bytes (idle) — skip before reading the registry

    registry ??= readRegistrySync(join(root, "docs", ".registry.json"));
    const parsed = parseSession(root, session, state, registry);
    for (const ev of parsed.events) appendEvent(root, ev);
    emitted += parsed.events.length;
    if (parsed.advanced) {
      advancedAny = true;
      state.offsets[session] = parsed.offset;
      if (parsed.feature) state.feature[session] = parsed.feature;
    }
  }
  if (advancedAny) writeFeedState(root, state);
  return { emitted, session: active };
}

/** Every turn `uuid` already recorded in the event log — the idempotency key for
 *  backfill. A turn stamps the same uuid on its token and activity events, so
 *  this is a per-*turn* key, not per-event; backfill skips a whole transcript
 *  record whose uuid is present rather than any single event. */
function knownFeedUuids(root: string): Set<string> {
  const seen = new Set<string>();
  for (const ev of readAllEvents(root)) {
    const id = (ev.data as Record<string, unknown> | undefined)?.uuid;
    if (typeof id === "string") seen.add(id);
  }
  return seen;
}

export interface BackfillResult {
  /** Matching transcripts discovered for the repo. */
  sessions: number;
  /** Of those, how many contributed at least one previously-uncaptured turn. */
  newSessions: number;
  /** Events appended by the backfill. */
  added: number;
  /** Newest matching session, for display. */
  session: string | null;
}

/**
 * Ingest EVERY matching transcript from offset 0, appending only turns not
 * already captured (keyed by turn `uuid`) — the retroactive complement to live
 * pumping: the agent keeps its transcripts whether or not `watch` ran, so a
 * never-watched or historical session can be picked up after the fact. Additive
 * and non-destructive — existing events (feed, manual emits, review notes) are
 * untouched, and re-running adds nothing (idempotent by uuid). Advances each
 * session's live cursor to end-of-file so the live pump won't re-emit what was
 * backfilled.
 */
export function backfillFeed(root: string, home = homedir()): BackfillResult {
  const matching = resolveSessionLogs(root, home);
  const active = newestOf(matching);
  if (matching.length === 0) return { sessions: 0, newSessions: 0, added: 0, session: null };

  // Single-writer assumption: like the live pump, this appends without a lock,
  // so two concurrent backfills on one root could double-emit a turn. That suits
  // the interactive one-shot this is built for; a collector would add locking.
  const known = knownFeedUuids(root);
  const realState = readFeedState(root);
  const registry = readRegistrySync(join(root, "docs", ".registry.json"));
  // A throwaway state so every session parses from offset 0 (the whole file);
  // the live cursor in realState is advanced separately, to EOF.
  const fromZero: FeedState = { offsets: {}, feature: {} };

  let added = 0;
  let newSessions = 0;
  for (const orig of matching) {
    const session = canonSession(orig);
    const parsed = parseSession(root, session, fromZero, registry, known);
    if (parsed.events.length > 0) {
      for (const ev of parsed.events) {
        appendEvent(root, ev);
        const id = (ev.data as Record<string, unknown> | undefined)?.uuid;
        if (typeof id === "string") known.add(id); // guard against repeats within this run too
      }
      added += parsed.events.length;
      newSessions++;
    }
    // Sync the live cursor to EOF so a subsequent pump won't re-emit these turns.
    if (parsed.advanced) {
      realState.offsets[session] = parsed.offset;
      if (parsed.feature) realState.feature[session] = parsed.feature;
    }
  }
  writeFeedState(root, realState);
  return { sessions: matching.length, newSessions, added, session: active };
}

/** True for an event feed produced — i.e. re-derivable from a transcript. The
 *  unconditional `source: "feed"` marker is authoritative; the legacy
 *  session/uuid stamp is also honored so logs written before the marker existed
 *  are still recognized. Manual `emit`s and `review`/`step` notes match none of
 *  these and are left untouched. */
function isFeedSourced(event: CodumentEvent): boolean {
  const data = event.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") return false;
  return (
    data.source === "feed" ||
    typeof data.session === "string" ||
    typeof data.uuid === "string"
  );
}

export interface ResetResult {
  /** Feed-sourced events superseded by a fresh rebuild. */
  removed: number;
  /** Non-feed events (manual emits, review notes) left in place. */
  kept: number;
  /** Feed events whose transcript is gone, kept verbatim (could not re-derive). */
  preserved: number;
  /** Events re-emitted by the fresh rebuild. */
  emitted: number;
  /** The active session resolved for the rebuild, if any. */
  session: string | null;
}

/**
 * Rebuild every feed-sourced event from the live transcript(s) using the
 * *current* normalization and attribution — the cure for stale events left by an
 * older `normalizeModelId` (e.g. before a new model id or a `[1m]` suffix was
 * handled, which show up `unpriced`). It re-pumps every session the cursor has
 * touched (not just the newest, so multi-session history isn't undercounted),
 * preserves manual `emit`s and `review` notes, and — crucially — keeps any feed
 * event whose transcript no longer exists verbatim rather than dropping it, so a
 * rebuild can never silently lose cost data it can't re-derive. The new log is
 * assembled in memory and written once (atomically): no backup, but also no
 * destroy-before-rebuild window.
 */
export function resetFeed(root: string, home = homedir()): ResetResult {
  const prior = readFeedState(root);
  const all = readAllEvents(root);
  const matching = resolveSessionLogs(root, home);
  const active = newestOf(matching);

  // Sessions to rebuild from: every matching transcript (not just the newest, so
  // a cold-start reset captures concurrent history too) plus any the cursor
  // touched. Canonicalized so a path alias can't double-pump the same file.
  const sessions = new Set<string>();
  for (const s of Object.keys(prior.offsets)) sessions.add(canonSession(s));
  for (const m of matching) sessions.add(canonSession(m));

  // Nothing to do on a fresh/never-fed project — don't create empty artifacts.
  if (all.length === 0 && sessions.size === 0) {
    return { removed: 0, kept: 0, preserved: 0, emitted: 0, session: active };
  }

  const kept = all.filter((e) => !isFeedSourced(e));
  const feedEvents = all.filter((e) => isFeedSourced(e));

  // Rebuild from each existing transcript, from offset 0, collecting in memory.
  // Record the sessionId of every transcript that still exists so we can tell a
  // genuinely-gone session apart from a turn the rebuild simply chose not to
  // re-emit (e.g. a zero-usage `<synthetic>` turn).
  const state: FeedState = { offsets: {}, feature: {} };
  const registry = readRegistrySync(join(root, "docs", ".registry.json"));
  const rebuilt: CodumentEvent[] = [];
  const presentSessionIds = new Set<string>();
  for (const session of sessions) {
    if (!existsSync(session)) continue; // transcript gone — its events are orphans
    const sid = sessionIdOf(session);
    if (sid) presentSessionIds.add(sid);
    const parsed = parseSession(root, session, state, registry);
    for (const ev of parsed.events) rebuilt.push(ev);
    if (parsed.advanced) {
      state.offsets[session] = parsed.offset;
      if (parsed.feature) state.feature[session] = parsed.feature;
    }
  }

  // A prior feed event is superseded when its source transcript still exists
  // (the from-scratch re-pump is the authoritative replacement for that whole
  // session, including any turns it deliberately skipped). It is preserved only
  // when its session's transcript is gone — never a silent loss, but also never
  // resurrecting turns the rebuild intentionally dropped.
  const orphaned = feedEvents.filter((e) => {
    const sid = (e.data as Record<string, unknown> | undefined)?.session;
    return !(typeof sid === "string" && presentSessionIds.has(sid));
  });

  // Assemble once, then write once. Events first (the precious data), then state.
  rewriteEvents(root, [...kept, ...orphaned, ...rebuilt]);
  writeFeedState(root, state);

  return {
    removed: feedEvents.length - orphaned.length,
    kept: kept.length,
    preserved: orphaned.length,
    emitted: rebuilt.length,
    session: active,
  };
}
