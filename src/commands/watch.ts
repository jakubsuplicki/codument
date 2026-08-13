import { statSync } from "node:fs";
import { basename, join } from "node:path";
import pc from "picocolors";
import { buildReview, type ReviewReport } from "./review.js";
import { buildReport, type DoctorReport } from "./doctor.js";
import { warmAdaptersForRepo } from "../lib/fingerprint.js";
import {
  assertRootIsRepoToplevel,
  forgetWorkspace,
  getWorkingTreeChanges,
  isGitRepo,
} from "../lib/git.js";
import { readRecentEvents, type CodumentEvent } from "../lib/events.js";
import { summarizeImpact } from "../lib/impact-ledger.js";
import { summarizeTokens } from "../lib/token-report.js";
import { loadRates, type RateTable } from "../lib/token-cost.js";
import { pumpFeed } from "../lib/claude-feed.js";
import { resolveScopeSync } from "../lib/analyze.js";
import { readRegistrySync } from "../lib/registry.js";
import { ConfigValueError, StateFileError } from "../lib/state-io.js";
import {
  classifyVerdict,
  costProvenance,
  formatCost,
  type CostModel,
  type Severity,
} from "../lib/verdict.js";

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
  /** Registry feature count — the blast-radius denominator. */
  totalFeatures?: number;
  /** ISO time the watch run started — enables the "this session" cost delta. */
  sinceTs?: string;
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

// Animation cadence by mood. Fast only while files are actively changing, so the
// mascot/typing stays fluid during real work; slow otherwise, so an idle watcher
// barely wakes the CPU. Paired with the frame-dedup in `watch`, idle ticks rarely
// even paint — so the slow cadence costs almost nothing while the tree is quiet.
export const ANIM_FAST_MS = 150;
export const ANIM_IDLE_MS = 600;

/** Animation tick delay (ms) for the current mood. Pure, so the cadence policy is
 *  testable without driving the live loop. */
export function animDelayFor(mood: Mood): number {
  return mood === "working" ? ANIM_FAST_MS : ANIM_IDLE_MS;
}

/** State-only mood (no clock): the fallback when the live loop doesn't pass one. */
function deriveMood(review: ReviewReport): Mood {
  if (!review.isGitRepo) return "idle";
  const s = review.state;
  if (s.staleDocs.length > 0 || s.riskTouches.length > 0) return "alert";
  if (review.changedFileCount === 0) return "clean";
  return "idle";
}

/** Friendly local wall-clock for the live header — `09:11`, not a raw ISO Z
 *  string. Minutes only, no seconds: since the loop repaints only when the frame
 *  changes, a seconds digit wouldn't tick smoothly (it would jump whenever some
 *  other change forced a repaint), reading as laggy rather than live. Dropping it
 *  also lets an idle tree's header change just once a minute. Only the live loop
 *  uses it; renderFrame still displays whatever `now` string it is handed, so
 *  injected test timestamps round-trip unchanged. */
