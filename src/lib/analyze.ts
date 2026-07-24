import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { readMetaSync, type ExcludeConfig } from "./codemod.js";
import {
  DEFAULT_EXCLUSION_SPEC,
  globToRegExp,
  isExcluded,
  isSourceFile,
  toPosix,
  type ExclusionSpec,
} from "./exclusion-spec.js";
import { adapterFor, isPreciseFile } from "./fingerprint.js";
import { listIgnoredPaths } from "./git.js";
import { analyzeProseAltitude } from "./prose-altitude.js";
import {
  allSources,
  isMatureEntry,
  type Registry,
  type RegistryEntry,
} from "./registry.js";
import { StateFileError } from "./state-io.js";
import { TreeSitterError } from "./tree-sitter.js";
import { MODULE_ANCHOR_NAME } from "./ts-adapter.js";

export {
  DEFAULT_EXCLUSION_SPEC,
  globToRegExp,
  isExcluded,
  isSourceFile,
  toPosix,
  type ExclusionSpec,
} from "./exclusion-spec.js";

/**
 * The spec a command should actually run with: the built-in defaults widened by
 * the project's own `exclude` block. Additive by construction — config can only
 * add to `dirs`/`globs`, never remove a default and never touch `extensions`
 * (the extension list is the language matrix's truth, so config cannot make
 * codument claim support it does not have).
 *
 * Call it once at a command's entry point and pass the result down; the pure
 * helpers keep their default parameter, so library callers and tests that do not
 * care about project config are unaffected.
 */
export async function resolveExclusionSpec(root: string): Promise<ExclusionSpec> {
  return (await resolveScope(root)).spec;
}

/**
 * The resolved spec together with the additions that produced it, from a single
 * read — a caller that both applies the spec and reports what the project
 * declared (doctor prints the line and emits the JSON field in one run) would
 * otherwise parse and validate the same file twice.
 */
export interface ResolvedScope {
  spec: ExclusionSpec;
  /** The additions the project declared, or null when it declared none. */
  configured: ExcludeConfig | null;
  /** Set when the metadata could not be read at all, so a declaration may exist
   *  and be missing from `spec`. Absent means the answer is complete. */
  unreadable?: string;
}

export async function resolveScope(root: string): Promise<ResolvedScope> {
  return resolveScopeSync(root);
}

/** The same resolution for callers that cannot await (the editor nudge hook). */
export function resolveScopeSync(root: string): ResolvedScope {
  let configured: ExcludeConfig | undefined;
  let unreadable: string | undefined;
  try {
    configured = readMetaSync(root)?.exclude;
  } catch (err) {
    // Two different failures, two different answers. A file that PARSES but
    // declares something invalid is the user having said a wrong thing: it
    // propagates, because quietly scoring over the defaults would score over a
    // scope they explicitly narrowed. A file that does not parse at all says
    // nothing about whether a declaration exists, so it degrades to the defaults
    // and reports that it could not tell — the same unknown-is-not-empty rule
    // the git scope layer follows, and it keeps an advisory surface from
    // crashing on a file it only needed to peek at.
    if (!(err instanceof StateFileError)) throw err;
    unreadable = `${err.path} is unreadable, so a declared scope could not be read`;
  }
  const dirs = configured?.dirs ?? [];
  const globs = configured?.globs ?? [];
  // Every returned array is freshly built, never the default's own. Handing back
  // a shared array would let one caller's in-place edit rewrite the spec for the
  // rest of the process — a determinism hole that no test could localize.
  const union = (base: string[], extra: string[]): string[] =>
    extra.length > 0 ? [...new Set([...base, ...extra])].sort() : [...base];
  return {
    spec: {
      dirs: union(DEFAULT_EXCLUSION_SPEC.dirs, dirs),
      globs: union(DEFAULT_EXCLUSION_SPEC.globs, globs),
      // Config can never widen the extension list: that list is the language
      // matrix's truth, and letting a project add to it would let codument claim
      // support for a language it has no adapter for.
      extensions: [...DEFAULT_EXCLUSION_SPEC.extensions],
    },
    configured: dirs.length + globs.length > 0 ? { dirs, globs } : null,
    ...(unreadable === undefined ? {} : { unreadable }),
  };
}

