import { basename } from "node:path";
import pc from "picocolors";
import { readAllEvents } from "../lib/events.js";
import { loadRates } from "../lib/token-cost.js";
import { summarizeTokens, type TokenRollup, type TokenSummary } from "../lib/token-report.js";
import { formatCost } from "../lib/verdict.js";

// `codument cost` — the full cost ledger. Where `watch` shows a glanceable
// top-3 of "where it went", this prints every attributed feature, model, and
// step from the captured .codument/events.jsonl, derived at read time from the
// rate table (an estimate, never a bill). Pure read: it does not tail or mutate
// the log — run `codument feed`/`watch` to refresh capture first.

interface CostOptions {
  root?: string;
  dir?: string;
  json?: boolean;
}

function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A compact magnitude for token counts: 1.2K, 143.6M, 4.7B. */
function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

/** Priced total of a rollup; an unpriced group (unknown model) contributes 0. */
function costTotal(r: TokenRollup): number {
  return r.cost ? r.cost.total : 0;
}

/**
 * Largest-remainder rounding: whole-number percents that sum to exactly 100
 * (when the total is positive). Each value gets `floor(share)`, then the leftover
 * points go to the largest fractional remainders — so the rounded column actually
 * tallies to 100 instead of drifting a few points off. Index-aligned with input.
 */
export function sharePercents(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  // Guard the preconditions: a non-positive total (empty/all-zero) and any
  // negative value (costs are never negative, but this stays robust as a reusable
  // utility) both yield all-zero rather than a corrupt distribution.
  if (total <= 0 || values.some((v) => v < 0)) return values.map(() => 0);
  const exact = values.map((v) => (v / total) * 100);
  const out = exact.map((e) => Math.floor(e));
  // Clamp ≥ 0: floors can only undershoot 100, but guard against any FP drift that
  // would make the leftover negative and silently skew the column past 100.
  let leftover = Math.max(0, Math.round(100 - out.reduce((a, b) => a + b, 0)));
  const byRemainder = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < byRemainder.length && leftover > 0; k++, leftover--) {
    out[byRemainder[k].i] += 1;
  }
  return out;
}

/** One grouped ledger (by feature / model / step), sorted by cost descending. */
function renderGroup(
  title: string,
  groups: Record<string, TokenRollup>,
  grandTotal: number,
): string[] {
  const rows = Object.entries(groups)
    .map(([name, r]) => ({ name, total: costTotal(r), priced: r.cost !== null, pct: 0 }))
    .sort((a, b) => b.total - a.total || (a.name < b.name ? -1 : 1));
  if (rows.length === 0) return [];

  // Largest-remainder percents over the priced rows, so the % column sums to 100
  // instead of drifting from per-row rounding (a real-but-tiny row shows "<1%").
  if (grandTotal > 0) {
    const priced = rows.filter((r) => r.priced);
    const pcts = sharePercents(priced.map((r) => r.total));
    priced.forEach((r, i) => {
      r.pct = pcts[i];
    });
  }

  const nameW = Math.min(30, Math.max(1, ...rows.map((r) => r.name.length)));
  const out = ["", pc.bold(title)];
  for (const r of rows) {
    const name = (r.name.length > nameW ? r.name.slice(0, nameW - 1) + "…" : r.name).padEnd(nameW);
    const amount = (r.priced ? formatCost(r.total) : "unpriced").padStart(12);
    let share = "";
    if (r.priced && grandTotal > 0) {
      share = (r.pct === 0 && r.total > 0 ? "<1%" : `${r.pct}%`).padStart(5);
    }
    out.push(`  ${name}  ${amount}  ${pc.dim(share)}`.trimEnd());
  }
  return out;
}

/** Render the full ledger (also reused by tests). */
export function renderCost(summary: TokenSummary, label: string): string {
  const t = summary.totals;
  const grand = costTotal(t);
  const priced = t.cost !== null;

  const lines: string[] = [];
  lines.push(pc.bold("codument cost") + pc.dim(`  ·  ${label}`));
  lines.push("");
  lines.push(
    `  ${pc.bold(priced ? formatCost(grand) : "unpriced")} ${pc.dim("estimated")}  ·  ${plural(
      t.eventCount,
      "event",
    )}`,
  );
  lines.push(
    pc.dim(
      `  ${compact(t.usage.input)} in · ${compact(t.usage.output)} out · ` +
        `${compact(t.usage.cacheRead)} cache-read · ${compact(t.usage.cacheCreate)} cache-create`,
    ),
  );

  lines.push(...renderGroup("by feature", summary.byFeature, grand));
  lines.push(...renderGroup("by model", summary.byModel, grand));
  // Steps are only meaningful when something was actually attributed to one.
  if (Object.keys(summary.byStep).some((k) => k !== "(none)")) {
    lines.push(...renderGroup("by step", summary.byStep, grand));
  }

  if (summary.unpriced.length > 0) {
    lines.push("");
    lines.push(pc.yellow(`  ⚠ unpriced models: ${summary.unpriced.join(", ")}`));
    lines.push(pc.dim("  Add rates in .codument/rates.json to price these."));
  }
  lines.push("");
  lines.push(pc.dim("  estimated from captured token usage · facts, not a bill"));
  return lines.join("\n");
}

/**
 * Print the full token-cost ledger for a project: the all-sessions total plus a
 * per-feature, per-model, and (when present) per-step breakdown. Reads the
 * already-captured event log — it does not tail Claude; refresh with `feed`/`watch`.
 */
export function cost(options: CostOptions = {}): void {
  const root = options.root ?? options.dir ?? process.cwd();
  const events = readAllEvents(root);
  const summary = summarizeTokens(events, loadRates(root));

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (summary.totals.eventCount === 0) {
    console.log(pc.yellow("codument cost: no token usage captured in .codument/events.jsonl yet."));
    console.log(
      pc.dim(
        "  Run `codument feed` (or `codument feed --backfill`) to capture token usage, then try again.",
      ),
    );
    return;
  }

  console.log(renderCost(summary, basename(root)));
}
