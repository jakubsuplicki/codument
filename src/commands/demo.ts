import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  copyFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import pc from "picocolors";
import { warmAdaptersForRepo } from "../lib/fingerprint.js";
import { packageRoot } from "../lib/scaffold.js";
import { buildReport, writeCoverageArtifacts } from "./doctor.js";
import { buildReview } from "./review.js";
import { writeReport, openInBrowser } from "./report.js";
import { buildFrame, CLEAR, clockLabel } from "./watch.js";
import type { DemoExplainer } from "../lib/report-html.js";

// The explainer embedded in the demo's HTML report so anyone showcasing it can
// answer "how does this work / what is it checking?" without narration. It is
// pinned to the bundled change-control fixture (a stable golden fixture), so the
// per-file notes below describe exactly why each planted change is flagged.
const DEMO_EXPLAINER: DemoExplainer = {
  intro:
    "This is a throwaway sample repo Codument created just for the demo — no network, no AI model, fully deterministic (same repo state → same report). It never commits to or touches your own project.",
  scenario:
    "An AI agent was asked to add rate limiting to the login path. The approved plan (add-rate-limiting) signed off on only two files: src/lib/ratelimit.ts and src/auth/login.ts. The agent went further — it also rewrote the database layer, added a cache, and edited the tasks feature. The report below is the review of that diff.",
  changeRows: [
    {
      file: "src/auth/login.ts",
      note: "In the plan, but it's a high-risk area (auth) and its doc (auth.md) wasn't updated → high-risk touch + stale doc.",
    },
    {
      file: "src/lib/db.ts",
      note: "Out of plan, high-risk (db), and its doc (db.md) wasn't updated → out-of-plan + high-risk + stale; other features depend on it → dependents flagged.",
    },
    {
      file: "src/lib/cache.ts",
      note: "Brand-new file in no registry entry → unmapped, and outside the plan → out-of-plan.",
    },
    {
      file: "src/lib/ratelimit.ts",
      note: "The new file the plan expected — but it was never added to the registry → unmapped.",
    },
    {
      file: "src/tasks/tasks.ts",
      note: "Out of plan, but its doc (tasks.md) was updated alongside it → correctly NOT flagged stale (the positive control).",
    },
  ],
  footnote:
    "Everything above is computed from that diff. Close the browser and the sample repo is deleted — nothing leaks into your project.",
};

interface DemoOptions {
  auto?: boolean;
  dir?: string;
  live?: boolean;
}

// A one-command, click-through showcase. It materializes the packaged
// change-control fixture as a throwaway git repo and tells the story in three
// beats — a project's coverage today, an AI makes a sweeping change, and the
// review of that change as a clean HTML report that opens in the browser.
// Everything runs the real commands in-process: what you see is what the tool does.

