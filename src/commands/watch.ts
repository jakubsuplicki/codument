import { statSync } from "node:fs";
import { basename, join } from "node:path";
import pc from "picocolors";
import { buildReview, type ReviewReport } from "./review.js";
import { buildReport, type DoctorReport } from "./doctor.js";
import { isGitRepo, getWorkingTreeChanges } from "../lib/git.js";
import { readRecentEvents, type CodumentEvent } from "../lib/events.js";
import { summarizeTokens } from "../lib/token-report.js";
import { loadRates, type RateTable } from "../lib/token-cost.js";
import { pumpFeed } from "../lib/claude-feed.js";

interface WatchOptions {
  root?: string;
  dir?: string;
  once?: boolean;
  interval?: string | number;
  /** Auto-tail the active Claude session log into events.jsonl (default on). */
  feed?: boolean;
}

/** ANSI clear-screen + home — exported so the live demo can redraw in place. */
export const CLEAR = "\x1b[2J\x1b[H";

// Zero-dependency live terminal view. Same architecture the plan called for —
// a foreground loop over the shared computeChangeState analyzer (so watch and
// review can never disagree) plus the .codument/events.jsonl tail — rendered
// with ANSI rather than Ink to keep codument's minimal-dependency stance.
//
// The frame leads with *activity* (what the agent is touching, newest first)
// rather than a stack of static counts, fronted by a small Shiba mascot whose
// mood reflects state: paws typing while files are actively changing, dozing
// when idle, wide-eyed on a stale/risk finding, shades-on when the tree is
// clean. The mascot animates off a fast render tick (see `watch`), decoupled
// from the slower change-state recompute so motion stays smooth and cheap.

type Mood = "working" | "alert" | "clean" | "idle";

/** A single line of the activity tape — a touched file or a logged event. */
export interface ActivityItem {
  ts: string; // ISO timestamp, sorted descending for display
  kind: string; // "edit" | "review" | "step" | "note" | …
  label: string;
}

interface RenderOpts {
  /** Animation frame counter; advanced by the fast render tick. */
  tick?: number;
  /** Touched-file activity derived from mtimes (events are merged in here). */
  activity?: ActivityItem[];
  /** Overrides the state-derived mood (e.g. "working" on a fresh edit). */
  mood?: Mood;
  /** Resolved model→rate table (defaults + .codument/rates.json); built-ins if omitted. */
  rates?: RateTable;
}

// Text kaomoji, never emoji: a real 🐶 renders at inconsistent widths and would
// break alignment terminal-to-terminal. Snout = ᴥ; paws alternate to "type".
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function mascotFor(mood: Mood, tick: number): { face: string; word: string } {
  switch (mood) {
    case "working":
      return { face: tick % 2 === 0 ? "ʕっ•ᴥ•ʔっ" : "ʕノ•ᴥ•ʔノ", word: "working" };
    case "alert":
      return { face: "ʕ •̀ᴥ•́ʔ", word: "look here" };
    case "clean":
      return { face: "ʕ⌐■ᴥ■ʔ", word: "all clean" };
    case "idle":
    default:
      return { face: tick % 8 === 0 ? "ʕ -ᴥ- ʔ" : "ʕ ˘ᴥ˘ ʔ", word: "idle" };
  }
}

/** "", ".", "..", "…"-style typing trail that pulses on the active line. */
function typingDots(tick: number): string {
  return ".".repeat(tick % 4);
}

/** State-only mood (no clock): the fallback when the live loop doesn't pass one. */
function deriveMood(review: ReviewReport): Mood {
  if (!review.isGitRepo) return "idle";
  const s = review.state;
  if (s.staleDocs.length > 0 || s.riskTouches.length > 0) return "alert";
  if (review.changedFileCount === 0) return "clean";
  return "idle";
}

/** Friendly local wall-clock for the live header — `09:11:29`, not a raw ISO Z
 *  string. Only the live loop uses it; renderFrame still displays whatever `now`
 *  string it is handed, so injected test timestamps round-trip unchanged. */
