import pc from "picocolors";
import { withSelectedRepository } from "../lib/git.js";
import { inspectWorkState, loadWorkPlan, workPlanSelection } from "../lib/work-state.js";
import {
  resolveActivePlan,
  emitActiveStep,
  todoStatus,
  type ActivePlan,
} from "../lib/plan-steps.js";

interface StepsCliOptions {
  repo?: string;
  plan?: string;
  planId?: string;
  json?: boolean;
  emit?: boolean;
  root?: string;
  dir?: string;
}

/**
 * `codument steps` — surface the active plan's delivery-plan checklist so a
 * `work-step` run can mirror it into the host agent's native to-do panel, and
 * optionally log the active `step` event for `codument watch`. The plan doc
 * stays the source of truth; this is a read + a one-way projection.
 */
function resolvePlan(
  root: string,
  planOpt?: string,
  planId?: string,
): { plan: ActivePlan } | { error: string } {
  if (planOpt) {
    const p = loadWorkPlan(root, planOpt, planId);
    if (!p) return { error: `could not read plan doc: ${planOpt}` };
    if (p.steps.length === 0) return { error: `no delivery-plan checklist found in ${planOpt}` };
    return { plan: p };
  }
  return resolveActivePlan(root);
}

export function stepsCommand(options: StepsCliOptions = {}): void {
  withSelectedRepository(options.root ?? options.dir ?? process.cwd(), options.repo, (root) =>
    stepsRepository(options.repo === undefined ? options : { ...options, root }));
}

function stepsRepository(options: StepsCliOptions): void {
  const root = options.root ?? options.dir ?? process.cwd();
  options = { ...options, ...workPlanSelection(root, options) };
  const resolved = resolvePlan(root, options.plan, options.planId);
  if ("error" in resolved) {
    console.log(pc.yellow("codument steps: " + resolved.error));
    process.exitCode = 1;
    return;
  }
  const plan = resolved.plan;
  const work = inspectWorkState(root, { plan: plan.path, planId: plan.planId ?? undefined });
  const progress = work.progress;
  const selected =
    work.selected?.path === plan.path && work.selected?.planId === plan.planId
      ? work.selected
      : null;
  const canEmit =
    !work.selected ||
    (progress?.selection === "selected" && progress.canExecute);
  const current = progress?.step === null || progress?.step === undefined
    ? null : progress.steps.find((step) => step.n === progress.step) ?? null;
  const implementationStep = progress?.selection === "selected"
    ? plan.steps.find((step) => step.n === progress.step) ?? null : plan.active;
  const stepStatus = (step: ActivePlan["steps"][number]) =>
    progress
      ? progress.steps.find((item) => item.n === step.n)?.status ?? "pending"
      : !canEmit && todoStatus(plan, step) === "in_progress" ? "pending" : todoStatus(plan, step);
  const emitted =
    options.emit && plan.approved && canEmit
      ? emitActiveStep(root, { ...plan, active: implementationStep }).emitted : false;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          plan: plan.path,
          planName: plan.planName,
          status: plan.status,
          approved: plan.approved,
          planId: plan.planId ?? null,
          approval: plan.approval,
          ...(selected ? { work: { ...selected, issues: work.issues } } : {}),
          progress,
          current: current ? { n: current.n, text: current.text, nextGate: progress?.nextGate } : null,
          active: implementationStep && canEmit ? { n: implementationStep.n, text: implementationStep.text } : null,
          steps: plan.steps.map((s) => ({
            n: s.n,
            text: s.text,
            status: stepStatus(s),
          })),
          ...(options.emit ? { emitted } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(pc.bold(`Plan: ${plan.planName}`) + pc.dim(`  ·  ${plan.path}`));
  if (plan.approval) console.log(pc.dim(`  ${plan.approval.reason}`));
  if (selected)
    console.log(
      `  Work: ${progress?.status ?? selected.status}; next gate: ${progress?.nextGate ?? selected.nextGate}${selected.reason ? ` — ${selected.reason}` : ""}`,
    );
  if (!plan.approved)
    console.log(
      pc.yellow("  Preview only — not approved for implementation; no step event is emitted."),
    );
  for (const s of plan.steps) {
    const status = stepStatus(s);
    const isActive = status === "in_progress";
    const box = status === "completed" ? pc.green("☑") : isActive ? pc.cyan("◐") : "☐";
    const label = isActive ? pc.bold(s.text) : status === "completed" ? pc.dim(s.text) : s.text;
    console.log(`  ${box} ${label}`);
  }
  console.log("");
  console.log(pc.dim("  Mirror these into your native to-do list (mark the ◐ step in_progress)."));
  if (options.emit && emitted)
    console.log(
      pc.dim("  Logged the active step to .codument/events.jsonl (shows in `codument watch`)."),
    );
}