function git(root: string, args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

function gitStatus(root: string): string {
  return execFileSync("git", ["-C", root, "status", "--porcelain"], {
    encoding: "utf-8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

async function pause(auto: boolean): Promise<void> {
  if (auto || !process.stdin.isTTY) {
    console.log();
    return;
  }
  await new Promise<void>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(pc.dim("    ↵  press Enter to continue… "), () => {
      rl.close();
      console.log();
      resolve();
    });
  });
}

function scene(title: string, blurb: string): void {
  console.log();
  console.log(pc.bold(pc.cyan(`  ${title}`)));
  console.log(pc.dim(`  ${blurb}`));
  console.log();
}

// demo owns and recreates its target directory, so it must wipe it first. This
// marker file, dropped inside the dir on creation, is how a re-run recognises a
// directory it created and may safely delete again.
const DEMO_MARKER = ".codument-demo";

// Guard the single destructive `rmSync` below: only recreate a path we can prove
// is ours to destroy. Nonexistent or empty → nothing to lose; the auto-chosen
// default temp path → managed by us; a directory carrying our marker → a prior
// demo run. Anything else (a real, populated directory the user pointed us at)
// is refused rather than silently deleted.
function isSafeToRecreate(dir: string, isDefault: boolean): boolean {
  if (!existsSync(dir)) return true;
  if (!statSync(dir).isDirectory()) return false;
  if (readdirSync(dir).length === 0) return true;
  if (isDefault) return true;
  return existsSync(join(dir, DEMO_MARKER));
}

export async function demo(options: DemoOptions = {}): Promise<void> {
  const auto = options.auto ?? false;
  const interactive = !!process.stdin.isTTY && !auto;
  const fixture = join(packageRoot(), "fixtures", "benchmarks", "change-control");
  if (!existsSync(fixture)) {
    console.log(pc.red("  codument demo: bundled demo fixture not found."));
    process.exitCode = 1;
    return;
  }

  const isDefaultDir = options.dir === undefined;
  const dir = options.dir ?? join(tmpdir(), "codument-demo");
  if (!isSafeToRecreate(dir, isDefaultDir)) {
    console.log(
      pc.red(`  codument demo: ${dir} already exists and is not an empty directory.`),
    );
    console.log(
      pc.dim(
        "  demo recreates whatever directory you point --dir at; pass a new or empty path so nothing is destroyed.",
      ),
    );
    process.exitCode = 1;
    return;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, DEMO_MARKER), "");
  cpSync(join(fixture, "project"), dir, { recursive: true });

  try {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "demo@example.com"]);
    git(dir, ["config", "user.name", "codument demo"]);
    git(dir, ["add", "-A"]);
    git(dir, ["-c", "commit.gpgsign=false", "commit", "-qm", "baseline"]);
  } catch {
    console.log(pc.red("  codument demo: git is required to run the demo."));
    process.exitCode = 1;
    return;
  }

  // The bundled fixture is TS-only today, but that is fixture composition,
  // not an invariant — warm here (ahead of the live/static fork) so a future
  // .py in the fixture cannot cold-crash either path.
  await warmAdaptersForRepo(dir);

  if (options.live ?? false) {
    await demoLive(dir, fixture, auto, interactive);
    return;
  }

  console.log();
  console.log(
    pc.bold("  codument demo") +
      pc.dim("  ·  deterministic change-control for AI-made changes"),
  );
  console.log(
    pc.dim("  A throwaway sample repo. No network, no AI model — same state, same output."),
  );

  // ① baseline coverage (persist it so the report can show the delta later)
  const before = buildReport(dir);
  writeCoverageArtifacts(dir, before);
  scene("①  Where this project stands", "One deterministic number for how well the docs cover the code.");
  await pauseMsg(
    `  documentation coverage:  ${pc.bold(pctText(before.coverage.percent))}   ` +
      pc.dim(`(${before.lint.count} gaps codument can list)`),
    auto,
  );

  // ② the AI change
  cpSync(join(fixture, "changes"), dir, { recursive: true });
  scene("②  An AI agent makes a sweeping change", "It edits login + the database layer, adds two files, updates one doc.");
  for (const line of gitStatus(dir).split("\n").filter(Boolean)) {
    console.log(`    ${pc.yellow(line)}`);
  }
  await pause(auto);

  // ③ the review, as a report
  const after = buildReport(dir);
  const review = buildReview(dir);
  const s = review.state;
  const delta = (after.coverage.percent ?? 0) - (before.coverage.percent ?? 0);

  scene("③  What codument caught", "Without it, this AI change would merge silently.");
  console.log(
    "  " + pc.dim("Without codument") + "  this diff merges with none of the below surfaced.",
  );
  console.log("  " + pc.bold("With codument") + "  it flagged:");
  console.log();
  const findings: [number, string][] = [
    [s.staleDocs.length, "docs now describe code that changed"],
    [s.unmapped.length, "new files nobody owns"],
    [s.outOfPlan.length, "changes outside the approved plan"],
    [s.riskTouches.length, "high-risk areas touched"],
  ];
  for (const [n, label] of findings) {
    if (n > 0) {
      console.log(`     ${pc.yellow("⚠")} ${pc.bold(String(n))} ${pc.yellow(label)}`);
    }
  }
  console.log();
  console.log(
    pc.dim(
      `  coverage ${pctText(before.coverage.percent)} → ${pctText(after.coverage.percent)} (${delta}) — a health gauge, not the verdict`,
    ),
  );
  console.log();

  const out = writeReport(dir, undefined, DEMO_EXPLAINER);
  if (interactive && openInBrowser(out)) {
    console.log(`  ${pc.green("✓")} full report opened in your browser`);
    console.log(pc.dim(`    ${out}`));
  } else {
    console.log(`  ${pc.green("✓")} full HTML report written:`);
    console.log(pc.dim(`    ${out}`));
    console.log(pc.dim(`    open it in a browser to see the verdict, delta, and findings.`));
  }

  console.log();
  console.log(
    pc.bold("  That's codument.") +
      pc.dim("  Run `codument report` in any git repo to get this for a real change."),
  );
  console.log();
}