/** The configured additions actually in effect, for surfacing to the user. */
export async function configuredExclusions(root: string): Promise<ExcludeConfig | null> {
  return (await resolveScope(root)).configured;
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

export type CoverageRatioId = "ownership" | "dependency" | "risk";

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

// ── Lint findings ───────────────────────────────────────────────────────

export type LintFindingId =
  | "missing-registry"
  | "missing-source"
  | "missing-doc"
  | "generated-leakage"
  | "high-fanout"
  | "empty-depends-on"
  | "dangling-depends-on"
  | "bloated-doc"
  | "unmapped-source"
  | "under-decomposed"
  | "over-decomposed"
  | "thin-doc"
  | "link-rot"
  | "orphan-doc"
  | "symbol-mirror"
  | "line-anchor"
  | "path-enumeration";

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
  /** Set by the caller when the project's declaration could not be read, so
   *  `exclusion` may be narrower than the project asked for. Travels out on
   *  `scope` rather than being inferred here — the resolution happens at the
   *  entry point, and only the entry point knows whether it was complete. */
  declaredScopeUnreadable?: string;
  /** The project's declared additions, for reporting alongside the score. */
  declaredExclusions?: ExcludeConfig | null;
  /** Distinct-entry count at which a mapped file is flagged high-fanout. */
  highFanoutThreshold?: number;
  /** Doc-bloat thresholds; defaults to DEFAULT_BLOAT_THRESHOLDS. */
  bloat?: BloatThresholds;
}

/**
 * Whether the denominator this analysis scored was computed against git's real
 * ignore rules, or against the static exclusion spec alone because those rules
 * could not be determined.
 *
 * A score is only as trustworthy as the scope it was computed over. When the
 * ignore set is unavailable, generated and build output can enter the
 * denominator as first-party source, and — because such files inflate the
 * numerator and denominator together once mapped — the resulting percentage can
 * read HIGHER than the truth. So "unavailable" must travel with the number
 * rather than being silently absorbed into it.
 */
export interface ScopeConfidence {
  gitIgnore: "applied" | "unavailable";
  /** Why the ignore rules could not be determined; absent when applied. */
  reason?: string;
  /** Set when the project's own declaration could not be read, so the scope may
   *  be wider than the project asked for. The second way a scored scope can be
   *  unverified, reported the same way as the first: never inferred as "nothing
   *  was declared". */
  declaredScope?: string;
  /** The project's own exclusion additions, when it declared any. A denominator
   *  narrowed by a project decision is reported alongside the score, because a
   *  reader comparing two repositories' numbers is comparing two scopes. */
  configuredExclusions?: ExcludeConfig;
  /** Member-repository prefixes when the root is a workspace of nested repos, so
   *  the score is read as an aggregate over several repositories rather than one.
   *  Absent for a plain single repository. */
  members?: string[];
}

export interface AnalysisResult {
  coverage: CoverageReport;
  lint: LintFinding[];
  /** Count of in-scope source files on disk (the ownership denominator). */
  inScopeSourceCount: number;
  /** How much of the scope this result was computed over was actually verified. */
  scope: ScopeConfidence;
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
    declaredScopeUnreadable,
    declaredExclusions,
    highFanoutThreshold = 3,
    bloat = DEFAULT_BLOAT_THRESHOLDS,
  } = input;
  const srcDir =
    input.srcDir ?? (existsSync(join(root, "src")) ? "src" : ".");

  const entries = Object.entries(registry.features).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  // Git-ignored trees (generated/build/vendored output) are never hand-maintained
  // source, so they must not inflate the coverage denominator. When git cannot
  // determine the ignore set at all, the denominator falls back to the static
  // exclusion spec alone — a strictly wider scope that may count build output as
  // first-party source. That fallback is a deliberate choice made here, and it
  // travels out on `scope` so the surfaces reporting the number can disclose that
  // it was computed over an unverified scope.
  const ignoredListing = listIgnoredPaths(root);
  const isIgnored = makeIgnoredPredicate(
    ignoredListing.ok ? ignoredListing.paths : [],
  );
  const inScopeFiles = discoverSourceFiles(root, srcDir, exclusion, isIgnored);

  // Map every source path to the entries that claim it (for ownership + fanout).
  const fileToFeatures = new Map<string, string[]>();
  for (const [key, entry] of entries) {
    for (const source of allSources(entry)) {
      const list = fileToFeatures.get(source) ?? [];
      if (!list.includes(key)) list.push(key);
      fileToFeatures.set(source, list);
    }
  }

  // Entries that some other entry depends on. An entry others build on is a
  // foundation layer: it legitimately depends on nothing, so empty depends_on
  // is the expected state for it, not a gap. Both the dependency ratio and the
  // empty-depends-on lint use this to avoid penalizing a true foundation.
  const dependedUpon = new Set<string>();
  for (const [, entry] of entries) {
    for (const dep of entry.depends_on) dependedUpon.add(dep);
  }

  const coverage = computeCoverage(
    root,
    entries,
    inScopeFiles,
    fileToFeatures,
    exclusion,
    dependedUpon,
  );
  const lint = computeLint(
    root,
    entries,
    inScopeFiles,
    fileToFeatures,
    exclusion,
    highFanoutThreshold,
    bloat,
    dependedUpon,
    isIgnored,
    declaredExclusions ?? null,
  );

  return {
    coverage,
    lint,
    inScopeSourceCount: inScopeFiles.length,
    scope: {
      ...(ignoredListing.ok
        ? { gitIgnore: "applied" as const }
        : { gitIgnore: "unavailable" as const, reason: ignoredListing.reason }),
      ...(declaredScopeUnreadable === undefined
        ? {}
        : { declaredScope: declaredScopeUnreadable }),
      ...(declaredExclusions ? { configuredExclusions: declaredExclusions } : {}),
    },
  };
}