export function clockLabel(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
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

// Verdict glyph + status word + colour. The glyph carries the meaning so the
// verdict survives a screenshot / colourblindness; colour only reinforces.
const VERDICT_STYLE: Record<Severity, { symbol: string; word: string; paint: (s: string) => string }> = {
  clean: { symbol: "✓", word: "CLEAN", paint: pc.green },
  drifting: { symbol: "▲", word: "DRIFTING", paint: pc.yellow },
  "off-plan": { symbol: "⊘", word: "OFF-PLAN", paint: pc.yellow },
  "at-risk": { symbol: "■", word: "AT RISK", paint: pc.red },
};

function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A bar filled proportional to the largest value (relative rank, not absolute share). */
function bar(value: number, max: number, width = 18): string {
  const filled = max > 0 ? Math.round((value / max) * width) : 0;
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

/** Pad to width, or truncate with an ellipsis when a name overflows — keeps the
 *  cost / findings columns aligned for long feature names. */
function fit(name: string, width: number): string {
  return name.length > width ? name.slice(0, width - 1) + "…" : name.padEnd(width);
}

/** Distinct feed sessions + the **calendar span** they cover — first→last
 *  timestamped session event, i.e. wall-clock elapsed, not summed session time.
 *  Reads as "31 sessions over 30 days" and can never exceed real elapsed time
 *  (summing per-session spans would double-count overlap and inflate idle).
 *  Timestamps are parsed to numbers before min/max so a stray non-ISO `ts` can't
 *  win a lexicographic comparison and skew the span. */
export function sessionStats(events: CodumentEvent[]): { sessions: number; hours: number } {
  const sessions = new Set<string>();
  let min = Infinity;
  let max = -Infinity;
  for (const e of events) {
    const sid = (e.data as Record<string, unknown> | undefined)?.session;
    if (typeof sid !== "string") continue;
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t)) continue; // unparseable ts — skip, don't let it skew the span
    sessions.add(sid);
    if (t < min) min = t;
    if (t > max) max = t;
  }
  const hours = max > min ? (max - min) / 3_600_000 : 0;
  return { sessions: sessions.size, hours };
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
  const verdict = classifyVerdict(s, {
    totalFeatures: opts.totalFeatures ?? 0,
    inScopeSourceCount: coverage.inScopeSourceCount,
  });
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

  // ── Verdict headline — the plain-words state, glyph-led. ────────────────
  const vs = VERDICT_STYLE[verdict.status];
  lines.push(`  ${vs.paint(`${vs.symbol} ${vs.word}`)}   ${verdict.gloss}`);
  lines.push("");

  // ── Cost headline — the all-sessions total (not session-scoped), with its
  // provenance and the live delta. codument can't meter tokens; these are counts
  // the agent reported into the events log, priced from a static table — an
  // estimate, never a bill. New (input+output+cacheCreate, the real work) is split
  // from cache-read (context re-read each turn), which dwarfs everything. Hidden
  // until a token event exists.
  const tokens = summarizeTokens(events, opts.rates);
  const hasCost = tokens.totals.eventCount > 0;
  if (hasCost) {
    const total = tokens.totals.cost?.total ?? 0;
    const stats = sessionStats(events);
    // Live delta — cost of turns logged since the watch run started. Compared by
    // parsed time so a stray non-ISO ts can't slip past a string comparison.
    let deltaCost = 0;
    if (opts.sinceTs) {
      const sinceMs = new Date(opts.sinceTs).getTime();
      const recent = events.filter((e) => {
        const t = new Date(e.ts).getTime();
        return Number.isFinite(t) && t >= sinceMs;
      });
      deltaCost = summarizeTokens(recent, opts.rates).totals.cost?.total ?? 0;
    }
    const cost: CostModel = {
      total,
      sessions: stats.sessions,
      hours: stats.hours > 0 ? stats.hours : null,
      thisSession: deltaCost,
      byFeature: [],
      complete: true,
      capturedSessions: stats.sessions,
      knownSessions: stats.sessions,
    };
    const delta = deltaCost > 0 ? `   ${pc.dim(`+${formatCost(deltaCost)} this session`)}` : "";
    lines.push(
      `  ${pc.bold("cost")}  ${pc.bold(formatCost(total))}  ${pc.dim(`·  ${costProvenance(cost)} · est.`)}${delta}`,
    );
    const u = tokens.totals.usage;
    const fresh = u.input + u.output + u.cacheCreate;
    lines.push(pc.dim(`        ${compactTokens(fresh)} new · ${compactTokens(u.cacheRead)} cache-read`));
    lines.push("");
  }

  // ── Now (active plan step), touched scope + blast radius. ───────────────
  const lastStep = scoped
    .filter((e) => e.type === "step")
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))[0];
  if (lastStep?.message) lines.push(`  ${pc.dim("now")}      ${lastStep.message}`);
  const touched = [plural(verdict.blast.touched, "feature"), plural(review.changedFileCount, "file")];
  if (verdict.unmapped > 0) touched.push(`${verdict.unmapped} unmapped`);
  // At ≤1 feature the feature ratio is a single bit ("1 of 1"); fall back to the
  // file-grain numerator so even an undecomposed repo shows real resolution.
  const oneFeature = verdict.blast.total <= 1;
  const blast =
    oneFeature && verdict.blast.totalFiles > 0
      ? `   ${pc.dim(`blast radius ${verdict.blast.touchedFiles} of ${verdict.blast.totalFiles} files`)}`
      : verdict.blast.total > 0
        ? `   ${pc.dim(`blast radius ${verdict.blast.touched} of ${verdict.blast.total}`)}`
        : "";
  lines.push(`  ${pc.dim("touched")}  ${touched.join(" · ")}${blast}`);

  // Decomposition shape nudge (info-only) — surfaced here because a 1-feature
  // repo is exactly where "this resolves to one feature" is the useful signal.
  const shape = coverage.lint?.notes?.find((f) => f.id === "under-decomposed" || f.id === "over-decomposed");
  if (shape) lines.push(`  ${pc.yellow("▲ shape")}    ${pc.dim(shape.message)}`);

  // ── Named findings — only rows that are actually present. ───────────────
  for (const r of verdict.risk) {
    const detail =
      r.kind === "risk-tag"
        ? `${r.tags.join(", ")} · ${plural(r.files, "file")}${r.noTest ? " · no test yet" : ""}`
        : `shared infra · ${plural(r.features, "feature")}${r.noTest ? " · no test yet" : ""}`;
    lines.push(`  ${pc.red("■ risk")}     ${fit(r.subject, 20)} ${pc.dim(detail)}`);
  }
  for (const d of verdict.drift) {
    const age = "doc not updated";
    // At ≤1 feature, name the changed files (per-file drift) so the row resolves
    // below the single feature; the data is already on the change-state.
    const files = oneFeature
      ? (s.staleDocs.find((sd) => sd.feature === d.feature)?.changedSources ?? [])
      : [];
    const fileNote = files.length
      ? ` ${pc.dim(`(${files.slice(0, 3).map((f) => basename(f)).join(", ")}${files.length > 3 ? ` +${files.length - 3}` : ""})`)}`
      : "";
    lines.push(`  ${pc.yellow("▲ drift")}    ${fit(d.feature, 20)} ${pc.dim(`code changed, ${age}`)}${fileNote}`);
  }
  if (verdict.offPlan) {
    const names = verdict.offPlan.files.map((f) => basename(f)).slice(0, 3).join(", ");
    const extra = verdict.offPlan.files.length > 3 ? ` +${verdict.offPlan.files.length - 3}` : "";
    lines.push(`  ${pc.yellow("⊘ off-plan")} ${pc.dim(`${names}${extra}  (not in any step)`)}`);
  }
  lines.push("");

  // ── Where it went — top features by spend, with a relative bar + share. ──
  if (hasCost) {
    const total = tokens.totals.cost?.total ?? 0;
    const byFeat = Object.entries(tokens.byFeature)
      .map(([feature, r]) => ({ feature, cost: r.cost?.total ?? 0 }))
      .filter((f) => f.cost > 0)
      .sort((a, b) => b.cost - a.cost);
    const top = byFeat.slice(0, 3);
    const maxCost = top.length > 0 ? top[0].cost : 0;
    if (top.length > 0) lines.push(pc.dim("  where it went"));
    for (const f of top) {
      const pct = total > 0 ? Math.round((f.cost / total) * 100) : 0;
      lines.push(
        `    ${fit(f.feature, 18)} ${formatCost(f.cost).padStart(10)}  ${pc.cyan(bar(f.cost, maxCost))}  ${String(pct).padStart(2)}%`,
      );
    }
    if (byFeat.length > 3) lines.push(pc.dim(`    + ${byFeat.length - 3} more`));
    if (tokens.unpriced.length > 0) {
      lines.push(pc.yellow(`  unpriced models: ${tokens.unpriced.join(", ")}`));
    }
    lines.push("");
  }

  // ── Caught (all sessions) — what the loop has caught over the project's life,
  // cumulative from the whole log (like cost, not session-scoped). Provable
  // catches (codument's own analyzer, ungameable) lead; agent-self-reported
  // review-fixes are a separate, labeled line. Never blended into one number.
  // Hidden until there is something to show.
  const impact = summarizeImpact(events);
  if (impact.hasProvable || impact.hasReported || impact.hasDrift) {
    lines.push(pc.dim("  caught (all sessions)"));
    if (impact.hasProvable) {
      const p = impact.provable;
      const parts: string[] = [];
      if (p.staleDocs > 0) parts.push(`${plural(p.staleDocs, "stale doc")} flagged`);
      if (p.riskTouches > 0) parts.push(plural(p.riskTouches, "high-risk touch", "high-risk touches"));
      if (p.offPlan > 0) parts.push(plural(p.offPlan, "off-plan change"));
      lines.push(`    ${pc.cyan("provable")}  ${parts.join(" · ")}`);
    }
    if (impact.hasReported) {
      const r = impact.reported;
      let main = `${plural(r.headline, "review issue")} fixed before commit`;
      if (r.fixed.minor > 0) main += pc.dim(` · +${r.fixed.minor} minor`);
      lines.push(
        `    ${pc.cyan("reported")}  ${main}   ${pc.dim("(agent self-reported · correctness)")}`,
      );
    }
    if (impact.hasDrift) {
      const d = impact.drift;
      const pct = Math.round(d.frictionRate * 100);
      const fileAcked = d.fileAcked > 0 ? ` · ${d.fileAcked} file-acked` : "";
      // Split the fire volume into contract (signature) vs body-only churn — the
      // calibration signal the gate-flip decision reads (contract moves are
      // unavoidable high-signal work; body churn is what the ack path absorbs).
      const split =
        d.sigMoved + d.bodyMoved > 0 ? ` (${d.sigMoved} contract · ${d.bodyMoved} body)` : "";
      lines.push(
        `    ${pc.cyan("soak")}      ${d.flagged} symbol move(s)${split} · ${d.docUpdated} resolved by doc update · ${d.acknowledged} acked${fileAcked}   ${pc.dim(`(friction ${pct}% · info-only)`)}`,
      );
    }
    lines.push("");
  }

  // ── Footer — coverage (the badge/contract keeps the "docs coverage:" text,
  // distinct from blast radius above) + an honest disclaimer. ──────────────
  const footer = [`docs coverage: ${pc.bold(cov)}`];
  if (review.plan) footer.push(pc.dim(`plan: ${review.plan.plan}`));
  footer.push(pc.dim("Ctrl-C to stop · facts, not a safety guarantee"));
  lines.push("  " + footer.join(pc.dim("   ")));
  return lines.join("\n");
}

