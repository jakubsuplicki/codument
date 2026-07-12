import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import pc from "picocolors";
import { warmAdaptersForRepo } from "../lib/fingerprint.js";
import { assertRootIsRepoToplevel, isGitRepo } from "../lib/git.js";
import { GateError } from "../lib/two-ref.js";
import { buildReview, type CoveringAck } from "./review.js";
import { buildReport } from "./doctor.js";
import { buildImpactLedger, type ImpactLedger } from "../lib/impact-ledger.js";
import {
  renderReviewReportHtml,
  type ReportData,
  type DemoExplainer,
} from "../lib/report-html.js";

interface ReportOptions {
  root?: string;
  out?: string;
  open?: boolean;
  json?: boolean;
}

/**
 * The versioned `report --json` contract: the report's two machine-relevant
 * sections — the all-sessions impact ledger and the acks adjudicating this change.
 * Deliberately carries NO timestamp (the HTML report's `generatedAt` is a
 * human-surface stamp), so the output is byte-identical across runs and a CI
 * consumer can diff it. Version-tagged like `doctor --json`.
 */
export interface ReportJson {
  version: 1;
  impact: ImpactLedger;
  acks: CoveringAck[];
}

export function buildReportJson(root: string): ReportJson {
  return {
    version: 1,
    impact: buildImpactLedger(root),
    acks: buildReview(root).coveringAcks,
  };
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
    impact: buildImpactLedger(root),
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
  // Both report surfaces run the sync review builder; warm adapters up front.
  await warmAdaptersForRepo(root);
  // A gate that cannot run fails CLOSED on BOTH surfaces — the shareable HTML and
  // the --json contract — never a misleading "all clean" verdict. A non-git tree has
  // no verdict to compute (mirroring review's own non-git refusal), and a wrong root
  // (a subdirectory) would answer the wrong question; either one exits nonzero rather
  // than persisting or emitting a green report. Under --json the refusal is the same
  // discriminated `gate: "unavailable"` shape the other --json surfaces use, so a
  // consumer never reads an absent verdict as a pass.
  if (!isGitRepo(root)) {
    const reason = "not a git repository";
    if (options.json) {
      console.log(JSON.stringify({ version: 1, gate: "unavailable", reason }, null, 2));
    } else {
      console.log(pc.red(`  ✗ ${reason} (gate could not run)`));
    }
    process.exitCode = 1;
    return;
  }
  // The report renders the same gate verdict review refuses to compute from a
  // subdirectory root — refusing here too keeps the wrong verdict off the one
  // surface that persists and gets shared. Under --json the refusal stays
  // machine-readable (a discriminated shape), so a JSON consumer never has to parse
  // human error text; the human path lets the cli boundary render the GateError.
  try {
    assertRootIsRepoToplevel(root);
  } catch (err) {
    if (err instanceof GateError && options.json) {
      console.log(
        JSON.stringify({ version: 1, gate: "unavailable", reason: err.message }, null, 2),
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if (options.json) {
    // The machine surface: ledger + acks, version-tagged and timestamp-free so it
    // is byte-identical across runs. Never writes an artifact or opens a browser. A
    // GateError raised while computing the verdict (e.g. git itself failing on an
    // oversized diff) still comes back as the discriminated `gate: "unavailable"`
    // shape, never human text to a JSON consumer — the same guarantee review --json
    // makes for a mid-computation gate failure.
    try {
      console.log(JSON.stringify(buildReportJson(root), null, 2));
    } catch (err) {
      if (err instanceof GateError) {
        console.log(
          JSON.stringify({ version: 1, gate: "unavailable", reason: err.message }, null, 2),
        );
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    return;
  }

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