function computeCoverage(
  root: string,
  entries: [string, RegistryEntry][],
  inScopeFiles: string[],
  fileToFeatures: Map<string, string[]>,
  exclusion: ExclusionSpec,
  dependedUpon: Set<string>,
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
  // declare at least one dependency. A foundation entry — one other entries
  // depend on that itself declares nothing — has no deps to declare, so it is a
  // vacuous case excluded from the ratio entirely (like a zero denominator),
  // never counted as a miss that drags the score down. A `needs-review` scaffold
  // is in-flight, not a miss (a fresh scan must not open at a 0% ratio), and a
  // `depends_on_confirmed` reviewed leaf has answered the question — both step
  // out of the ratio the same vacuous way.
  const matureEntries = entries.filter(
    ([, entry]) =>
      isMatureEntry(entry) &&
      entry.status !== "needs-review" &&
      allSources(entry).some((s) => isSourceFile(s, exclusion)),
  );
  const dependencyEntries = matureEntries.filter(
    ([key, e]) =>
      !(e.depends_on.length === 0 && (dependedUpon.has(key) || e.depends_on_confirmed === true)),
  );
  const withDeps = dependencyEntries.filter(([, e]) => e.depends_on.length > 0);
  const dependency = buildRatio(
    "dependency",
    "dependency (mature entries declaring depends_on)",
    withDeps.length,
    dependencyEntries.length,
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

  // NOTE: freshness/drift is intentionally not a coverage ratio. It is being
  // re-sourced from the unified two-ref signal (the freshness gate); until that
  // lands, coverage scores only the repo-state axes (ownership, dependency, risk).
  const ratios = [ownership, dependency, risk];
  return rollupScore(ratios);
}

/** Which of the project's own declared rules covers a path, if any. */
function declaredRuleFor(relPath: string, declared: ExcludeConfig | null): string | null {
  if (!declared) return null;
  const posix = toPosix(relPath);
  const dir = declared.dirs?.find((d) => posix.split("/").includes(d));
  if (dir) return `dirs: ${dir}`;
  const glob = declared.globs?.find((g) => globToRegExp(g).test(posix));
  return glob ? `globs: ${glob}` : null;
}

function computeLint(
  root: string,
  entries: [string, RegistryEntry][],
  inScopeFiles: string[],
  fileToFeatures: Map<string, string[]>,
  exclusion: ExclusionSpec,
  highFanoutThreshold: number,
  bloat: BloatThresholds,
  dependedUpon: Set<string>,
  isIgnored: (relPosixPath: string) => boolean,
  declared: ExcludeConfig | null,
): LintFinding[] {
  const findings: LintFinding[] = [];
  const entryKeys = new Set(entries.map(([key]) => key));

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
    // Two independent rules can put a file out of scope, and the evidence names
    // which one fired. Git's own ignore set is the stronger signal — the repo
    // itself declared the file not worth tracking — and it was previously
    // invisible here: the predicate was computed for the coverage denominator
    // and never handed to the lint, so a registry full of gitignored build
    // output produced "Lint: no findings". The one check that could have caught
    // the leak had the answer in scope and did not look.
    for (const source of allSources(entry)) {
      if (isIgnored(source)) {
        findings.push({
          id: "generated-leakage",
          severity: "warn",
          feature: key,
          file: source,
          message: `${key}: git-ignored file listed as source — the repository ignores it, so it is build/generated output, not documented source: ${source}`,
        });
      } else if (isExcluded(source, exclusion)) {
        findings.push({
          id: "generated-leakage",
          severity: "warn",
          feature: key,
          file: source,
          // Name WHICH rule fired. A project's own declaration and a built-in
          // heuristic call for different responses — one is "you declared this,
          // un-map it or narrow your declaration", the other is "codument's
          // guess may be wrong about your file" — and the generic wording sent
          // both to the same dead end.
          message: declaredRuleFor(source, declared)
            ? `${key}: declared out-of-scope file listed as source — the project's own \`exclude\` (${declaredRuleFor(source, declared)}) covers it, so it cannot be documented source too: ${source}`
            : `${key}: out-of-scope file listed as source — matches a built-in exclusion rule (build/generated/test/data, e.g. *.seed.json): ${source}`,
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
    } else if (
      // thin doc: a doc claimed done (status "current") that exists but isn't
      // actually narrated — no orientation layer. A scaffold or in-flight doc
      // (needs-review / draft / in-progress) is exempt; this catches a stub
      // passed as current, the "half-documented reads green" hole the freshness
      // gate cannot see.
      (entry.doc.startsWith("docs/features/") ||
        entry.doc.startsWith("docs/concepts/")) &&
      entry.status === "current"
    ) {
      const content = readFileSync(join(root, entry.doc), "utf8");
      // Orientation can live under the standard "In plain terms" heading or the
      // older "Summary" one; a genuine stub has content under neither.
      const plain = sectionBody(content, "In plain terms");
      const summary = sectionBody(content, "Summary");
      const oriented = Boolean(plain) || Boolean(summary);
      if (!oriented) {
        findings.push({
          id: "thin-doc",
          severity: "info",
          feature: key,
          file: entry.doc,
          message: `${key}: doc has no narrated orientation layer (no "In plain terms"/"Summary" content — a stub passed as ${entry.status})`,
        });
      }
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

    // empty depends_on on mature entries — but only on an entry nothing depends
    // on. An entry others build on is a foundation layer, and a foundation
    // legitimately depends on nothing; the genuinely suspicious case is an
    // isolated mature entry (nothing depends on it and it depends on nothing) —
    // a probable wiring omission. Two honest exits: a `needs-review` scaffold is
    // in-flight, not a miss (same rationale as the thin-doc exemption — a fresh
    // scan must not warn about its own seconds-old scaffolds), and
    // `depends_on_confirmed` is the explicit reviewed-leaf clearance the
    // foundation exemption (which needs inward edges) can never give.
    const mature =
      isMatureEntry(entry) &&
      entry.status !== "needs-review" &&
      allSources(entry).some((s) => isSourceFile(s, exclusion));
    if (
      mature &&
      entry.depends_on.length === 0 &&
      !dependedUpon.has(key) &&
      entry.depends_on_confirmed !== true
    ) {
      findings.push({
        id: "empty-depends-on",
        severity: "warn",
        feature: key,
        message: `${key}: mature entry has empty depends_on`,
      });
    }

    // dangling depends_on: an edge into a slug no registry entry answers to.
    // The graph is load-bearing — review fans impact out along it and the
    // dependency ratio reads it — and its consumers drop an unresolvable edge
    // without a trace, so a dangling one silently weakens both. Always a warn:
    // the target is either unregistered (register it) or a typo (fix the slug).
    for (const dep of entry.depends_on) {
      if (!entryKeys.has(dep)) {
        findings.push({
          id: "dangling-depends-on",
          severity: "warn",
          feature: key,
          message: `${key}: depends_on names no registry entry: "${dep}"`,
          evidence: [dep],
        });
      }
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

  // ── Decomposition shape (info-only). The agent proposes the cut; we only flag
  // shape. A `warn` here would assert a semantic cut ("too big/small to be one
  // feature") and false-fire on a large cohesive feature, so these NEVER block a
  // clean result — they are awareness nudges keyed on structure, not judgments. ─
  const inScopeSet = new Set(inScopeFiles);
  const matureFeatures = entries.filter(([, e]) => e.type === "feature" && isMatureEntry(e));

  // Under-decomposition: the whole project resolves to a single dominant feature
  // (the "plinko collapse"). Cannot fire once ≥2 feature-type entries are mature,
  // so it never triggers on a normally-decomposed repo. `cohesive: true` mutes it.
  if (matureFeatures.length === 1 && inScopeFiles.length >= 4) {
    const [key, entry] = matureFeatures[0];
    if (!entry.cohesive) {
      const owned = entry.primary_sources.filter((s) => inScopeSet.has(s)).length;
      if (owned / inScopeFiles.length >= 0.8) {
        findings.push({
          id: "under-decomposed",
          severity: "info",
          feature: key,
          count: owned,
          message: `${key}: one feature owns ${owned} of ${inScopeFiles.length} in-scope files — the project resolves to a single feature (split it, or set "cohesive": true to mute)`,
        });
      }
    }
  }

  // Over-decomposition: a feature whose sole primary is a barrel/index/types file
  // — the only mechanically-safe over-split signal (whether a real 1-file feature
  // should fold is the agent's judgment, left to the concept channel).
  for (const [key, entry] of matureFeatures) {
    if (entry.primary_sources.length === 1 && isBarrelFile(entry.primary_sources[0])) {
      findings.push({
        id: "over-decomposed",
        severity: "info",
        feature: key,
        file: entry.primary_sources[0],
        message: `${key}: owns only a barrel/index file (${entry.primary_sources[0]}) — consider folding into its consumer or marking type: concept`,
      });
    }
  }

  // bloated docs (each distinct doc checked once)
  findings.push(...computeBloat(root, entries, bloat));

  // prose-altitude smells (info-only): a registered doc restating code mechanism.
  findings.push(...computeProseAltitude(root, entries));

  // dangling intra-repo links across the whole docs/ knowledge base
  findings.push(...computeLinkRot(root));

  // orphan docs: a feature/concept page no registry entry points at. Staleness
  // is keyed on the registry, so the gate structurally cannot cover an unowned
  // page — it rots silently no matter how load-bearing it reads. Info, not
  // warn: a deliberately registry-free page is legitimate, so the note asks
  // "own it or know why not" and never blocks a clean run.
  const ownedDocs = new Set<string>();
  for (const [, entry] of entries) {
    ownedDocs.add(entry.doc);
    for (const doc of entry.docs) ownedDocs.add(doc);
  }
  for (const docRel of listMarkdownDocs(root)) {
    if (!/^docs\/(features|concepts)\//.test(docRel)) continue;
    if (!ownedDocs.has(docRel)) {
      findings.push({
        id: "orphan-doc",
        severity: "info",
        file: docRel,
        message: `${docRel}: no registry entry points at this doc — the staleness gate cannot cover it`,
      });
    }
  }

  return sortFindings(findings);
}

/** Text under `## <heading>` up to the next `## ` (or EOF), with HTML comments
 *  and surrounding whitespace stripped. null when the heading is absent. */
function sectionBody(content: string, heading: string): string | null {
  const lines = content.split("\n");
  const want = `## ${heading}`;
  const start = lines.findIndex((l) => l.trim() === want);
  if (start < 0) return null;
  const body: string[] = [];
  for (let j = start + 1; j < lines.length; j++) {
    if (/^##\s/.test(lines[j])) break;
    body.push(lines[j]);
  }
  return body.join("\n").replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** Every `.md` file under `docs/`, sorted, repo-relative. */
function listMarkdownDocs(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith(".md")) out.push(child);
    }
  };
  walk("docs");
  return out;
}

/** Drop fenced and inline code so example links in prose never false-fire. */
function stripCode(content: string): string {
  return content.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

/** Resolve a markdown link target to a repo-relative path, or null when it is
 *  external, a pure anchor, or otherwise not an in-repo file reference. */
function resolveDocLink(target: string, docDir: string): string | null {
  const t = target.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("#")) return null;
  const hash = t.indexOf("#");
  const path = (hash >= 0 ? t.slice(0, hash) : t).trim();
  if (!path) return null;
  return join(docDir, path);
}

/** Flag intra-repo links (markdown + `[[wikilink]]`) whose target does not
 *  exist on disk. Deterministic, file-existence only; anchors are not resolved. */
function computeLinkRot(root: string): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const docRel of listMarkdownDocs(root)) {
    let content: string;
    try {
      content = readFileSync(join(root, docRel), "utf8");
    } catch {
      continue;
    }
    const scan = stripCode(content);
    const slash = docRel.lastIndexOf("/");
    const docDir = slash >= 0 ? docRel.slice(0, slash) : "";

    // The destination allows balanced one-level parens so a route-group path
    // (`app/(tabs)/x.tsx`, common in Expo/Next) is captured whole rather than
    // truncated at the inner `)` and then misreported as dangling.
    for (const m of scan.matchAll(/\[[^\]]*\]\(((?:[^()\s]|\([^()]*\))+)[^)]*\)/g)) {
      const rel = resolveDocLink(m[1], docDir);
      if (rel && !existsSync(join(root, rel))) {
        findings.push({
          id: "link-rot",
          severity: "warn",
          file: docRel,
          message: `${docRel}: dangling link to ${m[1]}`,
        });
      }
    }

    for (const m of scan.matchAll(/\[\[([^\]\n|]+)\]\]/g)) {
      const slug = m[1].trim();
      if (
        !existsSync(join(root, `docs/features/${slug}.md`)) &&
        !existsSync(join(root, `docs/concepts/${slug}.md`))
      ) {
        findings.push({
          id: "link-rot",
          severity: "warn",
          file: docRel,
          message: `${docRel}: dangling wikilink [[${slug}]] (no matching feature or concept doc)`,
        });
      }
    }
  }
  return findings;
}

/** A pure re-export / index / types module — the only over-decomposition signal
 *  safe to assert deterministically. */
function isBarrelFile(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  // `.d.ts` is intentionally excluded: `generated-leakage` already fires a `warn`
  // for a declaration file listed as a source, so adding an `over-decomposed`
  // info on top would just misdirect from the real (leakage) problem.
  return /^(index|types|barrel)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(base);
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

// Prose-altitude smells over each registered feature/concept doc, rendered info-only
// (Notes channel, never a warn, never a --strict fail). Reads each doc once and the
// exported identifier names of its primary sources (for the symbol-mirror heuristic);
// the pure heuristics live in prose-altitude.ts.
function computeProseAltitude(root: string, entries: [string, RegistryEntry][]): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const [key, entry] of entries) {
    const doc = entry.doc;
    if (!doc.endsWith(".md")) continue;
    if (!(doc.startsWith("docs/features/") || doc.startsWith("docs/concepts/"))) continue;
    const full = join(root, doc);
    if (!existsSync(full)) continue;
    let content: string;
    try {
      content = readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    const exportedSymbols = exportedSymbolsOf(root, entry.primary_sources);
    for (const f of analyzeProseAltitude({ feature: key, doc, content, exportedSymbols })) {
      findings.push({
        id: f.id,
        severity: "info",
        feature: f.feature,
        file: f.doc,
        message: `${f.doc}:${f.line}: ${f.message}`,
        evidence: [f.evidence],
      });
    }
  }
  return findings;
}

// The exported identifier names of a set of source paths (precise TS files only; the
// coarse adapter yields only a file basename, no symbols). The `<module>` residual
// backstop is not a real symbol and is dropped.
function exportedSymbolsOf(root: string, sources: string[]): string[] {
  const names = new Set<string>();
  for (const src of sources) {
    if (!isPreciseFile(src)) continue;
    const full = join(root, src);
    if (!existsSync(full)) continue;
    let content: string;
    try {
      content = readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    // A malformed source is not doctor's problem to crash on — the symbol-mirror
    // heuristic simply has no names to check for that file (fail-safe, info-only).
    // A COLD adapter is different: that is a command-layer wiring bug, and
    // swallowing it here would blind the heuristic for a whole language with
    // zero signal — loud, never silent.
    try {
      for (const anchor of adapterFor(src).anchors(src, content)) {
        if (anchor.name !== MODULE_ANCHOR_NAME) names.add(anchor.name);
      }
    } catch (err) {
      if (err instanceof TreeSitterError) throw err;
      // skip this source's symbols
    }
  }
  return [...names];
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

export const FINDING_ORDER: LintFindingId[] = [
  "missing-registry",
  "missing-source",
  "missing-doc",
  "generated-leakage",
  "high-fanout",
  "empty-depends-on",
  "dangling-depends-on",
  "bloated-doc",
  "unmapped-source",
  "under-decomposed",
  "over-decomposed",
  "thin-doc",
  "link-rot",
  "orphan-doc",
  "symbol-mirror",
  "line-anchor",
  "path-enumeration",
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
