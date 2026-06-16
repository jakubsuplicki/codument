import pc from "picocolors";
import { buildReview, type ReviewReport } from "./review.js";
import { buildReport, type DoctorReport } from "./doctor.js";
import { isGitRepo } from "../lib/git.js";
import { readRecentEvents, type CodumentEvent } from "../lib/events.js";

interface WatchOptions {
  root?: string;
  dir?: string;
  once?: boolean;
  interval?: string | number;
}

/** ANSI clear-screen + home — exported so the live demo can redraw in place. */
export const CLEAR = "\x1b[2J\x1b[H";

// Zero-dependency live terminal view. Same architecture the plan called for —
// a foreground loop over the shared computeChangeState analyzer (so watch and
// review can never disagree) plus the .codument/events.jsonl tail — rendered
// with ANSI rather than Ink to keep codument's minimal-dependency stance.

/** Pure frame renderer. `now` is injected so output is testable. */
export function renderFrame(
  review: ReviewReport,
  coverage: DoctorReport,
  events: CodumentEvent[],
  now: string,
): string {
  const lines: string[] = [];
  lines.push(pc.bold("codument watch") + pc.dim(`  ·  ${now}`));
  lines.push("");

  const cov =
    coverage.coverage.percent === null ? "N/A" : `${coverage.coverage.percent}%`;
  if (!review.isGitRepo) {
    lines.push(
      `docs coverage: ${pc.bold(cov)}   ${pc.yellow("(not a git repo — change view disabled)")}`,
    );
    lines.push("");
    return lines.join("\n");
  }

  const s = review.state;
  lines.push(
    `docs coverage: ${pc.bold(cov)}   |   ${review.changedFileCount} changed (${s.changedSources.length} src, ${s.changedDocs.length} docs)` +
      (review.plan ? pc.dim(`   plan: ${review.plan.plan}`) : ""),
  );
  lines.push("");

  const stat = (label: string, value: string, warn = false) =>
    `  ${label.padEnd(16)} ${warn ? pc.yellow(value) : value}`;

  lines.push(
    stat(
      "stale docs",
      String(s.staleDocs.length),
      s.staleDocs.length > 0,
    ) + (s.staleDocs.length ? pc.dim(`  ${s.staleDocs.map((d) => d.feature).join(", ")}`) : ""),
  );
  lines.push(
    stat("risk touched", String(s.riskTouches.length), s.riskTouches.length > 0) +
      (s.riskTouches.length ? pc.dim(`  ${s.riskTouches.map((r) => r.feature).join(", ")}`) : ""),
  );
  lines.push(stat("unmapped", String(s.unmapped.length), s.unmapped.length > 0));
  if (review.plan) {
    lines.push(stat("out-of-plan", String(s.outOfPlan.length), s.outOfPlan.length > 0));
  }
  lines.push(stat("high-fanout", String(s.highFanout.length), s.highFanout.length > 0));
  lines.push(stat("dependents", String(s.dependents.length)));
  lines.push("");

  if (events.length > 0) {
    lines.push(pc.bold("  recent events"));
    for (const e of events.slice(-6)) {
      const when = e.ts.replace("T", " ").replace(/\..*$/, "");
      lines.push(`  ${pc.dim(when)}  ${pc.cyan(e.type)}  ${e.message ?? ""}`);
    }
    lines.push("");
  }

  lines.push(pc.dim("  Ctrl-C to stop · refreshes on an interval · facts, not a safety guarantee"));
  return lines.join("\n");
}

/** Builds one frame's data from the repo and renders it. Exported for the live demo. */
export function buildFrame(root: string, now: string): string {
  const review = buildReview(root);
  const coverage = buildReport(root);
  const events = readRecentEvents(root, 6);
  return renderFrame(review, coverage, events, now);
}

export async function watch(options: WatchOptions = {}): Promise<void> {
  const root = options.root ?? options.dir ?? process.cwd();

  if (options.once) {
    // Single frame, no screen clear — for CI/tests and one-shot inspection.
    console.log(buildFrame(root, new Date().toISOString()));
    return;
  }

  if (!isGitRepo(root)) {
    console.log(pc.yellow("codument watch: not a git repository."));
    return;
  }

  const intervalMs = Math.max(500, Number(options.interval) || 2000);
  const draw = () => {
    process.stdout.write(CLEAR + buildFrame(root, new Date().toISOString()) + "\n");
  };
  draw();
  const timer = setInterval(draw, intervalMs);

  const stop = () => {
    clearInterval(timer);
    process.stdout.write("\n");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