export function clockLabel(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function shortTime(ts: string): string {
  // Render local HH:MM so tape rows match the local header clock (not UTC Z).
  const d = new Date(ts);
  if (!Number.isNaN(d.getTime())) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const alt = /(\d{2}:\d{2})/.exec(ts); // fallback for non-date strings
  return alt ? alt[1] : ts;
}

/** Merge logged events (token events excluded — they live in the cost block) with
 *  mtime-derived edits, newest first, deduped so the same file isn't shown twice
 *  (a feed `edit` event and its mtime echo collapse), capped for a glanceable
 *  tape. Pure. */
function buildTape(events: CodumentEvent[], extra: ActivityItem[]): ActivityItem[] {
  const fromEvents: ActivityItem[] = events
    .filter((e) => e.type !== "tokens")
    .map((e) => ({ ts: e.ts, kind: e.type, label: e.message ?? "" }));
  const all = [...fromEvents, ...extra];
  all.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const seen = new Set<string>();
  const deduped: ActivityItem[] = [];
  for (const item of all) {
    const key = `${item.kind}:${item.label}`;
    if (seen.has(key)) continue; // keep the newest occurrence only
    seen.add(key);
    deduped.push(item);
  }
  return deduped.slice(0, 6);
}

function warnCount(n: number, label: string): string {
  const text = `${n} ${label}`;
  return n > 0 ? pc.yellow(text) : pc.dim(text);
}

/** The session id of the newest event that carries one, else undefined. Used to
 *  scope the frame to the current run so a cumulative events.jsonl doesn't show
 *  "all sessions ever" cost. */
function currentSessionOf(events: CodumentEvent[]): string | undefined {
  let best: string | undefined;
  let bestTs = "";
  for (const e of events) {
    const sess = (e.data as Record<string, unknown> | undefined)?.session;
    if (typeof sess === "string" && e.ts >= bestTs) {
      bestTs = e.ts;
      best = sess;
    }
  }
  return best;
}

/** Compact token magnitude — 186.6M, 35.0K, 942 — so cache-read sums stay glanceable. */
function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

/** Pure frame renderer. `now` and `opts` are injected so output is testable. */
export function renderFrame(
  review: ReviewReport,
  coverage: DoctorReport,
  events: CodumentEvent[],
  now: string,
  opts: RenderOpts = {},
): string {
  const tick = opts.tick ?? 0;
  const lines: string[] = [];

  const cov =
    coverage.coverage.percent === null ? "N/A" : `${coverage.coverage.percent}%`;

  if (!review.isGitRepo) {
    lines.push(pc.bold("codument watch") + pc.dim(`  ·  ${now}`));
    lines.push("");
    lines.push(
      `docs coverage: ${pc.bold(cov)}   ${pc.yellow("(not a git repo — change view disabled)")}`,
    );
    lines.push("");
    return lines.join("\n");
  }

  const s = review.state;
  const mood = opts.mood ?? deriveMood(review);
  const { face, word } = mascotFor(mood, tick);
  const spin = mood === "working" ? pc.cyan(SPINNER[tick % SPINNER.length]) + " " : "";

  // Scope to the current session so a cumulative log doesn't conflate runs.
  // Untagged events (other producers, generic notes) are always kept.
  const session = currentSessionOf(events);
  const scoped = session
    ? events.filter((e) => {
        const se = (e.data as Record<string, unknown> | undefined)?.session;
        return se === undefined || se === session;
      })
    : events;

  // Mascot + title, then a glanceable activity tape (what is being touched).
  lines.push(
    `${face}  ${pc.bold("codument watch")}${pc.dim(`  ·  ${now}`)}   ${spin}${pc.dim(word)}`,
  );
  lines.push("");

  const tape = buildTape(scoped, opts.activity ?? []);
  if (tape.length === 0) {
    lines.push(pc.dim("  no activity yet — edits and events stream here as the agent works"));
  } else {
    tape.forEach((item, i) => {
      const active = i === 0 && mood === "working";
      const trail = active ? " " + pc.cyan(typingDots(tick)) : "";
      lines.push(
        `  ${pc.dim(shortTime(item.ts))}  ${pc.cyan(item.kind.padEnd(6))} ${item.label}${trail}`,
      );
    });
  }
  lines.push("");

  // One compact change-state strip — the same facts as before, no longer a
  // vertical stack. `docs coverage:` text is retained for the badge/contract.
  const strip = [
    `docs coverage: ${pc.bold(cov)}`,
    `${review.changedFileCount} changed (${s.changedSources.length} src)`,
    warnCount(s.staleDocs.length, "stale"),
    warnCount(s.riskTouches.length, "risk"),
    `${s.dependents.length} dep`,
  ];
  if (s.unmapped.length > 0) strip.push(warnCount(s.unmapped.length, "unmapped"));
  if (review.plan) {
    strip.push(warnCount(s.outOfPlan.length, "out-of-plan"));
    strip.push(pc.dim(`plan: ${review.plan.plan}`));
  }
  lines.push("  " + strip.join(pc.dim(" · ")));
  lines.push("");

  // Estimated token cost, attributed per feature. codument can't meter tokens
  // itself — these are counts the agent reported into the events log, priced from
  // a static rate table, so the figure is an estimate, never a bill. Cost leads;
  // tokens are split into "new" (input+output+cacheCreate — actual work) vs
  // "cache-read" (the accumulated context re-read every turn), because in agentic
  // sessions cache-read dwarfs everything and a single summed total reads as
  // absurd. Hidden until a token event exists.
  const tokens = summarizeTokens(scoped, opts.rates);
  if (tokens.totals.eventCount > 0) {
    const u = tokens.totals.usage;
    const fresh = u.input + u.output + u.cacheCreate;
    const dollars = (n: number) => `$${n.toFixed(2)}`;
    lines.push(
      pc.bold("  token cost") + pc.dim(`  (estimated${session ? " · this session" : ""})`),
    );
    lines.push(
      `  ${pc.bold(dollars(tokens.totals.cost?.total ?? 0))}   ${pc.dim(
        `${compactTokens(fresh)} new · ${compactTokens(u.cacheRead)} cache-read`,
      )}`,
    );
    const topFeatures = Object.entries(tokens.byFeature)
      .sort((a, b) => (b[1].cost?.total ?? 0) - (a[1].cost?.total ?? 0))
      .slice(0, 3);
    for (const [feature, rollup] of topFeatures) {
      lines.push(`    ${feature.padEnd(16)} ${dollars(rollup.cost?.total ?? 0)}`);
    }
    if (tokens.unpriced.length > 0) {
      lines.push(pc.yellow(`  unpriced models: ${tokens.unpriced.join(", ")}`));
    }
    lines.push("");
  }

  lines.push(
    pc.dim("  Ctrl-C to stop · refreshes on an interval · facts, not a safety guarantee"),
  );
  return lines.join("\n");
}

/** Touched-file activity (by mtime) + a live mood. Reads the clock + fs, so it
 *  lives here, never in the pure renderer. */
function gatherActivity(
  root: string,
  review: ReviewReport,
): { activity: ActivityItem[]; mood: Mood } {
  if (!review.isGitRepo) return { activity: [], mood: "idle" };

  // Label every changed file by its owning feature when known, else mark docs,
  // else just the basename — so the tape reflects ALL working-tree activity
  // (docs, config, anything), not only in-scope source files.
  const featureOf = new Map<string, string>();
  for (const group of review.state.byFeature) {
    for (const file of group.files) featureOf.set(file, group.feature);
  }

  const items: ActivityItem[] = [];
  let newestMs = 0;
  for (const file of getWorkingTreeChanges(root)) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(join(root, file)).mtimeMs;
    } catch {
      continue; // deleted/unreadable — the change-state counts still reflect it
    }
    newestMs = Math.max(newestMs, mtimeMs);
    const feature = featureOf.get(file);
    const label = feature
      ? `${feature} → ${basename(file)}`
      : file.startsWith("docs/") && file.endsWith(".md")
        ? `docs → ${basename(file)}`
        : basename(file);
    items.push({ ts: new Date(mtimeMs).toISOString(), kind: "edit", label });
  }

  // "working" while files are changing under us; otherwise fall back to state.
  let mood = deriveMood(review);
  if (newestMs > 0 && Date.now() - newestMs < 6000) mood = "working";
  return { activity: items, mood };
}