/** Touched-file activity (by mtime) + a live mood. Reads the clock + fs, so it
 *  lives here, never in the pure renderer. */
function gatherActivity(
  root: string,
  review: ReviewReport,
  changedFiles: string[],
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
  for (const file of changedFiles) {
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
  totalFeatures: number;
}

// Read effectively the whole event log each tick: the token cost must sum every
// turn of the current session (a long session has thousands), not a recent tail —
// undercounting cost is worse than the cheap re-parse of a local file. The tape
// still shows only the newest few; session-scoping filters the rest.
const EVENT_WINDOW = 1_000_000;

function gatherFrameData(root: string): FrameData {
  // The workspace shape is memoized per root, but watch outlives one answer: a
  // member repo can be cloned or `git init`'d into the tree mid-session, and a
  // frozen member set would leave its edits invisible for the rest of the run.
  // Re-resolve each tick — the walk is pruned by the exclusion dirs and is
  // strictly cheaper than the `git status` tree scan this tick already runs.
  forgetWorkspace(root);
  // Compute the working-tree changes once and share them with both the review
  // analyzer and the activity tape, so a refresh spawns one `git status` tree
  // scan instead of two.
  const changedFiles = getWorkingTreeChanges(root);
  // One scope read per tick, shared by both surfaces this frame renders.
  const scope = resolveScopeSync(root);
  const review = buildReview(root, changedFiles, "HEAD", undefined, {
    exclusion: scope.spec,
  });
  const coverage = buildReport(root, { scope });
  const events = readRecentEvents(root, EVENT_WINDOW);
  const { activity, mood } = gatherActivity(root, review, changedFiles);
  const rates = loadRates(root);
  const registry = readRegistrySync(join(root, "docs", ".registry.json"));
  const totalFeatures = Object.keys(registry.features).length;
  return { review, coverage, events, activity, mood, rates, totalFeatures };
}

/** Builds one frame's data from the repo and renders it. Exported for the live demo. */
export function buildFrame(root: string, now: string, tick = 0): string {
  const d = gatherFrameData(root);
  return renderFrame(d.review, d.coverage, d.events, now, {
    tick,
    activity: d.activity,
    mood: d.mood,
    rates: d.rates,
    totalFeatures: d.totalFeatures,
  });
}

export async function watch(options: WatchOptions = {}): Promise<void> {
  const root = options.root ?? options.dir ?? process.cwd();
  // A subdirectory root renders a WRONG frame (everything unmapped, docs fresh),
  // including under --once — fail loud (the cli boundary renders the GateError)
  // before the feed pump writes into the wrong .codument directory.
  assertRootIsRepoToplevel(root);
  // Auto-tail the agent's session log into events.jsonl so a single `watch`
  // shows live token cost + reads/edits. Harmless no-op when no session matches.
  const feedOn = options.feed !== false;
  // The watch run's start — turns logged after this drive the "this session" delta.
  const startedAt = new Date().toISOString();

  // The frame builder is synchronous; adapters that parse through a WASM
  // grammar load here (and again per data tick, so a language appearing
  // mid-session warms instead of silently freezing the frame).
  await warmAdaptersForRepo(root);

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

  // Two cadences: an animation tick advances the mascot/typing from cached data,
  // a slow data tick re-runs the change-state analyzer. Keeps motion smooth
  // without paying for a git+registry recompute every frame. The animation tick
  // is mood-adaptive (fast only while working) so an idle watcher barely wakes.
  const dataMs = Math.max(500, Number(options.interval) || 2000);

  if (feedOn) pumpFeed(root);
  let cache = gatherFrameData(root);
  let tick = 0;
  // Non-null while a permanent failure is keeping `cache` from refreshing, so
  // the frame on screen can say it is no longer live instead of just aging.
  let staleReason: string | null = null;

  // Repaint only when the rendered bytes actually change. The animation tick fires
  // many times a second, but on an idle tree most frames are byte-identical (the
  // mascot and clock advance at most ~once/sec) — writing those is the dominant
  // idle battery cost, both the stdout churn and the terminal's full-screen redraw.
  let lastFrame: string | null = null;
  const paint = () => {
    const frame = renderFrame(
      cache.review,
      cache.coverage,
      cache.events,
      clockLabel(new Date()),
      {
        tick,
        activity: cache.activity,
        mood: cache.mood,
        rates: cache.rates,
        totalFeatures: cache.totalFeatures,
        sinceTs: startedAt,
      },
    );
    // A frame that stopped refreshing must not look like a frame that is simply
    // calm. Appended rather than folded into renderFrame so the rendered bytes
    // still change when the reason appears or clears.
    const shown =
      staleReason === null
        ? frame
        : `${frame}\n  ${pc.red("✗")} monitor is showing a stale frame: ${staleReason}`;
    if (shown === lastFrame) return;
    lastFrame = shown;
    process.stdout.write(CLEAR + shown + "\n");
  };
  paint();

  // Self-rescheduling so each tick's delay tracks the latest mood: a working tree
  // animates fast, an idle/clean/alert one ticks slowly. setInterval can't do this
  // without rebuilding the timer, so reschedule from inside the callback.
  let animTimer: ReturnType<typeof setTimeout>;
  const scheduleAnim = () => {
    animTimer = setTimeout(() => {
      tick = (tick + 1) % 100000;
      paint();
      scheduleAnim();
    }, animDelayFor(cache.mood));
  };
  scheduleAnim();
  const dataTimer = setInterval(() => {
    if (feedOn) pumpFeed(root); // tail new session-log turns before recomputing
    void (async () => {
      try {
        // Re-check per tick: the first .py appearing mid-session must warm,
        // not throw into the catch below forever.
        await warmAdaptersForRepo(root);
        cache = gatherFrameData(root);
        staleReason = null;
      } catch (err) {
        // A transient git failure mid-session must not crash the monitor: keep
        // rendering the last good frame until a later tick recovers.
        //
        // A config the user just broke is NOT transient — it never self-heals,
        // so swallowing it would freeze the monitor on a stale frame with no
        // explanation. Name it instead, and keep rendering: the frame the user
        // is looking at is no longer live, and only the monitor can say so.
        staleReason =
          err instanceof ConfigValueError || err instanceof StateFileError
            ? err.message
            : null;
      }
    })();
  }, dataMs);

  const stop = () => {
    clearTimeout(animTimer);
    clearInterval(dataTimer);
    process.stdout.write("\n");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
