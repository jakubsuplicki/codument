import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { listIgnoredPaths } from "./git.js";
import {
  allSources,
  isMatureEntry,
  type Registry,
  type RegistryEntry,
} from "./registry.js";

// ── Canonical exclusion spec ────────────────────────────────────────────
//
// One version-controlled spec, shared by every analyzer (doctor, review, watch,
// scan), applied to BOTH the coverage numerator and denominator. "What should be
// documented" is a choice; a naive every-file denominator turns the score into
// noise, so generated/build/test files and trivia are excluded here once.
//
// The exclusion overrides the registry's own contents: a test/generated path
// listed in some entry's sources is still filtered out of the in-scope set.

export interface ExclusionSpec {
  /** Directory names ignored anywhere in a path. */
  dirs: string[];
  /** Glob patterns ( ** and * supported ) matched against the relative path. */
  globs: string[];
  /** File extensions counted as source. */
  extensions: string[];
}

export const DEFAULT_EXCLUSION_SPEC: ExclusionSpec = {
  dirs: [
    ".agents",
    ".claude",
    ".codument",
    ".git",
    ".next",
    ".nuxt",
    ".output",
    ".wxt",
    "__tests__",
    "build",
    "coverage",
    "dist",
    "node_modules",
  ],
  globs: [
    "**/*.test.*",
    "**/*.spec.*",
    "**/*.d.ts",
    "**/*.seed.json",
    "**/generated/**",
    "scripts/generate-*",
  ],
  extensions: [".ts", ".tsx", ".js", ".jsx"],
};

// Exported so the Feature Map router (feature-map.ts) matches globs with the
// exact same semantics the exclusion spec uses — one globber, no drift.
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?"; // **/ → zero or more leading segments
          i += 2;
        } else {
          re += ".*"; // ** → anything
          i += 1;
        }
      } else {
        re += "[^/]*"; // * → anything but a path separator
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** True when a relative path is excluded by the spec (dir, glob, or both). */
export function isExcluded(
  relPath: string,
  spec: ExclusionSpec = DEFAULT_EXCLUSION_SPEC,
): boolean {
  const posix = toPosix(relPath);
  const segments = posix.split("/");
  if (segments.some((segment) => spec.dirs.includes(segment))) {
    return true;
  }
  return spec.globs.some((glob) => globToRegExp(glob).test(posix));
}

/** True when a path is a non-excluded source file by extension. */
export function isSourceFile(
  relPath: string,
  spec: ExclusionSpec = DEFAULT_EXCLUSION_SPEC,
): boolean {
  const posix = toPosix(relPath);
  const hasSourceExt = spec.extensions.some((ext) => posix.endsWith(ext));
  return hasSourceExt && !isExcluded(posix, spec);
}

// ── Source discovery ────────────────────────────────────────────────────

/**
 * List in-scope source files under `srcDir`, returned as sorted root-relative
 * POSIX paths. Excluded dirs are skipped during the walk; excluded files are
 * filtered out, so the result is the coverage denominator's file set.
 *
 * `isIgnored` lets the caller prune paths git ignores (generated/build/vendored
 * trees) without this function depending on git — `analyze` wires in the repo's
 * real gitignore set; direct callers default to a no-op for pure filesystem scope.
 */
export function discoverSourceFiles(
  root: string,
  srcDir: string,
  spec: ExclusionSpec = DEFAULT_EXCLUSION_SPEC,
  isIgnored: (relPosixPath: string) => boolean = () => false,
): string[] {
  const base = join(root, srcDir);
  if (!existsSync(base)) return [];

  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = toPosix(relative(root, join(dir, entry.name)));
      if (entry.isDirectory()) {
        if (spec.dirs.includes(entry.name)) continue;
        if (isIgnored(rel)) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        if (isIgnored(rel)) continue;
        if (isSourceFile(rel, spec)) {
          found.push(rel);
        }
      }
    }
  };
  walk(base);
  return [...new Set(found)].sort();
}

