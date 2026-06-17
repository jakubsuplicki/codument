import pc from "picocolors";
import {
  loadPlan,
  findActivePlans,
  emitActiveStep,
  todoStatus,
  type ActivePlan,
} from "../lib/plan-steps.js";

interface StepsCliOptions {
  plan?: string;
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
): { plan: ActivePlan } | { error: string } {
  if (planOpt) {
    const p = loadPlan(root, planOpt);
    if (!p) return { error: `could not read plan doc: ${planOpt}` };
    if (p.steps.length === 0)
      return { error: `no delivery-plan checklist found in ${planOpt}` };
    return { plan: p };
  }
  const found = findActivePlans(root);
  if (found.length === 0)
    return {
      error:
        "no approved plan with an unchecked step under docs/features or docs/concepts — pass --plan <path>",
    };
  if (found.length > 1)
    return {
      error: `multiple approved plans with unchecked steps (${found
        .map((p) => p.path)
        .join(", ")}) — pass --plan <path>`,
    };
  return { plan: found[0] };
}

export function stepsCommand(options: StepsCliOptions = {}): void {
  const root = options.root ?? options.dir ?? process.cwd();
  const resolved = resolvePlan(root, options.plan);
  if ("error" in resolved) {
    console.log(pc.yellow("codument steps: " + resolved.error));
    process.exitCode = 1;
    return;
  }
  const plan = resolved.plan;

  const emitted = options.emit ? emitActiveStep(root, plan).emitted : false;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          plan: plan.path,
          planName: plan.planName,
          status: plan.status,
          active: plan.active ? { n: plan.active.n, text: plan.active.text } : null,
          steps: plan.steps.map((s) => ({
            n: s.n,
            text: s.text,
            status: todoStatus(plan, s),
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
  for (const s of plan.steps) {
    const isActive = !!plan.active && s.n === plan.active.n;
    const box = s.done ? pc.green("☑") : isActive ? pc.cyan("◐") : "☐";
    const label = isActive ? pc.bold(s.text) : s.done ? pc.dim(s.text) : s.text;
    console.log(`  ${box} ${label}`);
  }
  console.log("");
  console.log(
    pc.dim("  Mirror these into your native to-do list (mark the ◐ step in_progress)."),
  );
  if (options.emit && emitted)
    console.log(
      pc.dim("  Logged the active step to .codument/events.jsonl (shows in `codument watch`)."),
    );
}
