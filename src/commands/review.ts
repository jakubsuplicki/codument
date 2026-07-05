import { join, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";
import pc from "picocolors";
import { parseRegistryOrThrow, readRegistrySync, type Registry } from "../lib/registry.js";
import {
  computeChangeState,
  detectApprovedPlanScope,
  resolveFileGrainAcked,
  type ApprovedPlan,
  type ChangeState,
} from "../lib/change-state.js";
import {
  assertRootIsRepoToplevel,
  getWorkingTreeChanges,
  getWorkingTreeDeletions,
  isGitRepo,
  getHeadSha,
} from "../lib/git.js";
import {
  worktreeChangesSince,
  worktreeDeletionsSince,
  resolveBase,
  readBlobAtRef,
  refReachable,
  blobExistsAtRef,
  GateError,
  EMPTY_TREE_SHA,
} from "../lib/two-ref.js";
import { gatherAnchorChanges } from "../lib/fingerprint.js";
import { computeDrift, type DriftFinding } from "../lib/drift.js";
import { readAcks } from "../lib/acknowledgment.js";
import { emitCaught } from "../lib/review-events.js";
import {
  findCoveringReview,
  gatherReviewFingerprint,
  writeReview,
  parseReviewArtifact,
} from "../lib/review-artifact.js";
import { gatherReviewBundle } from "../lib/review-bundle.js";
import {
  evaluateReviewGate,
  countResolvedMovedSymbols,
  type ReviewGateResult,
} from "../lib/review-gate.js";
import {
  confirmFindings,
  defaultCommandAvailable,
  makeTestRunner,
  resolveTestPath,
  DEFAULT_TEST_SEARCH_DIRS,
} from "../lib/review-confirm.js";
import { isExcluded, DEFAULT_EXCLUSION_SPEC } from "../lib/analyze.js";
import { MODULE_ANCHOR_NAME } from "../lib/ts-adapter.js";
import { versionSkewNotice } from "../lib/version.js";

interface ReviewOptions {
  root?: string;
  json?: boolean;
  log?: boolean;
  strict?: boolean;
  /** Opt-in adversarial-review gate: exit 1 if a non-trivial diff lacks a current,
   *  fingerprint-bound review artifact (or one with unresolved confirmed findings).
   *  Default-on flip is soak-deferred, like the change-control gate's blocking flip. */
  requireReview?: boolean;
  /** Diff against the merge-base with this ref (the branch's drift since it
   *  diverged), not just the uncommitted working tree. */
  base?: string;
  /** Override the argv used to run a finding's named test (the literal `{file}`
   *  token is the resolved path). Defaults to codument's own `npx tsx --test`; a
   *  consumer project whose tests run differently sets this so the gate's
   *  re-confirmation step is not hardcoded to one toolchain. Accepts either real
   *  argv or a single whitespace-joined string (see `normalizeTestCommand`). */
  testCommand?: string[];
  /** Emit the adversarial-review BUNDLE (the oracle: touched features' invariants +
   *  their test pointers, the diff, ownership/blast facts) as JSON and exit. This is
   *  what an adversarial reviewer attacks; it adds no new source of truth. */
  bundle?: boolean;
  /** Record an adversarial review from a findings JSON file
   *  (`{invariantsChecked, findings, signer}`): the command computes the
   *  fingerprint over the current diff AND the findings' named tests and writes the
   *  artifact, so the writer and the `--require-review` gate share one fingerprint
   *  contract (an agent cannot hand-compute it). */
  record?: string;
}

// A test command can arrive as real argv (`["node","--test","{file}"]`) or, because
// commander's variadic `<argv...>` rejects a leading-dash value like `--test`, as a
// single quoted string the user passed to dodge that (`"node --test {file}"`). Split
// the single-string form on whitespace so `--test-command "npx tsx --test {file}"`
// works. Genuine multi-element argv (no leading-dash args) is passed through as-is.
export function normalizeTestCommand(command?: string[]): string[] | undefined {
  if (!command || command.length === 0) return undefined;
  if (command.length === 1 && /\s/.test(command[0])) {
    return command[0].trim().split(/\s+/);
  }
  return command;
}

export interface ReviewReport {
  version: 2;
  /** Discriminant: `"ok"` means the gate ran and this report is its verdict.
   *  The non-git `--json` output instead emits `{ gate: "unavailable", reason }`,
   *  so a consumer never has to interpret a null/absent `state` as "passed". */
  gate: "ok";
  isGitRepo: boolean;
  changedFileCount: number;
  /** Pure deletions in the change (any path kind) — counted in changedFileCount
   *  and consumed by the review fingerprint's real-change set. */
  deletions: string[];
  plan: ApprovedPlan | null;
  state: ChangeState;
  /** Per-symbol drift detail behind the verdict: which owned symbols moved, their
   *  co-movement telemetry, and which were cleared by a recorded acknowledgment. */
  drift: DriftFinding[];
  /** Files whose current content is covered by a file-grain ack (`codument ack
   *  <path>`) — the additive/concept/coarse staleness cleared this run. Surfaced so
   *  the resolution summary shows a file-ack AS an ack, never laundered as a doc
   *  update (over-acking stays visible). */
  fileGrainAcked: string[];
}

/** How a moved-owned-symbol drift finding was resolved (or not) — kept in one place
 *  so the human resolution line and the `--log` soak tally can never diverge. A
 *  file-grain ack is an ACK (no doc change owed), NOT a doc update, so it sits with
 *  `acked` on the friction side; a `changed` (moved) symbol is never file-acked. */
export type DriftResolution = "acked" | "file-acked" | "doc-updated" | "flagged";

export function driftResolution(
  finding: DriftFinding,
  staleFeatures: Set<string>,
  fileGrainAcked: Set<string>,
): DriftResolution {
  if (finding.acknowledged) return "acked";
  if (staleFeatures.has(finding.feature)) return "flagged";
  // Feature not stale and not symbol-acked → resolved. A file-grain ack over the
  // file resolves an ADDITIVE (added/removed) finding; a moved symbol never is.
  const sep = finding.anchorId.indexOf("::");
  const file = sep === -1 ? finding.anchorId : finding.anchorId.slice(0, sep);
  if (finding.kind !== "changed" && fileGrainAcked.has(file)) return "file-acked";
  return "doc-updated";
}

// The registry blob as of `ref`, for resolving what a DELETED file's ownership
// was while it still existed. Honestly-absent (no commits yet, or no registry at
// the ref) → undefined, and the caller falls back to the current registry; any
// OTHER failure is loud — a broken git read here must never quietly fall back,
// because the fallback is exactly what the registry-entry-removal dodge needs.
// Present-but-unparseable stays a loud RegistryError, same rule as the worktree.
function readRegistryAtRef(root: string, ref: string): Registry | undefined {
  // A repo with no commits yet has no base to read — an honest "no base
  // registry" (a genuinely bad --base already failed loud in resolveBase).
  if (!refReachable(root, ref)) return undefined;
  if (!blobExistsAtRef(root, ref, "docs/.registry.json")) return undefined;
  const raw = readBlobAtRef(root, ref, "docs/.registry.json");
  if (raw === null) {
    // Exists per ls-tree but unreadable per show: a broken git, not absence.
    throw new GateError(`could not read docs/.registry.json at ${ref}`, "git-failed");
  }
  return parseRegistryOrThrow(raw, `docs/.registry.json@${ref}`);
}

/**
 * Deterministic review report for the uncommitted working-tree diff. Pure given
 * the repo state (git changes + registry + approved plan). The same diff always
 * produces the same report — no clock, no randomness, sorted throughout.
 */
export function buildReview(
  root: string,
  changedFiles?: string[],
  baseRef = "HEAD",
  deletedFiles?: string[],
): ReviewReport {
  const registry = readRegistrySync(join(root, "docs", ".registry.json"));
  // Callers that already computed the working-tree changes (e.g. `watch`, which
  // also needs them for its activity tape) can pass them in to avoid a second
  // `git status` tree scan per refresh; default to computing them here.
  const changes = changedFiles ?? getWorkingTreeChanges(root);
  // Pure deletions are first-class: a deleted owned source must wake its doc
  // exactly like an edit would (the `--base` caller passes its own two-ref list).
  const deletions = deletedFiles ?? getWorkingTreeDeletions(root);
  const plan = detectApprovedPlanScope(root);
  // Per-symbol anchor diffs for the precise (TS) changed files, base ref vs the
  // working tree — this is what dissolves the shared-file cascade in the verdict.
  // Best-effort: coarse/non-TS files degrade to file-grain ownership; parse-error
  // files come back as `unevaluable` (gated file-grain AND surfaced).
  const { anchorChanges, unevaluable } = gatherAnchorChanges(root, baseRef, changes);
  const acks = readAcks(root);
  // Resolve per-symbol drift + acknowledgments: an acked move is adjudicated (a
  // recorded "refactor, no doc change owed" decision) and dropped from the set the
  // stale-doc verdict sees; co-movement is attached as info-only telemetry.
  const { findings: drift, filtered } = computeDrift(
    root,
    baseRef,
    registry,
    anchorChanges,
    acks,
  );
  // File-grain acks (`codument ack <path>`): a bare-path ack covering a file's
  // current content clears its additive/concept/coarse staleness (never a moved
  // symbol). Resolved here (git+disk) and passed to the pure analyzer.
  const fileGrainAcked = resolveFileGrainAcked(root, baseRef, changes, acks, unevaluable);
  const state = computeChangeState({
    registry,
    changedFiles: changes,
    planScope: plan?.scope,
    anchorChanges: filtered,
    // The ORIGINAL (pre-ack-filter) movement set: concept umbrellas wake off
    // this, so a per-symbol ack can never clear an umbrella's file-grain flag.
    contentMovedFiles: Object.entries(anchorChanges)
      .filter(([, v]) => v.length > 0)
      .map(([k]) => k),
    unevaluable,
    fileGrainAcked,
    deletedFiles: deletions,
    // Deleted files resolve ownership against the registry AT THE BASE — the
    // entry that owned the file while it existed — so removing the entry in the
    // same change cannot dodge the wake.
    baseRegistry: deletions.length > 0 ? readRegistryAtRef(root, baseRef) : undefined,
  });
  return {
    version: 2,
    gate: "ok",
    isGitRepo: isGitRepo(root),
    // Deletions are part of the change: a deletion-only tree is not "clean".
    changedFileCount: changes.length + deletions.length,
    deletions,
    plan,
    state,
    drift,
    fileGrainAcked,
  };
}

export async function review(options: ReviewOptions = {}): Promise<void> {
  const root = options.root ?? process.cwd();

  if (!isGitRepo(root)) {
    // The gate could not run — no repo to diff. Under a gating flag this fails
    // closed (never a silent green), exactly like an unreachable base. Bare
    // `review` stays informational (exit 0). `--json` always emits a valid
    // discriminated shape, never a type-violating `state: null`.
    const failClosed = !!options.strict || !!options.requireReview;
    if (options.json) {
      console.log(
        JSON.stringify(
          { version: 2, gate: "unavailable", reason: "not a git repository", isGitRepo: false },
          null,
          2,
        ),
      );
      if (failClosed) process.exitCode = 1;
      return;
    }
    console.log(pc.bold("codument review"));
    console.log();
    if (failClosed) {
      console.log(pc.red("  ✗ not a git repository (gate could not run)"));
      process.exitCode = 1;
      return;
    }
    console.log(
      pc.yellow("  Not a git repository — review inspects the working-tree diff."),
    );
    return;
  }

  let report: ReviewReport;
  // The base the diff (and so the review fingerprint) is computed against. Captured
  // here so the --require-review gate fingerprints the same change set the report
  // describes; the artifact writer (the review skill) uses the same convention.
  let effectiveBase = "HEAD";
  try {
    // A subdirectory root produces WRONG answers (everything unmapped, every doc
    // fresh), not absent ones — assert loudly before any verdict is computed.
    assertRootIsRepoToplevel(root);
    if (options.base) {
      // Diff the working tree against the merge-base with `options.base` (the
      // branch's drift since it diverged). Resolve that base once so anchors and
      // the changed-file set answer the same question.
      const baseRef = resolveBase(root, options.base, "HEAD").sha;
      const changes = worktreeChangesSince(root, options.base);
      report = buildReview(root, changes, baseRef, worktreeDeletionsSince(root, options.base));
      effectiveBase = baseRef;
    } else {
      // Default: working tree vs HEAD (what `git status` shows). Resolve HEAD to a
      // real object name (the empty tree before the first commit) so the fingerprint
      // base is a stable sha, never the literal "HEAD" — the step-5 writer records
      // exactly this value, and a fresh-repo/first-commit boundary cannot flip it.
      report = buildReview(root);
      effectiveBase = getHeadSha(root) ?? EMPTY_TREE_SHA;
    }
  } catch (err) {
    // Fail closed: the gate could not run (e.g. an unreachable base on a shallow
    // clone, or a subdirectory root). Distinct from "ran and passed" so CI never
    // treats it as green. `--json` gets the same discriminated shape as the
    // non-git case, never broken output a consumer could misread.
    if (err instanceof GateError) {
      if (options.json) {
        console.log(
          JSON.stringify(
            { version: 2, gate: "unavailable", reason: err.message, isGitRepo: true },
            null,
            2,
          ),
        );
        process.exitCode = 1;
        return;
      }
      console.log(pc.bold("codument review"));
      console.log();
      console.log(pc.red(`  ✗ ${err.message} (gate could not run)`));
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // --bundle: emit the oracle an adversarial reviewer attacks (the touched features'
  // documented invariants + their test pointers, the diff, ownership/blast facts),
  // then exit. Pure JSON, no new source of truth — the host pipes it to a fresh
  // reviewer subagent (Claude) or reads it for the same-agent pass (Codex).
  if (options.bundle) {
    const registry = readRegistrySync(join(root, "docs", ".registry.json"));
    const plan = detectApprovedPlanScope(root);
    const bundle = gatherReviewBundle(root, effectiveBase, report.state, registry, plan);
    console.log(JSON.stringify(bundle, null, 2));
    return;
  }

  // --record: write a fingerprint-bound review artifact from the reviewer's findings
  // JSON (`{invariantsChecked, findings, signer}`). The fingerprint is computed HERE
  // over the SAME real-change set + named tests the gate uses, so the writer can
  // never drift from the gate's contract (an agent cannot hand-compute a sha256).
  if (options.record) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(resolvePath(root, options.record), "utf8"));
    } catch (err) {
      console.log(pc.red(`  ✗ could not read findings file: ${(err as Error).message}`));
      process.exitCode = 1;
      return;
    }
    const r = (raw ?? {}) as { invariantsChecked?: unknown; findings?: unknown; signer?: unknown };
    // Validate the shape first (placeholder fingerprint), then compute the real
    // fingerprint from the VALIDATED findings, so a malformed review is rejected
    // before anything is written.
    const provisional = parseReviewArtifact({
      base: effectiveBase,
      diffFingerprint: "pending",
      invariantsChecked: r.invariantsChecked,
      findings: r.findings,
      signer: r.signer,
    });
    if (!provisional) {
      console.log(
        pc.red(
          "  ✗ invalid review: need a non-empty invariantsChecked, a signer, and well-formed findings (citation, detail, status).",
        ),
      );
      process.exitCode = 1;
      return;
    }
    const { set: realChangeSet } = computeRealChange(report, report.deletions);
    const resolveTest = (ref: string) => resolveTestPath(root, ref, DEFAULT_TEST_SEARCH_DIRS);
    const fp = gatherReviewFingerprint(root, effectiveBase, realChangeSet, provisional.findings, resolveTest);
    const path = writeReview(root, { ...provisional, diffFingerprint: fp });
    console.log(`  ${pc.green("✓")} Recorded adversarial review → ${path}`);
    return;
  }

  // A symbol is resolved-by-doc-update iff its feature is NOT stale per the verdict
  // (ADR 010) — the same verdict-derived rule the human display uses, so the soak
  // tally and the display agree. Co-movement is never the resolution signal.
  const staleFeatures = new Set(report.state.staleDocs.map((s) => s.feature));

  // Opt-in: snapshot the deterministic catches (stale docs, risk touches,
  // off-plan files) as a `caught` event — the provable line of the impact ledger.
  // Identities, not counts, so the ledger can count distinct things caught. Off
  // by default to avoid a surprise file write; `commit-work` runs it at commit.
  if (options.log) {
    const d = report.drift;
    const fileGrainAcked = new Set(report.fileGrainAcked);
    // Partition resolutions with the shared classifier so the calibration data
    // matches the human summary exactly. A file-grain ack is counted AS an ack (no
    // doc change owed), never as a doc update, so the friction rate stays honest.
    let docUpdated = 0;
    let fileAcked = 0;
    for (const f of d) {
      const r = driftResolution(f, staleFeatures, fileGrainAcked);
      if (r === "doc-updated") docUpdated++;
      else if (r === "file-acked") fileAcked++;
    }
    emitCaught(root, {
      commit: getHeadSha(root),
      staleDocs: report.state.staleDocs.map((s) => s.doc),
      riskTouches: report.state.riskTouches.map((r) => r.feature),
      offPlan: report.state.outOfPlan,
      // Per-symbol drift soak tally. Resolution is verdict-derived: a doc update
      // (the owning doc changed), a symbol ack, or a file-grain ack (additive residue).
      // The co-movement fields are info-only telemetry for calibrating co-movement
      // itself, never a resolution signal.
      drift: {
        flagged: d.length,
        docUpdated,
        fileAcked,
        acknowledged: d.filter((f) => f.acknowledged).length,
        coMoved: d.filter((f) => f.comovement === "co-moved").length,
        proseUnchanged: d.filter((f) => f.comovement === "prose-unchanged").length,
        notReferenced: d.filter((f) => f.comovement === "not-referenced").length,
      },
      // The identity-bearing form: one record per transition (anchorId +
      // from→to), so the ledger counts each once across re-logged snapshots.
      driftTransitions: d.map((f) => ({
        anchorId: f.anchorId,
        from: f.from ?? null,
        to: f.to ?? null,
        resolution: driftResolution(f, staleFeatures, fileGrainAcked),
        comovement: f.comovement,
      })),
    });
  }

  // --strict gates the agent loop: a step is not done while it left a new source
  // unmapped or a mapped doc stale. Diff-scoped, so it never trips on pre-existing
  // gaps the step did not touch; it deliberately ignores dependents/risk
  // (informational) and depends_on (a separate concern), so the gate stays
  // satisfiable — a genuine leaf feature with no deps can still pass.
  const strictFail =
    !!options.strict &&
    (report.state.unmapped.length > 0 || report.state.staleDocs.length > 0);

  // Adversarial-review gate (opt-in). For a NON-TRIVIAL diff it requires a current,
  // fingerprint-bound review artifact whose findings — RE-CONFIRMED here by running
  // each named test — carry no unresolved blocker. Proportionality covers the full
  // real-change set (sources + config/data + deletions) plus ownership ambiguities,
  // and excludes the `<module>` residual from the "one trivial symbol" fast-path, so
  // nothing real reads as trivial. The fingerprint binds both the reviewed sources
  // AND the tests the findings name, so any real edit — including tampering a test
  // to clear its finding — auto-invalidates the review. The gate RE-DERIVES finding
  // statuses (a toolchain failure is unrunnable, never a false block) rather than
  // trusting the artifact's claim; its honest limit is that an empty/omitted-findings
  // review still passes (soak/audit territory), so it does not certify thoroughness.
  let reviewGate: ReviewGateResult | null = null;
  // Named condition: the DEFAULT test command resolves local-only (no network on
  // the verdict path), so a project without local tsx cannot run the confirm
  // step. Still non-blocking (the documented fail-open stance for unverifiable
  // claims) but rendered where the human decides — never a silent advisory.
  let confirmUnavailable: string | null = null;
  if (options.requireReview) {
    if (!normalizeTestCommand(options.testCommand) && !defaultCommandAvailable(root)) {
      confirmUnavailable =
        'confirm step could not run: no local tsx (the default runner resolves local-only, never the network) — pass --test-command "<your runner> {file}"';
    }
    const { set: realChangeSet, realDeletions } = computeRealChange(report, report.deletions);
    // A covering review binds both the reviewed sources AND the tests its findings
    // name; resolveTest locates a finding's test exactly as the runner does, so a
    // tampered or deleted test moves the fingerprint and reopens the gate.
    const resolveTest = (ref: string) => resolveTestPath(root, ref, DEFAULT_TEST_SEARCH_DIRS);
    const covering = findCoveringReview(root, effectiveBase, realChangeSet, resolveTest);
    // Re-derive each finding's status by RUNNING its named test — never trust a
    // status the artifact merely claims. A red test re-promotes to confirmed; a
    // toolchain failure (missing runner, resolution error) is unrunnable → advisory.
    const confirmedFindings = covering
      ? confirmFindings(
          covering.findings,
          makeTestRunner({ root, command: normalizeTestCommand(options.testCommand) }),
        ).findings
      : null;
    reviewGate = evaluateReviewGate(
      {
        realChangeCount: realChangeSet.length,
        changedSourceCount: report.state.changedSources.length,
        otherChangedCount: report.state.otherChanged.length,
        deletionCount: realDeletions.length,
        riskTouchCount: report.state.riskTouches.length,
        ownershipLintCount: report.state.ownershipLints.length,
        moduleResidualMoved: report.drift.some((d) => d.symbol === MODULE_ANCHOR_NAME),
        movedSymbolCount: countResolvedMovedSymbols(report.drift.map((d) => d.symbol)),
      },
      confirmedFindings,
    );
  }
  const reviewGateFail = !!reviewGate && !reviewGate.passed;

  if (options.json) {
    console.log(
      JSON.stringify(
        reviewGate
          ? {
              ...report,
              reviewGate: confirmUnavailable
                ? { ...reviewGate, confirmUnavailable }
                : reviewGate,
            }
          : report,
        null,
        2,
      ),
    );
    if (strictFail || reviewGateFail) process.exitCode = 1;
    return;
  }

  printHuman(report);

  // Advisory skew nudge — human output only (the --json contract is untouched);
  // never a finding, never an exit-code input.
  {
    const skew = versionSkewNotice(root);
    if (skew) console.log(pc.dim(`  ${skew}`));
  }

  if (strictFail) {
    const reasons: string[] = [];
    if (report.state.unmapped.length > 0)
      reasons.push(`${report.state.unmapped.length} unmapped new source file(s)`);
    if (report.state.staleDocs.length > 0)
      reasons.push(`${report.state.staleDocs.length} stale doc(s)`);
    console.log(
      pc.red(
        `  ✗ --strict: ${reasons.join(" and ")} — the registry/docs are not in sync for this change.`,
      ),
    );
    console.log(
      pc.dim(
        "    Materialize unmapped sources (`codument map materialize <file>`) and update each stale doc, then re-run.",
      ),
    );
    process.exitCode = 1;
  }

  if (reviewGate) {
    printReviewGate(reviewGate, confirmUnavailable);
    if (reviewGateFail) process.exitCode = 1;
  }
}