/**
 * Build a gitignore predicate from a repo's ignored-path list. A path is ignored
 * when it equals, or sits under, any collapsed ignored entry.
 */
export function makeIgnoredPredicate(
  ignoredPaths: string[],
): (relPosixPath: string) => boolean {
  if (ignoredPaths.length === 0) return () => false;
  return (rel) =>
    ignoredPaths.some((p) => rel === p || rel.startsWith(p + "/"));
}

// ── Coverage ratios ─────────────────────────────────────────────────────

export type CoverageRatioId = "ownership" | "freshness" | "dependency" | "risk";

export interface CoverageRatio {
  id: CoverageRatioId;
  label: string;
  numerator: number;
  denominator: number; // 0 means N/A
  ratio: number | null; // null when denominator is 0
  applicable: boolean; // true when denominator > 0
  detail?: Record<string, unknown>;
}

export interface CoverageReport {
  ratios: CoverageRatio[];
  /** Equal-weight average of applicable ratios, or null when none apply. */
  score: number | null;
  /** Rounded whole-percent of `score`, or null. */
  percent: number | null;
  /** Ids of the ratios that fed the score. */
  applicable: CoverageRatioId[];
}

/** A changed file from a git window, used only for the freshness ratio. */
export interface ChangedFile {
  file: string;
  mappedDocChanged: boolean;
}

// ── Lint findings ───────────────────────────────────────────────────────

export type LintFindingId =
  | "missing-registry"
  | "missing-source"
  | "missing-doc"
  | "generated-leakage"
  | "high-fanout"
  | "empty-depends-on"
  | "bloated-doc"
  | "unmapped-source";

// Bloat is measured by three independent signals, never one line count.
// Conservative defaults, calibrated against fixtures/benchmarks/doc-bloat;
// CLI-overridable so projects can tune noise without editing code.
export interface BloatThresholds {
  /** Whole-doc line count above which the doc is oversized. */
  wholeDocLines: number;
  /** A single heading section above this line count is oversized. */
  sectionLines: number;
  /** Count of inline `[x]` completed-log items above which to compact. */
  completedLogItems: number;
}

export const DEFAULT_BLOAT_THRESHOLDS: BloatThresholds = {
  wholeDocLines: 400,
  sectionLines: 150,
  completedLogItems: 15,
};

export interface LintFinding {
  id: LintFindingId;
  /**
   * "warn" findings are actionable — a clean registry has zero of them.
   * "info" findings are awareness-only and never block clean; they surface a
   * fact worth reviewing (e.g. a file shared by many features) but demand no
   * change, since acting on them blindly can degrade the registry.
   */
  severity: "warn" | "info";
  message: string;
  feature?: string;
  file?: string;
  count?: number;
  evidence?: string[];
}

// ── Analyzer input/output ───────────────────────────────────────────────

export interface AnalyzeInput {
  root: string;
  registry: Registry;
  /** Defaults to "src" when present, else ".". */
  srcDir?: string;
  exclusion?: ExclusionSpec;
  /** Distinct-entry count at which a mapped file is flagged high-fanout. */
  highFanoutThreshold?: number;
  /** Doc-bloat thresholds; defaults to DEFAULT_BLOAT_THRESHOLDS. */
  bloat?: BloatThresholds;
  /** Optional git window; when omitted the freshness ratio is N/A. */
  changedWindow?: ChangedFile[];
}

