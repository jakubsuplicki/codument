import { approvePlan } from "../lib/plan-approval.js";
import { withSelectedRepository } from "../lib/git.js";
import {
  inspectWorkState,
  transitionWork,
  prepareWorkFinalDelivery,
  type WorkAction,
} from "../lib/work-state.js";

export interface WorkApproveOptions {
  repo?: string;
  plan: string;
  planId?: string;
  signer?: string;
  json?: boolean;
  root?: string;
  dir?: string;
}

export function workApprove(options: WorkApproveOptions): void {
  withSelectedRepository(options.root ?? options.dir ?? process.cwd(), options.repo, root =>
    approveRepository(options.repo === undefined ? options : { ...options, root }));
}

function approveRepository(options: WorkApproveOptions): void {
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

export interface WorkCommandOptions {
  repo?: string;
  prepareFinal?: boolean;
  plan?: string;
  planId?: string;
  reason?: string;
  resumeWhen?: string;
  gate?: string;
  expectRevision?: string;
  json?: boolean;
  root?: string;
}

export function workCommand(action: WorkAction | "status", options: WorkCommandOptions = {}): void {
  try {
    withSelectedRepository(options.root ?? process.cwd(), options.repo, root =>
      renderWork(action, options.repo === undefined ? options : { ...options, root }));
  } catch (error) {
    const message = (error as Error).message;
    console.log(
      options.json ? JSON.stringify({ version: 1, error: message }) : `codument work: ${message}`,
    );
    process.exitCode = 1;
  }
}

function renderWork(action: WorkAction | "status", options: WorkCommandOptions): void {
  const root = options.root ?? process.cwd();
  if (options.prepareFinal) {
    if (action !== "finish") throw new Error("--prepare-final is only valid for work finish");
    prepareWorkFinalDelivery(root, {
      plan: options.plan,
      planId: options.planId,
      expectedRevision:
        options.expectRevision === undefined ? undefined : Number(options.expectRevision),
    });
    console.log(
      options.json
        ? JSON.stringify({ version: 1, prepared: true, stage: "docs/.approvals.json" })
        : "Final delivery bound. Stage docs/.approvals.json, then review and verify this boundary before work finish.",
    );
    return;
  }
  if (action !== "status")
    transitionWork(root, action, {
      plan: options.plan,
      planId: options.planId,
      reason: options.reason,
      resumeCondition: options.resumeWhen,
      gate: options.gate,
      expectedRevision:
        options.expectRevision === undefined ? undefined : Number(options.expectRevision),
    });
  const inspection = inspectWorkState(root);
  if (options.json) console.log(JSON.stringify({ version: 1, ...inspection }, null, 2));
  else if (!inspection.selected)
    console.log(
      "No selected work. Start an explicitly approved plan with codument work start --plan <path>.",
    );
  else {
    const record = inspection.selected;
    const progress = inspection.progress;
    const milestone = progress?.steps.find((step) => step.n === progress.step);
    console.log(
      `${progress?.status ?? record.status}: ${record.path}${record.step === null ? "" : ` — step ${record.step}`}${milestone ? `: ${milestone.text}` : ""}`,
    );
    if (record.status !== "completed" && record.status !== "superseded")
      console.log(`Next gate: ${progress?.nextGate ?? record.nextGate}`);
    if (record.reason) console.log(record.reason);
    if (record.resumeCondition) console.log(`Resume when: ${record.resumeCondition}`);
    for (const issue of inspection.issues) console.log(`Needs attention: ${issue}`);
  }
  if (inspection.issues.length) process.exitCode = 1;
}