// The full real-change set the adversarial-review gate scopes to: changed sources +
// config/data + real deletions, with docs and excluded paths dropped. Shared by the
// `--require-review` gate and the `--record` writer so both fingerprint — and so
// reason about proportionality over — the identical set.
function computeRealChange(
  report: ReviewReport,
  deletions: string[],
): { set: string[]; realDeletions: string[] } {
  const isDocPath = (p: string) => p.startsWith("docs/") && p.endsWith(".md");
  const realDeletions = deletions.filter(
    (d) => !isDocPath(d) && !isExcluded(d, DEFAULT_EXCLUSION_SPEC),
  );
  const set = [
    ...new Set([...report.state.changedSources, ...report.state.otherChanged, ...realDeletions]),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { set, realDeletions };
}

// Render the adversarial-review gate result. Advisory findings are surfaced even
// when the gate passes — a judgment-call finding must never be silently swallowed.
function printReviewGate(gate: ReviewGateResult, confirmUnavailable: string | null = null): void {
  console.log();
  if (!gate.required) {
    console.log(pc.dim("  Adversarial review: trivial diff — none required."));
    return;
  }
  if (confirmUnavailable) {
    // Impossible to miss, right where the gate verdict lands: findings with
    // named tests will read advisory not because they were adjudicated but
    // because nothing could run them.
    console.log(pc.yellow(`  ⚠ ${confirmUnavailable}`));
  }
  if (gate.passed) {
    console.log(
      `  ${pc.green("✓")} Adversarial review covers this diff` +
        (gate.advisoryFindings.length > 0
          ? pc.dim(` (${gate.advisoryFindings.length} advisory)`)
          : ""),
    );
  } else {
    console.log(pc.red(`  ✗ --require-review: ${gate.reason}.`));
    if (!gate.covered) {
      console.log(
        pc.dim(
          "    Run a fresh adversarial review of this diff and record it under .codument/reviews/, then re-run.",
        ),
      );
    } else {
      for (const f of gate.blockingFindings) {
        console.log(
          `    ${pc.red("•")} ${f.citation} — ${f.detail}` +
            (f.failingTest ? pc.dim(` (test: ${f.failingTest})`) : ""),
        );
      }
    }
  }
  if (gate.advisoryFindings.length > 0) {
    console.log(pc.dim("    Advisory (judgment calls — your decision, non-blocking):"));
    for (const f of gate.advisoryFindings) {
      console.log(`      ${pc.dim("•")} ${f.citation} — ${f.detail}`);
    }
  }
}

function section(title: string, lines: string[]): void {
  if (lines.length === 0) return;
  console.log(`  ${pc.bold(title)}`);
  for (const line of lines) console.log(`    ${line}`);
  console.log();
}

function printHuman(report: ReviewReport): void {
  const { state, plan } = report;

  console.log(pc.bold("codument review"));
  console.log();

  if (report.changedFileCount === 0) {
    console.log(`  ${pc.green("✓")} Working tree clean — nothing to review.`);
    return;
  }

  console.log(
    `  ${report.changedFileCount} changed file(s): ${state.changedSources.length} source, ${state.changedDocs.length} docs` +
      (state.otherChanged.length > 0 ? `, ${state.otherChanged.length} other` : "") +
      (report.deletions.length > 0 ? `, ${report.deletions.length} deleted` : "") +
      (plan ? pc.dim(`  (plan: ${plan.plan})`) : ""),
  );
  if (plan && plan.contenders.length > 1) {
    // Multiple approved plans is a workflow smell (flip exactly one at a time);
    // never let first-by-filename win silently.
    console.log(
      pc.yellow(
        `  ⚠ ${plan.contenders.length} approved plans (${plan.contenders.join(", ")}) — scope taken from ${plan.plan}; keep exactly one approved`,
      ),
    );
  }
  console.log();

  section(
    "Changed by feature",
    state.byFeature.map(
      (g) => `${pc.cyan(g.feature)} — ${g.files.join(", ")}`,
    ),
  );

  section(
    pc.yellow("Deleted sources (a removal owes its doc attention — update it or remove it too)"),
    state.deletedSources.map((f) => `${pc.yellow("⚠")} ${f}`),
  );

  section(
    pc.yellow("Stale docs (source changed, mapped doc did not)"),
    state.staleDocs.map(
      (d) => `${pc.yellow("⚠")} ${d.feature}: ${d.doc} (changed: ${d.changedSources.join(", ")})`,
    ),
  );

  section(
    pc.yellow("Unassigned shared symbols (set owned_symbols in the registry)"),
    state.ownershipLints.map(
      (l) =>
        `${pc.yellow("⚠")} ${l.file} :: ${l.descriptor} — ${l.kind} across ${l.features.join(", ")}`,
    ),
  );

  section(
    pc.yellow("Could not evaluate (parse error — gated whole-file, fix to restore per-symbol)"),
    state.unevaluable.map((f) => `${pc.yellow("⚠")} ${f}`),
  );

  // Per-symbol drift: owned symbols that moved. The deterministic verdict above is
  // the gate; this names each still-flagged symbol and BOTH ways to resolve it
  // inline — update the doc when a contract changed, or `codument ack` when it did
  // not. The surface MIRRORS the verdict (ADR 010): a symbol is still flagged iff
  // its feature is actually stale (owned source moved, owning doc not edited, not
  // acked). Co-movement is info-only telemetry (the soak signal in `watch`), never
  // the resolved/flagged decision here — so a correct intent-altitude doc update
  // resolves a finding, and a symbol-mirror doc earns no credit.
  const staleFeatures = new Set(report.state.staleDocs.map((s) => s.feature));
  const unresolved = report.drift.filter(
    (d) => !d.acknowledged && staleFeatures.has(d.feature),
  );
  if (unresolved.length > 0) {
    console.log(
      `  ${pc.bold("Symbol drift")} ${pc.dim("— resolve each: update the doc, or ack a contract-neutral move")}`,
    );
    for (const d of unresolved) {
      console.log(
        `    ${pc.dim("•")} ${pc.bold(d.symbol)} ${pc.dim(`(${d.kind}) in ${d.feature}`)}`,
      );
      console.log(`        ${pc.dim("contract changed →")} update ${d.doc} ${pc.dim("at intent altitude")}`);
      if (d.kind === "changed") {
        console.log(
          `        ${pc.dim("internal only   →")} ${pc.cyan(`codument ack ${d.anchorId} --reason "..."`)}`,
        );
      } else {
        // An added/removed symbol has no per-symbol ack (ack rejects it: new or
        // removed content needs doc attention). The honest alternative is the
        // FILE-grain form — suggest the command that actually works when pasted.
        const file = d.anchorId.split("::")[0];
        console.log(
          `        ${pc.dim("additive only   →")} ${pc.cyan(`codument ack ${file} --reason "..."`)} ${pc.dim("(file-grain; a per-symbol ack does not apply to added/removed)")}`,
        );
      }
    }
    console.log();
  }

  // First-class drift-resolution summary: an all-ack change is loud here, not a
  // quiet green — over-acking is visible at the moment of the change, not only in
  // the aggregate soak telemetry. A file-grain ack shows AS a (file) ack, never
  // laundered as a doc update. "resolved by doc update" is verdict-derived (the
  // owning doc was edited in this diff), not a co-movement guess.
  const moved = report.drift.length;
  if (moved > 0) {
    // One pass, shared classifier so the four buckets provably partition `moved` —
    // acked + fileAcked + docUpdated + unresolved cannot silently diverge.
    const fileGrainAcked = new Set(report.fileGrainAcked);
    let acked = 0;
    let fileAcked = 0;
    let docUpdated = 0;
    for (const d of report.drift) {
      switch (driftResolution(d, staleFeatures, fileGrainAcked)) {
        case "acked":
          acked++;
          break;
        case "file-acked":
          fileAcked++;
          break;
        case "doc-updated":
          docUpdated++;
          break;
      }
    }
    console.log(
      `  ${pc.bold("Drift resolution")}: ${moved} owned symbol(s) moved · ` +
        `${acked} acked (contract-neutral) · ` +
        (fileAcked > 0 ? `${fileAcked} file-acked (additive) · ` : "") +
        `${docUpdated} resolved by doc update · ${unresolved.length} still flagged`,
    );
    console.log();
  }

  section(
    pc.dim("Acknowledged — no doc change owed (codument ack --list to manage)"),
    report.drift
      .filter((d) => d.acknowledged)
      .map(
        (d) =>
          `${pc.dim("✓")} ${d.symbol}${d.ackReason ? ` — ${d.ackReason}` : ""} ${pc.dim(`→ ${d.doc}`)}`,
      ),
  );

  section(
    pc.yellow("High-risk areas touched"),
    state.riskTouches.map(
      (r) => `${pc.yellow("⚠")} ${r.feature} [${r.risk.join(", ")}] — ${r.files.join(", ")}`,
    ),
  );

  if (plan) {
    section(
      "Out-of-plan changes",
      state.outOfPlan.map((f) => `${pc.yellow("⚠")} ${f}`),
    );
  }

  section(
    "Unmapped changes (no registry owner)",
    state.unmapped.map((f) => `${pc.yellow("⚠")} ${f}`),
  );

  section(
    "Docs changed without source",
    state.docsChangedWithoutSource.map((d) => `${pc.dim("•")} ${d}`),
  );

  section(
    "High-fanout changed files",
    state.highFanout.map(
      (f) => `${pc.yellow("⚠")} ${f.file} → ${f.features.join(", ")}`,
    ),
  );

  section(
    "Dependents that may need re-review",
    state.dependents.map(
      (d) => `${pc.dim("•")} ${d.feature} (depends on ${d.dependsOn})`,
    ),
  );

  console.log(
    pc.dim(
      "  Review reports repo facts and suspicious gaps — it does not certify the change is safe.",
    ),
  );
}
