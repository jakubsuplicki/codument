import { join } from "node:path";
import pc from "picocolors";
import { readRegistrySync } from "../lib/registry.js";
import {
  computeChangeState,
  detectApprovedPlanScope,
  type ApprovedPlan,
  type ChangeState,
} from "../lib/change-state.js";
import { getWorkingTreeChanges, isGitRepo } from "../lib/git.js";
import { appendEvent } from "../lib/events.js";

interface ReviewOptions {
  root?: string;
  json?: boolean;
  log?: boolean;
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
export function buildReview(root: string): ReviewReport {
  const registry = readRegistrySync(join(root, "docs", ".registry.json"));
  const changedFiles = getWorkingTreeChanges(root);
  const plan = detectApprovedPlanScope(root);
  const state = computeChangeState({
    registry,
    changedFiles,
    planScope: plan?.scope,
  });
  return {
    version: 1,
    isGitRepo: isGitRepo(root),
    changedFileCount: changedFiles.length,
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

  const report = buildReview(root);

  // Opt-in: append a flow event so `watch` (and the review-effectiveness log)
  // has something to tail. Off by default to avoid a surprise file write.
  if (options.log) {
    appendEvent(root, {
      type: "review",
      message: `${report.state.staleDocs.length} stale, ${report.state.unmapped.length} unmapped, ${report.state.riskTouches.length} risk`,
      data: {
        changed: report.changedFileCount,
        stale: report.state.staleDocs.length,
        unmapped: report.state.unmapped.length,
        risk: report.state.riskTouches.length,
        outOfPlan: report.state.outOfPlan.length,
      },
    });
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printHuman(report);
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