export interface AnalysisResult {
  coverage: CoverageReport;
  lint: LintFinding[];
  /** Count of in-scope source files on disk (the ownership denominator). */
  inScopeSourceCount: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function buildRatio(
  id: CoverageRatioId,
  label: string,
  numerator: number,
  denominator: number,
  detail?: Record<string, unknown>,
): CoverageRatio {
  const applicable = denominator > 0;
  return {
    id,
    label,
    numerator,
    denominator,
    ratio: applicable ? round2(numerator / denominator) : null,
    applicable,
    detail,
  };
}

/** Rolls applicable ratios into the equal-weight-average headline score. */
export function rollupScore(ratios: CoverageRatio[]): CoverageReport {
  const applicableRatios = ratios.filter((r) => r.applicable && r.ratio !== null);
  if (applicableRatios.length === 0) {
    return { ratios, score: null, percent: null, applicable: [] };
  }
  const sum = applicableRatios.reduce((acc, r) => acc + (r.ratio ?? 0), 0);
  const score = round2(sum / applicableRatios.length);
  return {
    ratios,
    score,
    percent: Math.round(score * 100),
    applicable: applicableRatios.map((r) => r.id),
  };
}

/**
 * Deterministic registry/docs analysis over the v2 model. Pure function of repo
 * state (filesystem + registry + optional injected git window): no wall clock,
 * no randomness, fully sorted traversal. Returns two separate channels —
 * scored coverage ratios and lint warnings — never blended into one number.
 */
export function analyze(input: AnalyzeInput): AnalysisResult {
  const {
    root,
    registry,
    exclusion = DEFAULT_EXCLUSION_SPEC,
    highFanoutThreshold = 3,
    bloat = DEFAULT_BLOAT_THRESHOLDS,
    changedWindow,
  } = input;
  const srcDir =
    input.srcDir ?? (existsSync(join(root, "src")) ? "src" : ".");

  const entries = Object.entries(registry.features).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  // Git-ignored trees (generated/build/vendored output) are never hand-maintained
  // source, so they must not inflate the coverage denominator. Non-git roots get a
  // no-op predicate and fall back to the static exclusion spec alone.
  const isIgnored = makeIgnoredPredicate(listIgnoredPaths(root));
  const inScopeFiles = discoverSourceFiles(root, srcDir, exclusion, isIgnored);
  const inScopeSet = new Set(inScopeFiles);

  // Map every source path to the entries that claim it (for ownership + fanout).
  const fileToFeatures = new Map<string, string[]>();
  for (const [key, entry] of entries) {
    for (const source of allSources(entry)) {
      const list = fileToFeatures.get(source) ?? [];
      if (!list.includes(key)) list.push(key);
      fileToFeatures.set(source, list);
    }
  }

  const coverage = computeCoverage(
    root,
    entries,
    inScopeFiles,
    inScopeSet,
    fileToFeatures,
    exclusion,
    changedWindow,
  );
  const lint = computeLint(
    root,
    entries,
    inScopeFiles,
    fileToFeatures,
    exclusion,
    highFanoutThreshold,
    bloat,
  );

  return { coverage, lint, inScopeSourceCount: inScopeFiles.length };
}

function computeCoverage(
  root: string,
  entries: [string, RegistryEntry][],
  inScopeFiles: string[],
  inScopeSet: Set<string>,
  fileToFeatures: Map<string, string[]>,
  exclusion: ExclusionSpec,
  changedWindow: ChangedFile[] | undefined,
): CoverageReport {
  // ownership: in-scope source files that have a documented owner. The numerator
  // counts a file only if it is itself in-scope, so generated/test paths listed
  // in some entry's sources cannot inflate it.
  const ownedInScope = inScopeFiles.filter((file) => fileToFeatures.has(file));
  const unowned = inScopeFiles.filter((file) => !fileToFeatures.has(file));
  const ownership = buildRatio(
    "ownership",
    "ownership (in-scope files with a documented owner)",
    ownedInScope.length,
    inScopeFiles.length,
    { unowned },
  );

  // dependency: mature entries (own ≥1 in-scope source, status not planned) that
  // declare at least one dependency.
  const matureEntries = entries.filter(
    ([, entry]) =>
      isMatureEntry(entry) &&
      allSources(entry).some((s) => isSourceFile(s, exclusion)),
  );
  const withDeps = matureEntries.filter(([, e]) => e.depends_on.length > 0);
  const dependency = buildRatio(
    "dependency",
    "dependency (mature entries declaring depends_on)",
    withDeps.length,
    matureEntries.length,
  );

  // risk: declared high-risk areas (non-empty risk) that carry a durable doc.
  const riskEntries = entries.filter(([, e]) => e.risk.length > 0);
  const riskCovered = riskEntries.filter(
    ([, e]) => e.docs.length > 0 || existsSync(join(root, e.doc)),
  );
  const risk = buildRatio(
    "risk",
    "risk (declared high-risk areas with a durable doc)",
    riskCovered.length,
    riskEntries.length,
    { areas: riskEntries.map(([key]) => key) },
  );

  // freshness/drift: recently changed in-scope source files whose mapped doc also
  // changed within the same repo-state window. N/A without an injected window.
  let freshness: CoverageRatio;
  if (changedWindow === undefined) {
    freshness = buildRatio("freshness", "freshness/drift (N/A: no git window)", 0, 0);
  } else {
    const changedInScope = changedWindow.filter((c) => inScopeSet.has(c.file));
    const fresh = changedInScope.filter((c) => c.mappedDocChanged);
    freshness = buildRatio(
      "freshness",
      "freshness/drift (changed sources whose docs changed too)",
      fresh.length,
      changedInScope.length,
    );
  }

  const ratios = [ownership, freshness, dependency, risk];
  return rollupScore(ratios);
}

function computeLint(
  root: string,
  entries: [string, RegistryEntry][],
  inScopeFiles: string[],
  fileToFeatures: Map<string, string[]>,
  exclusion: ExclusionSpec,
  highFanoutThreshold: number,
  bloat: BloatThresholds,
): LintFinding[] {
  const findings: LintFinding[] = [];

  for (const [key, entry] of entries) {
    // missing mapped source files
    for (const source of allSources(entry)) {
      if (!existsSync(join(root, source))) {
        findings.push({
          id: "missing-source",
          severity: "warn",
          feature: key,
          file: source,
          message: `${key}: mapped source no longer exists: ${source}`,
        });
      }
    }

    // out-of-scope paths (build/generated/test/data) listed as source — the
    // exclusion spec, not the file's true nature, is what's asserted here: the
    // heuristic can match hand-authored data (e.g. *.seed.json), so the message
    // names the rule, not a claim that the file is generated.
    for (const source of allSources(entry)) {
      if (isExcluded(source, exclusion)) {
        findings.push({
          id: "generated-leakage",
          severity: "warn",
          feature: key,
          file: source,
          message: `${key}: out-of-scope file listed as source — matches an exclusion rule (build/generated/test/data, e.g. *.seed.json): ${source}`,
        });
      }
    }

    // missing docs
    if (!existsSync(join(root, entry.doc))) {
      findings.push({
        id: "missing-doc",
        severity: "warn",
        feature: key,
        file: entry.doc,
        message: `${key}: mapped doc does not exist: ${entry.doc}`,
      });
    }
    for (const doc of entry.docs) {
      if (!existsSync(join(root, doc))) {
        findings.push({
          id: "missing-doc",
          severity: "warn",
          feature: key,
          file: doc,
          message: `${key}: durable doc does not exist: ${doc}`,
        });
      }
    }

    // empty depends_on on mature entries
    const mature =
      isMatureEntry(entry) &&
      allSources(entry).some((s) => isSourceFile(s, exclusion));
    if (mature && entry.depends_on.length === 0) {
      findings.push({
        id: "empty-depends-on",
        severity: "warn",
        feature: key,
        message: `${key}: mature entry has empty depends_on`,
      });
    }
  }

  // high-fanout: a source mapped across many entries. Informational, never a
  // gap to clear — a file genuinely shared by many features (rules, shared
  // types, a root layout) is *supposed* to be mapped widely, and that wide
  // mapping is exactly what lets `review` flag every dependent when it changes.
  // Collapsing it to one owner to zero the count would sever that signal, so we
  // surface it as a note to review (is the breadth real?), not a finding to fix.
  for (const [file, features] of [...fileToFeatures.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (features.length >= highFanoutThreshold) {
      findings.push({
        id: "high-fanout",
        severity: "info",
        file,
        count: features.length,
        evidence: [...features].sort(),
        message: `${file}: mapped across ${features.length} entries`,
      });
    }
  }

  // unmapped in-scope source files on disk
  for (const file of inScopeFiles) {
    if (!fileToFeatures.has(file)) {
      findings.push({
        id: "unmapped-source",
        severity: "warn",
        file,
        message: `in-scope source not mapped to any entry: ${file}`,
      });
    }
  }

  // bloated docs (each distinct doc checked once)
  findings.push(...computeBloat(root, entries, bloat));

  return sortFindings(findings);
}

// Maps every distinct doc path to a representative owning feature, so a doc
// mapped by several entries is only checked (and reported) once.
function computeBloat(
  root: string,
  entries: [string, RegistryEntry][],
  bloat: BloatThresholds,
): LintFinding[] {
  const docToFeature = new Map<string, string>();
  for (const [key, entry] of entries) {
    for (const doc of [entry.doc, ...entry.docs]) {
      if (!doc.endsWith(".md")) continue;
      if (!docToFeature.has(doc)) docToFeature.set(doc, key);
    }
  }

  const findings: LintFinding[] = [];
  for (const doc of [...docToFeature.keys()].sort()) {
    const fullPath = join(root, doc);
    if (!existsSync(fullPath)) continue; // missing docs handled elsewhere
    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    const totalLines = lines.length;
    const completedItems = lines.filter((l) => /^\s*[-*]\s+\[x\]/i.test(l)).length;
    const { maxSectionLines, maxSectionTitle } = largestSection(lines);

    const signals: string[] = [];
    if (totalLines > bloat.wholeDocLines) {
      signals.push(`${totalLines} lines (> ${bloat.wholeDocLines})`);
    }
    if (maxSectionLines > bloat.sectionLines) {
      signals.push(
        `section "${maxSectionTitle}" is ${maxSectionLines} lines (> ${bloat.sectionLines})`,
      );
    }
    if (completedItems > bloat.completedLogItems) {
      signals.push(
        `${completedItems} completed-log items (> ${bloat.completedLogItems})`,
      );
    }
    if (signals.length === 0) continue;

    findings.push({
      id: "bloated-doc",
      severity: "warn",
      feature: docToFeature.get(doc),
      file: doc,
      count: signals.length,
      evidence: signals,
      message: `${doc}: bloated — ${signals.join("; ")}`,
    });
  }
  return findings;
}

// Largest heading-delimited section by line count, with its heading title.
function largestSection(lines: string[]): {
  maxSectionLines: number;
  maxSectionTitle: string;
} {
  let maxSectionLines = 0;
  let maxSectionTitle = "";
  let currentTitle = "(preamble)";
  let currentCount = 0;
  const flush = () => {
    if (currentCount > maxSectionLines) {
      maxSectionLines = currentCount;
      maxSectionTitle = currentTitle;
    }
  };
  for (const line of lines) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      currentTitle = heading[1].trim();
      currentCount = 0;
    } else {
      currentCount++;
    }
  }
  flush();
  return { maxSectionLines, maxSectionTitle };
}

const FINDING_ORDER: LintFindingId[] = [
  "missing-registry",
  "missing-source",
  "missing-doc",
  "generated-leakage",
  "high-fanout",
  "empty-depends-on",
  "bloated-doc",
  "unmapped-source",
];

function sortFindings(findings: LintFinding[]): LintFinding[] {
  return [...findings].sort((a, b) => {
    const byId = FINDING_ORDER.indexOf(a.id) - FINDING_ORDER.indexOf(b.id);
    if (byId !== 0) return byId;
    const af = `${a.feature ?? ""}::${a.file ?? ""}`;
    const bf = `${b.feature ?? ""}::${b.file ?? ""}`;
    return af < bf ? -1 : af > bf ? 1 : 0;
  });
}
