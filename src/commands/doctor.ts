import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { readRegistrySync } from "../lib/registry.js";
import { renderCoverageBadge } from "../lib/badge.js";
import {
  analyze,
  DEFAULT_BLOAT_THRESHOLDS,
  type BloatThresholds,
  type CoverageRatio,
  type CoverageReport,
  type LintFinding,
} from "../lib/analyze.js";

interface DoctorOptions {
  root?: string;
  json?: boolean;
  write?: boolean;
  strict?: boolean;
  maxDocLines?: string | number;
  maxSectionLines?: string | number;
  maxCompletedLog?: string | number;
  highFanout?: string | number;
}

// Deterministic score artifact (no timestamp): the single file a badge, CI, or
// a future GUI reads. Same repo state → byte-identical file, so it diffs cleanly.
export interface CoverageArtifact {
  version: 1;
  score: number | null;
  percent: number | null;
  applicable: string[];
  ratios: CoverageReport["ratios"];
}

/** Writes `.codument/coverage.json` and `.codument/coverage.svg`. Returns paths. */
export function writeCoverageArtifacts(
  root: string,
  report: DoctorReport,
): { jsonPath: string; svgPath: string } {
  const dir = join(root, ".codument");
  mkdirSync(dir, { recursive: true });

  const artifact: CoverageArtifact = {
    version: 1,
    score: report.coverage.score,
    percent: report.coverage.percent,
    applicable: report.coverage.applicable,
    ratios: report.coverage.ratios,
  };
  const jsonPath = join(dir, "coverage.json");
  const svgPath = join(dir, "coverage.svg");
  writeFileSync(jsonPath, JSON.stringify(artifact, null, 2) + "\n");
  writeFileSync(svgPath, renderCoverageBadge(report.coverage.percent));
  return { jsonPath, svgPath };
}

interface ReportOptions {
  bloat?: Partial<BloatThresholds>;
  highFanoutThreshold?: number;
}

// Stable machine contract consumed by CI, the badge, and a future GUI.
export interface DoctorReport {
  version: 1;
  registryExists: boolean;
  inScopeSourceCount: number;
  coverage: CoverageReport;
  lint: {
    // Actionable warnings only — a clean registry has count === 0. Informational
    // notes (e.g. high-fanout) are kept out of this number so "clean" can never
    // be reached by degrading the registry to silence an awareness-only signal.
    count: number;
    byId: Record<string, number>;
    findings: LintFinding[];
    /** Awareness-only findings (severity "info"). Never block clean. */
    notes: LintFinding[];
  };
}

function missingRegistryFinding(): LintFinding {
  return {
    id: "missing-registry",
    severity: "warn",
    file: "docs/.registry.json",
    message:
      "docs/.registry.json not found — run `codument init` or `codument scan` first",
  };
}

/**
 * Pure, deterministic doctor report over the v2 registry. Same repo state →
 * same report (no wall clock, no randomness). When the registry is absent the
 * analysis still runs (everything is unmapped) and a missing-registry warning
 * is prepended rather than failing the run.
 */
export function buildReport(
  root: string,
  opts: ReportOptions = {},
): DoctorReport {
  const registryPath = join(root, "docs", ".registry.json");
  const registryExists = existsSync(registryPath);
  const registry = readRegistrySync(registryPath);

  const bloat: BloatThresholds = { ...DEFAULT_BLOAT_THRESHOLDS, ...opts.bloat };
  const result = analyze({
    root,
    registry,
    bloat,
    highFanoutThreshold: opts.highFanoutThreshold,
  });
  const all = registryExists
    ? result.lint
    : [missingRegistryFinding(), ...result.lint];

  // Split actionable warnings from awareness-only notes: "clean" is defined over
  // warnings, so an info finding can never keep the registry from going green.
  const findings = all.filter((f) => f.severity === "warn");
  const notes = all.filter((f) => f.severity === "info");

  const byId: Record<string, number> = {};
  for (const finding of findings) {
    byId[finding.id] = (byId[finding.id] ?? 0) + 1;
  }

  return {
    version: 1,
    registryExists,
    inScopeSourceCount: result.inScopeSourceCount,
    coverage: result.coverage,
    lint: { count: findings.length, byId, findings, notes },
  };
}

