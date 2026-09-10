import { approvePlan } from "../lib/plan-approval.js";

export interface WorkApproveOptions {
  plan: string;
  planId?: string;
  signer?: string;
  json?: boolean;
  root?: string;
  dir?: string;
}

export function workApprove(options: WorkApproveOptions): void {
  const record = approvePlan(options.root ?? options.dir ?? process.cwd(), options.plan, {
    planId: options.planId,
    signer: options.signer ?? "Human approval recorded by explicit CLI action (self-reported)",
  });
  if (options.json) console.log(JSON.stringify({ version: 1, ...record }, null, 2));
  else
    console.log(
      `Approval recorded for ${record.path} (${record.planId}). Stage the plan and docs/.approvals.json together. Attribution is self-reported.`,
    );
}