interface FrameData {
  review: ReviewReport;
  coverage: DoctorReport;
  events: CodumentEvent[];
  activity: ActivityItem[];
  mood: Mood;
  rates: RateTable;
}

// Read effectively the whole event log each tick: the token cost must sum every
// turn of the current session (a long session has thousands), not a recent tail —
// undercounting cost is worse than the cheap re-parse of a local file. The tape
// still shows only the newest few; session-scoping filters the rest.
const EVENT_WINDOW = 1_000_000;

function gatherFrameData(root: string): FrameData {
  const review = buildReview(root);
  const coverage = buildReport(root);
  const events = readRecentEvents(root, EVENT_WINDOW);
  const { activity, mood } = gatherActivity(root, review);
  const rates = loadRates(root);
  return { review, coverage, events, activity, mood, rates };
}

/** Builds one frame's data from the repo and renders it. Exported for the live demo. */
export function buildFrame(root: string, now: string, tick = 0): string {
  const d = gatherFrameData(root);
  return renderFrame(d.review, d.coverage, d.events, now, {
    tick,
    activity: d.activity,
    mood: d.mood,
    rates: d.rates,
  });
}

export async function watch(options: WatchOptions = {}): Promise<void> {
  const root = options.root ?? options.dir ?? process.cwd();
  // Auto-tail the agent's session log into events.jsonl so a single `watch`
  // shows live token cost + reads/edits. Harmless no-op when no session matches.
  const feedOn = options.feed !== false;

  if (options.once) {
    // Single frame, no screen clear — for CI/tests and one-shot inspection.
    if (feedOn) pumpFeed(root);
    console.log(buildFrame(root, clockLabel(new Date())));
    return;
  }

  if (!isGitRepo(root)) {
    console.log(pc.yellow("codument watch: not a git repository."));
    return;
  }

  // Two cadences: a fast tick animates the mascot/typing from cached data, a
  // slow tick re-runs the change-state analyzer. Keeps motion smooth without
  // paying for a git+registry recompute every frame.
  const dataMs = Math.max(500, Number(options.interval) || 2000);
  const animMs = 120;

  if (feedOn) pumpFeed(root);
  let cache = gatherFrameData(root);
  let tick = 0;

  const paint = () => {
    const frame = renderFrame(
      cache.review,
      cache.coverage,
      cache.events,
      clockLabel(new Date()),
      { tick, activity: cache.activity, mood: cache.mood, rates: cache.rates },
    );
    process.stdout.write(CLEAR + frame + "\n");
  };
  paint();

  const animTimer = setInterval(() => {
    tick = (tick + 1) % 100000;
    paint();
  }, animMs);
  const dataTimer = setInterval(() => {
    if (feedOn) pumpFeed(root); // tail new session-log turns before recomputing
    cache = gatherFrameData(root);
  }, dataMs);

  const stop = () => {
    clearInterval(animTimer);
    clearInterval(dataTimer);
    process.stdout.write("\n");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
