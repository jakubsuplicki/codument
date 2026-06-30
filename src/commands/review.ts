import { join } from "node:path";
import pc from "picocolors";
import { readRegistrySync } from "../lib/registry.js";
import {
  computeChangeState,
  detectApprovedPlanScope,
  type ApprovedPlan,
  type ChangeState,
} from "../lib/change-state.js";
import { getWorkingTreeChanges, getWorkingTreeDeletions, isGitRepo, getHeadSha } from "../lib/git.js";
import {
  worktreeChangesSince,
  worktreeDeletionsSince,
  resolveBase,
  GateError,
  EMPTY_TREE_SHA,
} from "../lib/two-ref.js";
import { gatherAnchorChanges } from "../lib/fingerprint.js";
import { computeDrift, type DriftFinding } from "../lib/drift.js";
import { readAcks } from "../lib/acknowledgment.js";
import { emitCaught } from "../lib/review-events.js";
import { findCoveringReview } from "../lib/review-artifact.js";
import {
  evaluateReviewGate,
  countResolvedMovedSymbols,
  type ReviewGateResult,
} from "../lib/review-gate.js";
import {
  confirmFindings,
  makeTestRunner,
  resolveTestPath,
  DEFAULT_TEST_SEARCH_DIRS,
} from "../lib/review-confirm.js";
import { isExcluded, DEFAULT_EXCLUSION_SPEC } from "../lib/analyze.js";
import { MODULE_ANCHOR_NAME } from "../lib/ts-adapter.js";

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
   *  re-confirmation step is not hardcoded to one toolchain. */
  testCommand?: string[];
}

export interface ReviewReport {
  version: 1;
  isGitRepo: boolean;
  changedFileCount: number;
  plan: ApprovedPlan | null;
  state: ChangeState;
  /** Per-symbol drift detail behind the verdict: which owned symbols moved, their
   *  co-movement telemetry, and which were cleared by a recorded acknowledgment. */
  drift: DriftFinding[];
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
): ReviewReport {
  const registry = readRegistrySync(join(root, "docs", ".registry.json"));
  // Callers that already computed the working-tree changes (e.g. `watch`, which
  // also needs them for its activity tape) can pass them in to avoid a second
  // `git status` tree scan per refresh; default to computing them here.
  const changes = changedFiles ?? getWorkingTreeChanges(root);
  const plan = detectApprovedPlanScope(root);
  // Per-symbol anchor diffs for the precise (TS) changed files, base ref vs the
  // working tree — this is what dissolves the shared-file cascade in the verdict.
  // Best-effort: coarse/non-TS files degrade to file-grain ownership; parse-error
  // files come back as `unevaluable` (gated file-grain AND surfaced).
  const { anchorChanges, unevaluable } = gatherAnchorChanges(root, baseRef, changes);
  // Resolve per-symbol drift + acknowledgments: an acked move is adjudicated (a
  // recorded "refactor, no doc change owed" decision) and dropped from the set the
  // stale-doc verdict sees; co-movement is attached as info-only telemetry.
  const { findings: drift, filtered } = computeDrift(
    root,
    baseRef,
    registry,
    anchorChanges,
    readAcks(root),
  );
  const state = computeChangeState({
    registry,
    changedFiles: changes,
    planScope: plan?.scope,
    anchorChanges: filtered,
    unevaluable,
  });
  return {
    version: 1,
    isGitRepo: isGitRepo(root),
    changedFileCount: changes.length,
    plan,
    state,
    drift,
  };
}

