import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import pc from "picocolors";
import { buildReview } from "./review.js";
import { buildReport } from "./doctor.js";
import {
  renderReviewReportHtml,
  type ReportData,
  type DemoExplainer,
} from "../lib/report-html.js";

interface ReportOptions {
  root?: string;
  out?: string;
  open?: boolean;
}

// Reads the last persisted coverage (from `doctor --write`) so the report can
// show a coverage delta for this change. Read-only — report never rewrites it.
function readPreviousPercent(root: string): number | null {
  const path = join(root, ".codument", "coverage.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return typeof parsed.percent === "number" ? parsed.percent : null;
  } catch {
    return null;
  }
}

export function buildReportData(
  root: string,
  generatedAt: string,
  demo?: DemoExplainer,
): ReportData {
  return {
    review: buildReview(root),
    coveragePercent: buildReport(root).coverage.percent,
    previousPercent: readPreviousPercent(root),
    generatedAt,
    demo,
  };
}

/**
 * Renders the self-contained HTML report and writes it; returns the path.
 * Pass `demo` to embed the "how this demo works" explainer callout.
 */
export function writeReport(
  root: string,
  outPath?: string,
  demo?: DemoExplainer,
): string {
  const out = outPath ?? join(root, ".codument", "report.html");
  const dir = join(out, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace("T", " ").replace(/\..+/, " UTC");
  writeFileSync(out, renderReviewReportHtml(buildReportData(root, stamp, demo)));
  return out;
}

export function openInBrowser(path: string): boolean {
  const cmd =
    platform() === "darwin"
      ? "open"
      : platform() === "win32"
        ? "explorer"
        : "xdg-open";
  try {
    // detached + unref so we never block or hold the terminal
    const child = execFile(cmd, [path], () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

export async function report(options: ReportOptions = {}): Promise<void> {
  const root = options.root ?? process.cwd();
  const out = writeReport(root, options.out);

  console.log(pc.bold("codument report"));
  console.log(`  ${pc.green("✓")} wrote ${out}`);

  if (options.open !== false) {
    if (openInBrowser(out)) {
      console.log(pc.dim("  opening in your browser…"));
    } else {
      console.log(pc.dim(`  open it manually: ${out}`));
    }
  }
}