function num(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export async function doctor(options: DoctorOptions = {}): Promise<void> {
  const root = options.root ?? process.cwd();
  const bloat: Partial<BloatThresholds> = {};
  const wholeDocLines = num(options.maxDocLines);
  const sectionLines = num(options.maxSectionLines);
  const completedLogItems = num(options.maxCompletedLog);
  if (wholeDocLines !== undefined) bloat.wholeDocLines = wholeDocLines;
  if (sectionLines !== undefined) bloat.sectionLines = sectionLines;
  if (completedLogItems !== undefined) bloat.completedLogItems = completedLogItems;

  const report = buildReport(root, {
    bloat,
    highFanoutThreshold: num(options.highFanout),
  });

  // --strict is opt-in CI gating: it only sets a nonzero exit code when there
  // are actionable findings. Notes (info) are excluded by lint.count and bare
  // `doctor` is unaffected. It never writes to stdout, so `--json` output stays
  // byte-identical and only the process exit code differs.
  const strictFail = !!options.strict && report.lint.count > 0;

  if (options.write) {
    const { jsonPath, svgPath } = writeCoverageArtifacts(root, report);
    if (!options.json) {
      console.log(
        pc.dim(`  wrote ${relativeTo(root, jsonPath)} and ${relativeTo(root, svgPath)}`),
      );
      console.log();
    }
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    if (strictFail) process.exitCode = 1;
    return;
  }

  printHuman(report, strictFail);
  if (strictFail) process.exitCode = 1;
}

function relativeTo(root: string, p: string): string {
  return p.startsWith(root + "/") ? p.slice(root.length + 1) : p;
}

// ── Human output (warning-only) ─────────────────────────────────────────

function pct(ratio: number | null): string {
  return ratio === null ? "—" : `${Math.round(ratio * 100)}%`;
}

function ratioLine(r: CoverageRatio): string {
  const label = r.id.padEnd(11);
  if (!r.applicable) {
    return `    ${label} ${"—".padStart(4)}  ${pc.dim("N/A")}`;
  }
  const frac = `${r.numerator}/${r.denominator}`;
  let suffix = "";
  if (r.id === "ownership") {
    const unowned = (r.detail?.unowned as string[] | undefined)?.length ?? 0;
    if (unowned > 0) {
      suffix = pc.dim(`  (${unowned} file${unowned === 1 ? "" : "s"} without an owner)`);
    }
  }
  return `    ${label} ${pct(r.ratio).padStart(4)}  ${pc.dim(frac)}${suffix}`;
}

function printHuman(report: DoctorReport, strictFail = false): void {
  const { coverage, lint } = report;

  console.log(pc.bold("codument doctor"));
  console.log();

  const headline =
    coverage.percent === null ? pc.dim("N/A") : pc.bold(`${coverage.percent}%`);
  console.log(`  Documentation coverage: ${headline}`);
  for (const r of coverage.ratios) {
    console.log(ratioLine(r));
  }
  console.log();

  if (lint.count === 0) {
    console.log(`  ${pc.green("✓")} Lint: no findings`);
  } else {
    console.log(`  Lint: ${pc.yellow(String(lint.count))} findings`);
    for (const finding of lint.findings) {
      console.log(
        `    ${pc.yellow("⚠")} ${pc.dim(finding.id.padEnd(17))} ${finding.message}`,
      );
    }
  }

  if (lint.notes.length > 0) {
    console.log();
    console.log(
      `  ${pc.dim("Notes:")} ${pc.dim(String(lint.notes.length) + " informational — review, not required to clear")}`,
    );
    for (const note of lint.notes) {
      console.log(
        `    ${pc.cyan("ℹ")} ${pc.dim(note.id.padEnd(17))} ${pc.dim(note.message)}`,
      );
    }
  }

  console.log();
  console.log(
    pc.dim(
      "  Coverage is a gap-finder (registry membership + dependencies), not a quality score.",
    ),
  );
  if (strictFail) {
    console.log(
      pc.red(
        `  Strict: ${report.lint.count} finding${report.lint.count === 1 ? "" : "s"} present, failing (exit 1). Notes are awareness-only and never count.`,
      ),
    );
  } else {
    console.log(
      pc.dim(
        "  Findings are warnings, not failures. Notes are awareness-only. Neither changes the exit code.",
      ),
    );
  }
}
