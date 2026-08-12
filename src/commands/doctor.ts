import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { atomicWriteFileSync } from "../lib/events.js";
import { LANGUAGE_MATRIX, warmAdaptersForRepo } from "../lib/fingerprint.js";
import {
  assertRootIsRepoToplevel,
  getWorkingTreeChanges,
  getWorkingTreeDeletions,
  getWorkingTreeRenames,
  isGitRepo,
  resolveWorkspace,
} from "../lib/git.js";
import { GateError } from "../lib/two-ref.js";
import { versionSkewNotice } from "../lib/version.js";
import { normalizeRelPath, readRegistrySync } from "../lib/registry.js";
import { renderCoverageBadge } from "../lib/badge.js";
import {
  analyze,
  DEFAULT_BLOAT_THRESHOLDS,
  type BloatThresholds,
  type CoverageRatio,
  type CoverageReport,
  type LintFinding,
  resolveScopeSync,
  type ResolvedScope,
  type ScopeConfidence,
} from "../lib/analyze.js";
import {
  honestyRatio,
  type InvariantCheckReport,
  type InvariantResult,
  type InvariantVerdict,
  runInvariantCheck,
} from "../lib/invariant-check.js";
import {
  confirmCondition,
  defaultCommandAvailable,
  resolveTestCommand,
} from "../lib/review-confirm.js";

interface DoctorOptions {
  root?: string;
  json?: boolean;
  write?: boolean;
  /** Clear the judgment-free findings and print what was deliberately left. */
  fix?: boolean;
  strict?: boolean;
  verifyInvariants?: boolean;
  testCommand?: string[];
  maxDocLines?: string | number;
  maxSectionLines?: string | number;
  maxCompletedLog?: string | number;
  highFanout?: string | number;
}

// The versioned `--json` block for `--verify-invariants` — present ONLY when the
// mode is on, so bare `doctor --json` stays byte-identical to before this plan.
export interface InvariantJson {
  version: 1;
  enforced: number;
  scored: number;
  /** enforced / scored, or null when nothing is scorable (zero-denominator rule). */
  ratio: number | null;
  results: InvariantResult[];
}

export function invariantJson(report: InvariantCheckReport): InvariantJson {
  return {
    version: 1,
    enforced: report.enforced,
    scored: report.scored,
    ratio: honestyRatio(report),
    results: report.results,
  };
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
  atomicWriteFileSync(jsonPath, JSON.stringify(artifact, null, 2) + "\n");
  atomicWriteFileSync(svgPath, renderCoverageBadge(report.coverage.percent));
  return { jsonPath, svgPath };
}

interface ReportOptions {
  bloat?: Partial<BloatThresholds>;
  highFanoutThreshold?: number;
  /** A scope this caller already resolved, to keep one run to one read. */
  scope?: ResolvedScope;
}

