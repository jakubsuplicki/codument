import { join } from "node:path";
import pc from "picocolors";
import { readRegistrySync } from "../lib/registry.js";
import {
  computeChangeState,
  detectApprovedPlanScope,
  type ApprovedPlan,
  type ChangeState,
} from "../lib/change-state.js";
import { getWorkingTreeChanges, isGitRepo, getHeadSha } from "../lib/git.js";
import { worktreeChangesSince, resolveBase, GateError } from "../lib/two-ref.js";
import { gatherAnchorChanges } from "../lib/fingerprint.js";
import { emitCaught } from "../lib/review-events.js";

interface ReviewOptions {
  root?: string;
  json?: boolean;
  log?: boolean;
  strict?: boolean;
  /** Diff against the merge-base with this ref (the branch's drift since it
   *  diverged), not just the uncommitted working tree. */
  base?: string;
}

export interface ReviewReport {
  version: 1;
  isGitRepo: boolean;
  changedFileCount: number;
  plan: ApprovedPlan | null;
  state: ChangeState;
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
  // Best-effort: degrades to file-grain ownership if a base/file can't be read.
  const anchorChanges = gatherAnchorChanges(root, baseRef, changes);
  const state = computeChangeState({
    registry,
    changedFiles: changes,
    planScope: plan?.scope,
    anchorChanges,
  });
  return {
    version: 1,
    isGitRepo: isGitRepo(root),
    changedFileCount: changes.length,
    plan,
    state,
  };
}

export async function review(options: ReviewOptions = {}): Promise<void> {
  const root = options.root ?? process.cwd();

  if (!isGitRepo(root)) {
    if (options.json) {
      console.log(
        JSON.stringify(
          { version: 1, isGitRepo: false, changedFileCount: 0, plan: null, state: null },
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
  try {
    if (options.base) {
      // Diff the working tree against the merge-base with `options.base` (the
      // branch's drift since it diverged). Resolve that base once so anchors and
      // the changed-file set answer the same question.
      const baseRef = resolveBase(root, options.base, "HEAD").sha;
      const changes = worktreeChangesSince(root, options.base);
      report = buildReview(root, changes, baseRef);
    } else {
      // Default: working tree vs HEAD (what `git status` shows).
      report = buildReview(root);
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

  // Opt-in: snapshot the deterministic catches (stale docs, risk touches,
  // off-plan files) as a `caught` event — the provable line of the impact ledger.
  // Identities, not counts, so the ledger can count distinct things caught. Off
  // by default to avoid a surprise file write; `commit-work` runs it at commit.
  if (options.log) {
    emitCaught(root, {
      commit: getHeadSha(root),
      staleDocs: report.state.staleDocs.map((d) => d.doc),
      riskTouches: report.state.riskTouches.map((r) => r.feature),
      offPlan: report.state.outOfPlan,
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

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    if (strictFail) process.exitCode = 1;
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