export async function review(options: ReviewOptions = {}): Promise<void> {
  const root = options.root ?? process.cwd();

  if (!isGitRepo(root)) {
    if (options.json) {
      console.log(
        JSON.stringify(
          { version: 1, isGitRepo: false, changedFileCount: 0, plan: null, state: null, drift: [] },
          null,
          2,
        ),
      );
      return;
    }
    console.log(pc.bold("codument review"));
    console.log();
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
  // Pure deletions, which the change-state path drops — the gate counts them as
  // real changes (proportionality + fingerprint), per the full-change-set scope.
  let deletions: string[] = [];
  try {
    if (options.base) {
      // Diff the working tree against the merge-base with `options.base` (the
      // branch's drift since it diverged). Resolve that base once so anchors and
      // the changed-file set answer the same question.
      const baseRef = resolveBase(root, options.base, "HEAD").sha;
      const changes = worktreeChangesSince(root, options.base);
      report = buildReview(root, changes, baseRef);
      effectiveBase = baseRef;
      deletions = worktreeDeletionsSince(root, options.base);
    } else {
      // Default: working tree vs HEAD (what `git status` shows). Resolve HEAD to a
      // real object name (the empty tree before the first commit) so the fingerprint
      // base is a stable sha, never the literal "HEAD" — the step-5 writer records
      // exactly this value, and a fresh-repo/first-commit boundary cannot flip it.
      report = buildReview(root);
      effectiveBase = getHeadSha(root) ?? EMPTY_TREE_SHA;
      deletions = getWorkingTreeDeletions(root);
    }
  } catch (err) {
    // Fail closed: the gate could not run (e.g. an unreachable base on a shallow
    // clone). Distinct from "ran and passed" so CI never treats it as green.
    if (err instanceof GateError) {
      console.log(pc.bold("codument review"));
      console.log();
      console.log(pc.red(`  ✗ ${err.message} (gate could not run)`));
      process.exitCode = 1;
      return;
    }
    throw err;
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
    emitCaught(root, {
      commit: getHeadSha(root),
      staleDocs: report.state.staleDocs.map((s) => s.doc),
      riskTouches: report.state.riskTouches.map((r) => r.feature),
      offPlan: report.state.outOfPlan,
      // Per-symbol drift soak tally. Resolution is verdict-derived: a doc update
      // (the owning doc changed) or an ack. The co-movement fields are info-only
      // telemetry for calibrating co-movement itself, never a resolution signal.
      drift: {
        flagged: d.length,
        docUpdated: d.filter((f) => !f.acknowledged && !staleFeatures.has(f.feature))
          .length,
        acknowledged: d.filter((f) => f.acknowledged).length,
        coMoved: d.filter((f) => f.comovement === "co-moved").length,
        proseUnchanged: d.filter((f) => f.comovement === "prose-unchanged").length,
        notReferenced: d.filter((f) => f.comovement === "not-referenced").length,
      },
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
  if (options.requireReview) {
    const isDocPath = (p: string) => p.startsWith("docs/") && p.endsWith(".md");
    const realDeletions = deletions.filter(
      (d) => !isDocPath(d) && !isExcluded(d, DEFAULT_EXCLUSION_SPEC),
    );
    const realChangeSet = [
      ...new Set([
        ...report.state.changedSources,
        ...report.state.otherChanged,
        ...realDeletions,
      ]),
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    // A covering review binds both the reviewed sources AND the tests its findings
    // name; resolveTest locates a finding's test exactly as the runner does, so a
    // tampered or deleted test moves the fingerprint and reopens the gate.
    const resolveTest = (ref: string) => resolveTestPath(root, ref, DEFAULT_TEST_SEARCH_DIRS);
    const covering = findCoveringReview(root, effectiveBase, realChangeSet, resolveTest);
    // Re-derive each finding's status by RUNNING its named test — never trust a
    // status the artifact merely claims. A red test re-promotes to confirmed; a
    // toolchain failure (missing runner, resolution error) is unrunnable → advisory.
    const confirmedFindings = covering
      ? confirmFindings(covering.findings, makeTestRunner({ root, command: options.testCommand }))
          .findings
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
    console.log(JSON.stringify(reviewGate ? { ...report, reviewGate } : report, null, 2));
    if (strictFail || reviewGateFail) process.exitCode = 1;
    return;
  }

  printHuman(report);

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
    printReviewGate(reviewGate);
    if (reviewGateFail) process.exitCode = 1;
  }
}

// Render the adversarial-review gate result. Advisory findings are surfaced even
// when the gate passes — a judgment-call finding must never be silently swallowed.
function printReviewGate(gate: ReviewGateResult): void {
  console.log();
  if (!gate.required) {
    console.log(pc.dim("  Adversarial review: trivial diff — none required."));
    return;
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
      (plan ? pc.dim(`  (plan: ${plan.plan})`) : ""),
  );
  console.log();

  section(
    "Changed by feature",
    state.byFeature.map(
      (g) => `${pc.cyan(g.feature)} — ${g.files.join(", ")}`,
    ),
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
      console.log(
        `        ${pc.dim("internal only   →")} ${pc.cyan(`codument ack ${d.anchorId} --reason "..."`)}`,
      );
    }
    console.log();
  }

  // First-class drift-resolution summary: an all-ack change is loud here, not a
  // quiet green — over-acking is visible at the moment of the change, not only in
  // the aggregate soak telemetry. "resolved by doc update" is verdict-derived (the
  // owning doc was edited in this diff), not a co-movement guess.
  const moved = report.drift.length;
  if (moved > 0) {
    // One pass so the three buckets provably partition `moved` — acked +
    // docUpdated + unresolved cannot silently diverge from a future predicate edit.
    let acked = 0;
    let docUpdated = 0;
    for (const d of report.drift) {
      if (d.acknowledged) acked++;
      else if (!staleFeatures.has(d.feature)) docUpdated++;
    }
    console.log(
      `  ${pc.bold("Drift resolution")}: ${moved} owned symbol(s) moved · ` +
        `${acked} acked (contract-neutral) · ${docUpdated} resolved by doc update · ` +
        `${unresolved.length} still flagged`,
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