// The live showcase: one terminal, no second window, no stash dance. The watch
// panel starts on a clean tree, then the AI's change lands file-by-file and the
// counts visibly climb — the same `renderFrame` the real `watch` loop uses.
async function demoLive(
  dir: string,
  fixture: string,
  auto: boolean,
  interactive: boolean,
): Promise<void> {
  // Capture the clean baseline coverage in memory now; write it as the report's
  // "before" only at the end, so the live frames stay free of .codument noise.
  const before = buildReport(dir);

  console.log();
  console.log(
    pc.bold("  codument demo --live") +
      pc.dim("  ·  the watch panel, driven by an AI change"),
  );
  console.log(
    pc.dim(
      "  A throwaway sample repo. Watch the panel react as the change lands — no second terminal.",
    ),
  );

  drawFrame(dir, pc.green("  ✓ clean working tree — codument watch shows this continuously"), interactive);
  console.log(pc.dim("  An AI agent is about to add rate limiting (and overreach past its plan)."));
  await pause(auto);

  const changesRoot = join(fixture, "changes");
  for (const rel of listFilesRel(changesRoot)) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(changesRoot, rel), dest);
    drawFrame(dir, pc.yellow(`  ● an AI agent is editing…  ${rel}`), interactive);
    await delay(interactive ? 750 : 0);
  }

  drawFrame(dir, pc.red("  ✕ the change is in — codument flagged what to look at"), interactive);
  console.log();

  // Now persist the baseline coverage + write the shareable HTML report.
  writeCoverageArtifacts(dir, before);
  const out = writeReport(dir, undefined, DEMO_EXPLAINER);
  if (interactive && openInBrowser(out)) {
    console.log(`  ${pc.green("✓")} full report opened in your browser  ${pc.dim(out)}`);
  } else {
    console.log(`  ${pc.green("✓")} full HTML report: ${pc.dim(out)}`);
  }

  console.log();
  console.log(
    pc.bold("  That's codument watch.") +
      pc.dim("  Run `codument watch` in any repo to keep this live while your agent works."),
  );
  console.log();
}

/** Redraws the live watch frame. Clears the screen when interactive; stacks otherwise. */
function drawFrame(dir: string, footer: string, interactive: boolean): void {
  const body = buildFrame(dir, clockLabel(new Date()));
  process.stdout.write((interactive ? CLEAR : "\n") + body + "\n" + footer + "\n");
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/** Sorted relative file paths under `root` (deterministic order for the animation). */
function listFilesRel(root: string, base: string = root): string[] {
  const out: string[] = [];
  const entries = readdirSync(base, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  for (const entry of entries) {
    const full = join(base, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRel(root, full));
    else out.push(relative(root, full));
  }
  return out;
}

function pctText(percent: number | null): string {
  return percent === null ? "N/A" : `${percent}%`;
}

async function pauseMsg(line: string, auto: boolean): Promise<void> {
  console.log(line);
  await pause(auto);
}