// Stable machine contract consumed by CI, the badge, and a future GUI.
export interface DoctorReport {
  version: 1;
  registryExists: boolean;
  inScopeSourceCount: number;
  coverage: CoverageReport;
  /** Whether the scored denominator was computed over a verified scope. Additive
   *  to the v1 contract: consumers that ignore it read exactly what they did. */
  scope: ScopeConfidence;
  lint: {
    // Actionable warnings only — a clean registry has count === 0. Informational
    // notes (e.g. high-fanout) are kept out of this number so "clean" can never
    // be reached by degrading the registry to silence an awareness-only signal.
    count: number;
    byId: Record<string, number>;
    findings: LintFinding[];
    /** Awareness-only findings (severity "info"). Never block clean. */
    notes: LintFinding[];
    /**
     * The split between what this repo state just produced and what it arrived with.
     *
     * Seventy findings on a maintained repo reads as a surface that cries wolf, but
     * the cause is upgrade debt rather than calibration: every lint added since a
     * project adopted retroactively finds old violations, so the count climbs on
     * upgrade even when the repo has not moved. The consequence is what matters —
     * sixty-nine inherited findings and the one this change just created rendered
     * identically, so the loop's only whole-repo health surface was unreadable at
     * exactly the moment it had something new to say.
     *
     * Derived, never a baseline file: a finding is this change's when its subject
     * file is in the working tree's change set. No recorded baseline means no second
     * source of truth to rot. Null when there is no repository to ask, which is
     * honestly different from "nothing here is new".
     */
    attribution: { fromThisChange: LintFinding[]; inherited: LintFinding[] } | null;
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
  // Resolved here by default; a caller that already resolved (watch's per-tick
  // refresh, which also builds a review) passes its result in so one run reads
  // the declaration once.
  const declaredScope = opts.scope ?? resolveScopeSync(root);
  const result = analyze({
    root,
    registry,
    bloat,
    exclusion: declaredScope.spec,
    declaredScopeUnreadable: declaredScope.unreadable,
    declaredExclusions: declaredScope.configured,
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

  // A workspace aggregates several repositories' scopes into one score; name the
  // members so the number is read as an aggregate, not one repo's. Resolved here
  // rather than in the pure analyzer, which must not touch git.
  const ws = resolveWorkspace(root);
  // The member walk is a third tree that can fail to open, and a member repo
  // hiding under an unreadable directory takes its ignore rules with it. Merge
  // into the one field, so the user reads a single "could not read" list rather
  // than learning which of our internal walks tripped.
  const unreadableDirs = [
    ...new Set([...(result.scope.unreadableDirs ?? []), ...ws.unreadable]),
  ].sort();
  const scope: ScopeConfidence = {
    ...result.scope,
    ...(ws.isWorkspace ? { members: ws.members.map((m) => m.prefix || "<root>") } : {}),
    ...(unreadableDirs.length > 0 ? { unreadableDirs } : {}),
  };

  return {
    version: 1,
    registryExists,
    inScopeSourceCount: result.inScopeSourceCount,
    coverage: result.coverage,
    scope,
    lint: { count: findings.length, byId, findings, notes, attribution: attribute(root, findings) },
  };
}

/**
 * Which of these findings this repo state just produced.
 *
 * A finding is this change's when its own subject file is in the working tree's
 * change set — the tightest reading, and deliberately so. Attributing by FEATURE
 * would mark every pre-existing finding on a feature as new the moment someone edits
 * one of its files, which reproduces the unreadable pile it exists to fix, in the
 * other direction. A finding with no subject file has nothing to match and stays
 * inherited: over-attributing is the failure that costs, since the whole value of
 * the split is that the short list is trustworthy.
 *
 * The change set is the same one `review` scopes to — changes, deletions and a
 * rename's origin — because a `missing-source` finding about a path this change just
 * deleted is exactly the kind the reader must not lose in sixty-nine others. Fails
 * to null rather than to empty: no repository to ask is a different answer from
 * "nothing here is new", and reporting the second would be the unknown-is-not-empty
 * conflation this codebase refuses everywhere else.
 */
function attribute(
  root: string,
  findings: LintFinding[],
): { fromThisChange: LintFinding[]; inherited: LintFinding[] } | null {
  // Asked before the listers, because outside a repository they answer "nothing
  // changed" rather than refusing — and reporting every finding as inherited on the
  // strength of that would be the unknown-is-not-empty conflation, dressed as a fact.
  if (!isGitRepo(root)) return null;
  let touched: Set<string>;
  try {
    const renames = getWorkingTreeRenames(root);
    touched = new Set([
      ...getWorkingTreeChanges(root),
      ...getWorkingTreeDeletions(root),
      ...renames.map((r) => r.from),
    ]);
  } catch {
    return null;
  }
  const isNew = (f: LintFinding): boolean =>
    f.file !== undefined && touched.has(normalizeRelPath(f.file));
  return {
    fromThisChange: findings.filter(isNew),
    inherited: findings.filter((f) => !isNew(f)),
  };
}

/**
 * The findings `--fix` may clear without reading anyone's mind.
 *
 * Two of them, and the line between them and everything else is whether resolving
 * one requires a judgment. A registry entry naming a path that is not on disk is
 * simply false — dropping it restores an honest control plane and settles nothing
 * else. A declared tree that matches nothing is the same falsehood in pattern form.
 * Everything past that needs a decision an agent pointed at seventy findings will
 * fabricate: where a manifest belongs is what wakes, an unmapped file needs an owner,
 * and a doc-level finding invites compaction theater — plan 42's own finding, almost
 * word for word. Those are printed, never written.
 */
const FIXABLE = new Set<string>(["missing-source", "unmatched-pattern"]);

interface FixOutcome {
  /** `feature: path` pairs the fix removed from the registry. */
  removed: Array<{ feature: string; source: string; id: string }>;
  /** Findings it deliberately left, grouped by lint id with a count. */
  left: Array<{ id: string; count: number }>;
}

/**
 * Drop every registry source a fixable finding named, and report what was left alone.
 *
 * Reversible by construction: the only edit is removing a path from an entry's source
 * lists, which git shows as a diff like any other. It never adds, never re-points, and
 * never touches a doc — a fix that guessed at an intent would put the corruption INTO
 * the control plane, which is the state this whole surface exists to detect.
 */
function applyFix(root: string, findings: LintFinding[]): FixOutcome {
  const fixable = findings.filter((f) => FIXABLE.has(f.id) && f.feature && f.file);
  const left = new Map<string, number>();
  for (const f of findings) {
    if (fixable.includes(f)) continue;
    left.set(f.id, (left.get(f.id) ?? 0) + 1);
  }
  const outcome: FixOutcome = {
    removed: [],
    left: [...left.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  if (fixable.length === 0) return outcome;

  const registryPath = join(root, "docs", ".registry.json");
  const registry = readRegistrySync(registryPath);
  for (const f of fixable) {
    const entry = registry.features[f.feature as string];
    if (!entry) continue;
    const drop = normalizeRelPath(f.file as string);
    const keep = (list: string[]) => list.filter((s) => normalizeRelPath(s) !== drop);
    const before = entry.primary_sources.length + entry.related_sources.length;
    entry.primary_sources = keep(entry.primary_sources);
    entry.related_sources = keep(entry.related_sources);
    if (entry.primary_sources.length + entry.related_sources.length < before) {
      outcome.removed.push({ feature: f.feature as string, source: f.file as string, id: f.id });
    }
  }
  if (outcome.removed.length > 0) {
    atomicWriteFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  }
  return outcome;
}

function printFix(outcome: FixOutcome): void {
  console.log(pc.bold("codument doctor --fix"));
  console.log();
  if (outcome.removed.length === 0) {
    console.log(pc.dim("  Nothing mechanical to clear."));
  } else {
    console.log(`  ${pc.green("✓")} dropped ${outcome.removed.length} false registry pointer(s):`);
    for (const r of outcome.removed) {
      console.log(`      ${pc.dim(`${r.feature}:`)} ${r.source} ${pc.dim(`(${r.id})`)}`);
    }
  }
  // What it did NOT do, always, and with the count. A fix that clears part of a pile
  // and says nothing about the rest reads as having cleared the pile.
  if (outcome.left.length > 0) {
    const total = outcome.left.reduce((n, l) => n + l.count, 0);
    console.log();
    console.log(
      pc.dim(
        `  Left alone — ${total} finding(s) that need a decision, which is not this command's to make:`,
      ),
    );
    for (const l of outcome.left) console.log(`      ${pc.dim(`${l.id} × ${l.count}`)}`);
  }
  console.log();
}

function num(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export async function doctor(options: DoctorOptions = {}): Promise<void> {
  const root = options.root ?? process.cwd();
  // The prose-altitude heuristic extracts per-symbol names through the same
  // adapters as the gate; warm WASM grammars first or a whole language's
  // symbol-mirror nudge would be blind (a cold adapter is rethrown, not
  // swallowed, so this is load-bearing, not advisory).
  await warmAdaptersForRepo(root);
  // A subdirectory root is refused for the same reason the gate refuses it: the
  // rest of the toolchain rejects this root as wrong, and a health score
  // published for a root the gate refuses would let the two surfaces disagree.
  // Under --json the refusal is still machine-readable — a discriminated shape,
  // never human text a JSON consumer would crash on; the human path lets the
  // cli boundary render the GateError.
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
  const bloat: Partial<BloatThresholds> = {};
  const wholeDocLines = num(options.maxDocLines);
  const sectionLines = num(options.maxSectionLines);
  const completedLogItems = num(options.maxCompletedLog);
  if (wholeDocLines !== undefined) bloat.wholeDocLines = wholeDocLines;
  if (sectionLines !== undefined) bloat.sectionLines = sectionLines;
  if (completedLogItems !== undefined) bloat.completedLogItems = completedLogItems;

  const reportOpts = { bloat, highFanoutThreshold: num(options.highFanout) };
  // `--fix` runs BEFORE the report the rest of this command renders, so what a reader
  // sees afterwards is the state they are actually in — not the pile that existed a
  // moment ago with a note claiming some of it is gone.
  if (options.fix) {
    const outcome = applyFix(root, buildReport(root, reportOpts).lint.findings);
    if (!options.json) printFix(outcome);
  }
  const report = buildReport(root, reportOpts);

  // Opt-in, environment-touching mode: RUN each doc invariant's cited test. Off by
  // default so bare doctor stays instant, deterministic, and byte-identical. When
  // on, a broken or unpinned invariant is a warn-level result that --strict fails on.
  const resolvedTest = options.verifyInvariants
    ? resolveTestCommand(root, options.testCommand)
    : null;
  const invReport = options.verifyInvariants
    ? runInvariantCheck(
        root,
        readRegistrySync(join(root, "docs", ".registry.json")),
        resolvedTest?.command,
      )
    : null;
  // Built from the SAME helper the review gate uses, so a refused declaration and
  // an unadjudicated count can never be worded differently by the two consumers of
  // one runner. Reading only `.command` and dropping `.problem` is what let this
  // surface report "point your runner at TAP" when the declared runner was fine and
  // only its `{file}` slot was missing.
  const invCondition = invReport
    ? confirmCondition({
        problem: resolvedTest?.problem ?? null,
        unadjudicated: invReport.results.filter((r) => r.verdict === "unrunnable").length,
        noun: "invariant",
        consequence: "excluded from the score",
        defaultUnavailable: !resolvedTest?.command && !defaultCommandAvailable(root),
      })
    : null;

  // --strict is opt-in CI gating over what THIS change produced, never over what
  // the repo arrived with. `review` settled this argument already — inherited
  // registry rot is reported and never gated, "because a gate that fails on
  // inherited state is a gate people learn to bypass" — and doctor never got the
  // rule: a field repo failed on 105 findings while the same output labelled them
  // "nothing here gates anything", which makes the exit code unreadable and the
  // step one people learn to skip. Notes (info) are excluded by lint.count.
  // Invariant warns count only when --verify-invariants ran them.
  //
  // Attribution is null when there is no repository to ask, which is "cannot
  // tell" and never "nothing is new" — so the gate falls back to every finding
  // rather than to none. Fail closed: a green nobody earned is the one outcome
  // worse than a red nobody can clear.
  const gatingFindings = report.lint.attribution?.fromThisChange ?? report.lint.findings;
  const strictFail =
    !!options.strict && (gatingFindings.length > 0 || (invReport?.warnings.length ?? 0) > 0);

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
    // Spread the invariants block in ONLY when the mode ran, so bare doctor --json
    // is byte-identical to before this plan (the non-goal that keeps CI stable).
    const out = invReport
      ? {
          ...report,
          // Additive, and only in this opt-in mode: the machine surface carries the
          // same named condition the human one prints, so a CI consumer cannot read
          // an all-unrunnable run as a clean one.
          invariants: { ...invariantJson(invReport), confirmUnavailable: invCondition },
        }
      : report;
    console.log(JSON.stringify(out, null, 2));
    if (strictFail) process.exitCode = 1;
    return;
  }

  printHuman(report, strictFail, gatingFindings.length);
  if (invReport) printInvariants(invReport, !!options.strict, invCondition);
  // Advisory skew nudge — human output only, so the --json contract stays
  // byte-identical; never a finding, never an exit-code input.
  const skew = versionSkewNotice(root);
  if (skew) console.log(pc.dim(`  ${skew}`));
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

// `gatingCount` is required rather than defaulted: the strict line is suppressed
// when it is zero, so a default would let a future caller drop the failure
// explanation silently while the exit code still went red.
function printHuman(report: DoctorReport, strictFail: boolean, gatingCount: number): void {
  const { coverage, lint } = report;

  console.log(pc.bold("codument doctor"));
  console.log();

  if (report.scope.members) {
    console.log(
      pc.cyan(
        `  workspace: ${report.scope.members.length} member repositories (${report.scope.members.join(", ")}) — git scope aggregated`,
      ),
    );
    console.log();
  }

  const headline =
    coverage.percent === null ? pc.dim("N/A") : pc.bold(`${coverage.percent}%`);
  console.log(`  Documentation coverage: ${headline}`);
  for (const r of coverage.ratios) {
    console.log(ratioLine(r));
  }
  // A score is only as good as the scope it was computed over. When the ignore
  // rules could not be read, build output may sit in the denominator AS source —
  // and because mapped build output lifts numerator and denominator together, the
  // number can read better than the truth. Say so next to the number, or the
  // reader's only clue is a figure that looks unusually good.
  // Informational, not a warning: a plain non-git directory is a legitimate way
  // to use codument, not a misconfiguration. Yellow is this file's actionable-
  // finding colour and would read as "problem"; this is disclosure.
  if (report.scope.gitIgnore === "unavailable") {
    console.log(
      pc.cyan(
        `  note: ${report.scope.reason} — .gitignore rules were not applied, so this scope may include build output`,
      ),
    );
  }
  // A denominator narrowed by a project decision is not the same denominator as
  // the defaults, so the number never appears without what shaped it — otherwise
  // two repositories' scores look comparable when their scopes are not.
  const configured = report.scope.configuredExclusions;
  if (configured) {
    const parts: string[] = [];
    if (configured.dirs?.length) {
      parts.push(`${configured.dirs.length} dir(s): ${configured.dirs.join(", ")}`);
    }
    if (configured.globs?.length) {
      parts.push(`${configured.globs.length} glob(s): ${configured.globs.join(", ")}`);
    }
    console.log(
      pc.cyan(`  scope: also excluding ${parts.join(" · ")} — .codument-meta.json`),
    );
  }
  // The third way: a directory the walk could not read. Its files are missing
  // from the denominator, and a smaller denominator makes the percentage read
  // HIGHER than the truth — the same inversion as an undeterminable ignore set,
  // arriving by a different route.
  if (report.scope.unreadableDirs) {
    console.log(
      pc.cyan(
        `  note: ${report.scope.unreadableDirs.length} ${report.scope.unreadableDirs.length === 1 ? "directory" : "directories"} could not be read, so this scope is a floor, not the count: ${report.scope.unreadableDirs.join(", ")}`,
      ),
    );
  }
  // The second way a scope can be unverified: the project may have declared
  // exclusions this run could not read. Same disclosure, same reason — a widened
  // scope inflates both halves of the ratio, so the number reads better than the
  // truth exactly when it is least earned.
  if (report.scope.declaredScope) {
    console.log(
      pc.cyan(
        `  note: ${report.scope.declaredScope}, so this scope may be wider than the project declared`,
      ),
    );
  }
  // A scaffold is exempt from the dependency ratio and two lint rules so a fresh scan
  // does not open at 0%. That reasoning says "seconds old" and the code says "forever":
  // a field registry sat at `needs-review` for four months, outside every ratio,
  // reading as in-flight. Disclosure, never a finding — the exemption is right and the
  // silence about it was not, and a first run must still end green.
  if (coverage.scaffolded > 0 && coverage.scanLag !== null && coverage.scanLag !== 0) {
    const grew = coverage.scanLag > 0;
    console.log(
      pc.cyan(
        `  note: ${coverage.scaffolded} entr${coverage.scaffolded === 1 ? "y is" : "ies are"} still \`needs-review\` from a scan the tree has moved past (${Math.abs(coverage.scanLag)} source file(s) ${grew ? "added" : "removed"} since) — outside the dependency ratio until reviewed and set to \`current\``,
      ),
    );
  }
  // The same manifest the README matrix is parity-tested against — one truth.
  console.log(
    pc.dim(
      `  gate languages: ${LANGUAGE_MATRIX.map((r) => `${r.display} (${r.grain})`).join(" · ")}`,
    ),
  );
  console.log();

  const row = (f: LintFinding, indent = "    ") =>
    console.log(`${indent}${pc.yellow("⚠")} ${pc.dim(f.id.padEnd(17))} ${f.message}`);
  if (lint.count === 0) {
    console.log(`  ${pc.green("✓")} Lint: no findings`);
  } else if (lint.attribution === null || lint.attribution.fromThisChange.length === lint.count) {
    // No repository to attribute against, or everything here is this change's —
    // either way the split says nothing the flat list does not, so it is not drawn.
    console.log(`  Lint: ${pc.yellow(String(lint.count))} findings`);
    for (const finding of lint.findings) row(finding);
  } else {
    // What this repo state just produced leads, and what it arrived with follows
    // under its own heading. Rendering them identically is what made the whole
    // surface unreadable at the one moment it had something new to say — sixty-nine
    // inherited findings and the one that was just introduced, in one undifferentiated
    // list, on a surface the loop runs every step.
    const { fromThisChange, inherited } = lint.attribution;
    console.log(
      `  Lint: ${pc.yellow(String(lint.count))} findings ${pc.dim(
        `— ${fromThisChange.length} from this change, ${inherited.length} the repo arrived with`,
      )}`,
    );
    if (fromThisChange.length > 0) {
      console.log(`    ${pc.bold("From this change")}`);
      for (const finding of fromThisChange) row(finding, "      ");
    }
    console.log(`    ${pc.dim("Inherited — not this change; nothing here gates anything")}`);
    for (const finding of inherited) row(finding, "      ");
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
  // The lint-driven strict line. Invariant-driven strict (with no lint findings)
  // is reported by printInvariants instead, so this never says "0 findings failing".
  // The count named here is the one the exit code is derived from, never the
  // total — a line that fails on 105 while only 3 are this change's teaches the
  // reader that the number and the verdict are unrelated.
  if (strictFail && gatingCount > 0) {
    const inherited = report.lint.count - gatingCount;
    console.log(
      pc.red(
        `  Strict: ${gatingCount} finding${gatingCount === 1 ? "" : "s"} from this change, failing (exit 1).` +
          (inherited > 0 ? ` ${inherited} inherited — reported, never gated.` : "") +
          " Notes are awareness-only and never count.",
      ),
    );
  } else if (!strictFail) {
    console.log(
      pc.dim(
        report.lint.count > 0
          ? "  Findings are warnings, not failures — and --strict gates only on what this change produced. Notes are awareness-only. Neither changes the exit code."
          : "  Findings are warnings, not failures. Notes are awareness-only. Neither changes the exit code.",
      ),
    );
  }
}

// ── Invariant-check output (opt-in --verify-invariants) ──────────────────

const INVARIANT_STYLE: Record<InvariantVerdict, { sym: string; color: (s: string) => string }> = {
  green: { sym: pc.green("✓"), color: pc.green },
  "invariant-broken": { sym: pc.red("✗"), color: pc.red },
  "invariant-unpinned": { sym: pc.yellow("⚠"), color: pc.yellow },
  unrunnable: { sym: pc.cyan("ℹ"), color: pc.cyan },
  untested: { sym: pc.cyan("ℹ"), color: pc.dim },
  honest: { sym: pc.dim("·"), color: pc.dim },
};

const INVARIANT_ORDER: InvariantVerdict[] = [
  "invariant-broken",
  "invariant-unpinned",
  "unrunnable",
  "untested",
  "honest",
];

function printInvariants(
  report: InvariantCheckReport,
  strict: boolean,
  condition: string | null = null,
): void {
  console.log();
  console.log(
    `  ${pc.bold("Invariant checks")} ${pc.dim("(environment-dependent — runs each cited test)")}`,
  );
  if (report.results.length === 0) {
    console.log(`    ${pc.dim("no invariants found in registered docs")}`);
    return;
  }
  const ratio = honestyRatio(report);
  const ratioStr = ratio === null ? pc.dim("N/A") : pc.bold(`${Math.round(ratio * 100)}%`);
  console.log(`    ${report.enforced}/${report.scored} enforced  ${ratioStr}`);

  // The same honesty line the review gate prints, which this surface never had: an
  // unrunnable invariant is excluded from the score, so without it a project whose
  // runner emits no test evidence reads as "nothing to see" when nothing was
  // checked. Worded by the shared builder, never rebuilt here.
  if (condition) console.log(pc.yellow(`    ⚠ ${condition}`));

  const rank = (v: InvariantVerdict): number => INVARIANT_ORDER.indexOf(v);
  const nonGreen = report.results
    .filter((r) => r.verdict !== "green")
    .sort(
      (a, b) =>
        rank(a.verdict) - rank(b.verdict) ||
        (a.doc < b.doc ? -1 : a.doc > b.doc ? 1 : a.line - b.line),
    );
  if (nonGreen.length === 0) {
    console.log(`    ${pc.green("✓")} every cited invariant passes`);
  }
  for (const r of nonGreen) {
    const style = INVARIANT_STYLE[r.verdict];
    const detail = r.detail ? pc.dim(` — ${r.detail}`) : "";
    console.log(
      `    ${style.sym} ${style.color(r.verdict.padEnd(18))} ${pc.dim(`${r.doc}:${r.line}`)}  ${r.summary}${detail}`,
    );
  }

  const warnCount = report.warnings.length;
  if (strict && warnCount > 0) {
    console.log(
      pc.red(
        `    Strict: ${warnCount} invariant warning${warnCount === 1 ? "" : "s"} (broken/unpinned), failing (exit 1).`,
      ),
    );
  } else {
    console.log(
      pc.dim(
        "    Results depend on the local toolchain; unrunnable and honest boundaries never count against.",
      ),
    );
  }
}
