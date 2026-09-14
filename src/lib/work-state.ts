import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { atomicWriteFileSync } from "./events.js";
import {
  loadPlan,
  normalizePlanPath,
  resolveActivePlan,
  isPlanPath,
  activeStep,
  parseDeliveryPlan,
  hasPlanSection,
  planContractMarkdown,
  extractStatus,
  type ActivePlan,
} from "./plan-steps.js";
import { ConfigValueError, readBoundedState, withStateLock } from "./state-io.js";
import {
  changeSetBinding,
  parseChangeSetBinding,
  parseVerificationReceipt,
  resolveChangeSet,
  readChangeSetFile,
  verificationReceiptCovers,
  type ChangeSetBinding,
} from "./change-set.js";
import { getGitPath, getHeadSha } from "./git.js";
import { readBlobAtRef, EMPTY_TREE_SHA } from "./two-ref.js";
import { version } from "./version.js";
import {
  readApprovalStore,
  finalApprovalForBoundary,
  prepareFinalDelivery,
  approvalDigest,
  retainedPlanMarkdown,
  finalApprovalWasDelivered,
} from "./plan-approval.js";

export const WORK_STATE_PATH = ".codument/work-state.json";
const STATUSES = ["active", "paused", "blocked", "superseded", "ready", "completed"] as const;
export type WorkStatus = (typeof STATUSES)[number];
export const WORK_GATES = ["implement", "verify", "document", "review", "commit"] as const;
export type WorkGate = (typeof WORK_GATES)[number];
export interface WorkRecord {
  planId: string;
  path: string;
  approvalDigest: string;
  status: WorkStatus;
  nextGate: WorkGate;
  step: number | null;
  reason: string | null;
  resumeCondition: string | null;
  replacement: string | null;
  delivery: ChangeSetBinding | null;
  updatedAt: string;
}
export interface WorkState {
  version: 1;
  root: string;
  revision: number;
  selected: string | null;
  records: WorkRecord[];
}
export interface WorkInspection {
  state: WorkState;
  selected: WorkRecord | null;
  issues: string[];
}
export interface WorkOptions {
  plan?: string;
  planId?: string;
  reason?: string;
  resumeCondition?: string;
  gate?: string;
  expectedRevision?: number;
}
export type WorkAction = "start" | "pause" | "block" | "resume" | "supersede" | "finish";

const invalid = (message: string) => new ConfigValueError(WORK_STATE_PATH, "work state", message);
const textOrNull = (value: unknown): boolean =>
  value === null || (typeof value === "string" && value.trim().length > 0 && value.length <= 2000);
const sameRoot = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);

export function readWorkState(root: string): WorkState {
  const raw = readBoundedState(join(root, WORK_STATE_PATH));
  if (raw === null)
    return { version: 1, root: resolve(root), revision: 0, selected: null, records: [] };
  let state: WorkState;
  try {
    state = JSON.parse(raw);
  } catch {
    throw invalid("invalid JSON; restore the last valid local state");
  }
  if (
    state?.version !== 1 ||
    typeof state.root !== "string" ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !Array.isArray(state.records) ||
    !(state.selected === null || typeof state.selected === "string")
  )
    throw invalid("unsupported or malformed state; restore the last valid local state");
  if (!sameRoot(state.root, root))
    throw invalid(
      "state belongs to another worktree or a moved root; preserve it and explicitly reselect work in this root",
    );
  if (
    Object.keys(state).some(
      (key) => !["version", "root", "revision", "selected", "records"].includes(key),
    )
  )
    throw invalid("unknown state fields");
  const ids = new Set<string>();
  for (const row of state.records) {
    if (
      !row ||
      typeof row.planId !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(row.planId) ||
      ids.has(row.planId) ||
      typeof row.path !== "string" ||
      !isPlanPath(row.path) ||
      !/^[a-f0-9]{64}$/.test(row.approvalDigest) ||
      !STATUSES.includes(row.status) ||
      !WORK_GATES.includes(row.nextGate) ||
      !(row.step === null || (Number.isSafeInteger(row.step) && row.step > 0)) ||
      !textOrNull(row.reason) ||
      !textOrNull(row.resumeCondition) ||
      !textOrNull(row.replacement) ||
      typeof row.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(row.updatedAt))
    )
      throw invalid("malformed or duplicate work record");
    if (
      Object.keys(row).some(
        (key) =>
          ![
            "planId",
            "path",
            "approvalDigest",
            "status",
            "nextGate",
            "step",
            "reason",
            "resumeCondition",
            "replacement",
            "delivery",
            "updatedAt",
          ].includes(key),
      )
    )
      throw invalid("unknown work record fields");
    if (
      (row.status === "paused" || row.status === "blocked" || row.status === "superseded") &&
      !row.reason
    )
      throw invalid("interrupted work needs its reason");
    if (row.status === "blocked" && !row.resumeCondition)
      throw invalid("blocked work needs a resume condition");
    if (row.delivery !== null && !parseChangeSetBinding(row.delivery))
      throw invalid("invalid pending delivery evidence");
    if (row.status === "ready" && !row.delivery)
      throw invalid("ready work needs exact verification evidence");
    ids.add(row.planId);
  }
  if (state.selected !== null && !ids.has(state.selected))
    throw invalid("selected work is missing");
  if (
    state.records.filter((row) => row.status === "active").length > 1 ||
    state.records.some((row) => row.status === "active" && row.planId !== state.selected)
  )
    throw invalid("only the selected work can be active");
  if (
    state.records.some(
      (row) =>
        row.status === "superseded" &&
        (!row.replacement || !ids.has(row.replacement) || row.replacement === row.planId),
    )
  )
    throw invalid("superseded work needs an existing replacement");
  return state;
}

function delivered(root: string, proof: ChangeSetBinding): string | null {
  if (proof.bases.length !== 1 || proof.bases[0].prefix !== "")
    throw invalid(
      "completion of a workspace boundary is unavailable; inspect and select the member worktree",
    );
  const head = getHeadSha(root);
  if (!head || head === proof.bases[0].sha) return null;
  const commits = execFileSync(
    "git",
    [
      "rev-list",
      "--max-count=257",
      proof.bases[0].sha === EMPTY_TREE_SHA ? head : `${proof.bases[0].sha}..${head}`,
    ],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      maxBuffer: 1024 * 1024,
    },
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  for (const commit of commits.slice(0, 256)) {
    if (
      resolveChangeSet(root, { mode: "range", base: proof.bases[0].sha, head: commit })
        .fingerprint === proof.fingerprint
    )
      return commit;
  }
  if (commits.length > 256)
    throw invalid(
      "delivery history exceeds the recovery window; inspect the recorded base and preserve the pending evidence before retrying",
    );
  return null;
}

function committedStep(root: string, record: WorkRecord, commit: string): number | null {
  const content = readBlobAtRef(root, commit, record.path);
  if (content !== null && !hasPlanSection(content, record.planId)) {
    const boundary = resolveChangeSet(root, {
      mode: "range",
      base: record.delivery!.bases[0].sha,
      head: commit,
    });
    const final = finalApprovalForBoundary(root, boundary, {
      plan: record.path,
      planId: record.planId,
    });
    if (final?.digest === record.approvalDigest) return null;
  }
  if (content === null)
    throw invalid(
      "committed plan is unavailable; restore its approval and final delivery evidence before finishing",
    );
  const steps = parseDeliveryPlan(content, record.planId);
  if (record.step === null || !steps.find((step) => step.n === record.step)?.done)
    throw invalid(
      "committed plan does not complete the verified step; inspect the delivery boundary",
    );
  return activeStep(steps)?.n ?? null;
}

/** Recover the verified readiness that a direct commit skipped persisting. The
 * final approval proves consumption; only its matching receipt proves review. */
function reconcileInterruptedFinal(root: string, record: WorkRecord): boolean {
  if (record.delivery) return false; // Existing readiness follows its established proof path.
  const approval = readApprovalStore(root).records.find(
    (row) =>
      row.path === record.path &&
      row.planId === record.planId &&
      row.digest === record.approvalDigest,
  );
  if (!approval || !finalApprovalWasDelivered(root, approval)) return false;
  const receiptPath = getGitPath(root, "codument/verify-receipt.json");
  const raw = receiptPath ? readBoundedState(receiptPath) : null;
  let receipt: ReturnType<typeof parseVerificationReceipt> = null;
  try {
    if (raw) receipt = parseVerificationReceipt(JSON.parse(raw));
  } catch {
    /* Named recovery error below. */
  }
  if (
    !receipt ||
    !["staged", "explicit-staged"].includes(receipt.boundary.mode) ||
    !verificationReceiptCovers(receipt, receipt.boundary, version, {
      path: record.path,
      planId: record.planId,
      digest: record.approvalDigest,
    })
  )
    throw invalid(
      "final approval was already delivered, but matching verification evidence is unavailable; preserve the committed boundary and recover its review evidence before finishing",
    );
  const commit = delivered(root, receipt.boundary);
  if (!commit || committedStep(root, { ...record, delivery: receipt.boundary }, commit) !== null)
    throw invalid(
      "final approval was already delivered, but its saved verification does not match; recover the committed delivery evidence before finishing",
    );
  record.status = "completed";
  record.step = null;
  record.nextGate = "implement";
  record.reason = null;
  record.resumeCondition = null;
  record.delivery = null;
  return true;
}

/** Reconcile observations in the returned projection without rewriting local state. */
export function inspectWorkState(root: string): WorkInspection {
  const state = readWorkState(root);
  const selected = state.records.find((row) => row.planId === state.selected);
  if (!selected) return { state, selected: null, issues: [] };
  const current = structuredClone(selected);
  const issues: string[] = [];
  if (current.status !== "superseded" && current.status !== "completed") {
    try {
      if (reconcileInterruptedFinal(root, current)) return { state, selected: current, issues };
      const plan = loadWorkPlan(root, current.path, current.planId);
      if (!plan?.approved || plan.approval?.digest !== current.approvalDigest)
        issues.push(
          "Selected approval is missing or stale; inspect the plan and record any required human approval before resuming.",
        );
      if (current.status === "ready" && current.delivery) {
        const commit = delivered(root, current.delivery);
        if (commit) {
          current.step = committedStep(root, current, commit);
          current.status = current.step === null ? "completed" : "active";
          current.nextGate = "implement";
          current.reason = null;
          current.resumeCondition = null;
          current.delivery = null;
        } else if (
          resolveChangeSet(root, { mode: "staged" }).fingerprint !== current.delivery.fingerprint
        ) {
          issues.push(
            "Pending delivery no longer matches the staged change; verify and review it again before committing.",
          );
        }
      }
    } catch (error) {
      issues.push((error as Error).message);
    }
  }
  return { state, selected: current, issues };
}

function approvedSelection(root: string, options: WorkOptions, fallback?: WorkRecord): ActivePlan {
  options = { ...options, ...workPlanSelection(root, options) };
  let plan: ActivePlan | null;
  if (options.plan || fallback)
    plan = loadWorkPlan(
      root,
      options.plan ? normalizePlanPath(root, options.plan) : fallback!.path,
      options.planId ?? (options.plan ? undefined : fallback!.planId),
    );
  else {
    if (options.planId) throw invalid("select a plan path with its section identity");
    const found = resolveActivePlan(root);
    if ("error" in found) throw invalid(found.error);
    plan = found.plan;
  }
  if (!plan?.approved || !plan.planId || plan.approval?.state !== "bound")
    throw invalid(
      "work requires an explicitly recorded, current approval; inspect the plan and use work approve after human approval",
    );
  return plan;
}

function resumeRecord(root: string, record: WorkRecord, plan: ActivePlan): void {
  if (reconcileInterruptedFinal(root, record)) return;
  let completed = false;
  if (record.approvalDigest !== plan.approval!.digest) {
    record.delivery = null;
    record.step = plan.active?.n ?? null;
    record.nextGate = "implement";
  } else if (record.delivery) {
    const commit = delivered(root, record.delivery);
    if (commit) {
      record.step = committedStep(root, record, commit);
      completed = record.step === null;
      record.delivery = null;
      record.nextGate = "implement";
    } else if (
      resolveChangeSet(root, { mode: "staged" }).fingerprint !== record.delivery.fingerprint
    ) {
      record.delivery = null;
      record.nextGate = "verify";
    }
  }
  record.approvalDigest = plan.approval!.digest!;
  record.status = completed ? "completed" : "active";
  record.reason = null;
  record.resumeCondition = null;
}

function verifiedDelivery(root: string, plan: ActivePlan, step: number): ChangeSetBinding {
  const path = getGitPath(root, "codument/verify-receipt.json");
  const raw = path ? readBoundedState(path) : null;
  if (!raw) throw invalid("run codument verify for the exact staged step before marking it ready");
  let receipt: ReturnType<typeof parseVerificationReceipt>;
  try {
    receipt = parseVerificationReceipt(JSON.parse(raw));
  } catch {
    throw invalid("invalid verification receipt; run codument verify again");
  }
  const boundary = resolveChangeSet(root, { mode: "staged" });
  const stagedPlan = readChangeSetFile(root, boundary, plan.path);
  const final = finalApprovalForBoundary(root, boundary, {
    plan: plan.path,
    planId: plan.planId ?? undefined,
  });
  if (
    !final &&
    (!stagedPlan ||
      !parseDeliveryPlan(stagedPlan, plan.planId ?? undefined).find((row) => row.n === step)?.done)
  )
    throw invalid("stage the completed step with its delivery before marking it ready");
  const binding = changeSetBinding(boundary);
  const approval = {
    path: plan.path,
    planId: plan.planId ?? null,
    digest: plan.approval?.digest ?? null,
  };
  if (
    !boundary.complete ||
    boundary.changes.length === 0 ||
    !receipt ||
    !verificationReceiptCovers(receipt, binding, version, approval)
  )
    throw invalid(
      "verification does not cover this staged step and approval; run codument verify again",
    );
  return binding;
}

/** Local selection is a routing hint. Permission is always read from tracked approval. */
export function workPlanSelection(
  root: string,
  selection: { plan?: string; planId?: string } = {},
  execute = false,
): { plan?: string; planId?: string } {
  const state = readWorkState(root);
  const current = state.records.find((record) => record.planId === state.selected);
  if (!current) return selection;
  const same =
    (!selection.plan || normalizePlanPath(root, selection.plan) === current.path) &&
    (!selection.planId || selection.planId === current.planId);
  if (execute && (!same || !["active", "ready"].includes(current.status)))
    throw invalid(
      "selected work is interrupted, ended or different; explicitly start or resume the intended plan before execution",
    );
  if (!same) return selection;
  return { plan: current.path, planId: current.planId };
}

export function loadWorkPlan(root: string, path: string, planId?: string): ActivePlan | null {
  const record = readApprovalStore(root).records.find(
    (row) => row.path === path && row.planId === planId,
  );
  const pending =
    record &&
    readWorkState(root).records.some(
      (row) =>
        row.planId === record.planId &&
        row.approvalDigest === record.digest &&
        !["completed", "superseded"].includes(row.status),
    );
  let plan: ActivePlan | null = null;
  try {
    plan = loadPlan(root, path, planId);
  } catch (error) {
    if (!record || (!record.finalDelivery && !pending)) throw error;
  }
  if (plan?.steps.length && (!record?.finalDelivery || plan.approval?.digest !== record.digest))
    return plan;
  if (!record) return plan;
  if (!record.finalDelivery) {
    const recovery = pending ? readBoundedState(join(root, ".codument/pending-plans", path)) : null;
    if (
      !recovery ||
      approvalDigest(path, record.planId, planContractMarkdown(recovery, record.planId)) !==
        record.digest ||
      extractStatus(recovery, record.planId) !== "approved" ||
      !parseDeliveryPlan(recovery, record.planId).length ||
      parseDeliveryPlan(recovery, record.planId).some((step) => !step.done)
    )
      throw invalid(
        "selected plan is compacted without valid approved recovery context; restore that plan's pending-plans copy before resuming",
      );
  }
  return {
    path,
    planId: record.planId,
    planName: path.split("/").pop()!.replace(/\.md$/, ""),
    status: "approved",
    approved: !!pending,
    approval: {
      state: "bound",
      allowed: !!pending,
      digest: record.digest,
      reason: pending
        ? "Recorded final delivery; exact change still requires verification."
        : "Archived approval is context only; create a new plan identity for new work.",
    },
    steps: parseDeliveryPlan(record.contract).map((step) => ({ ...step, done: true })),
    active: null,
  };
}

/** Retained contract context cannot create selection or grant new execution. */
export function workPlanMarkdown(
  root: string,
  path: string,
  markdown: string,
  planId?: string,
): string {
  if (!planId || hasPlanSection(markdown, planId)) return markdown;
  const record = readApprovalStore(root).records.find(
    (row) => row.path === path && row.planId === planId,
  );
  if (record && (record.finalDelivery || loadWorkPlan(root, path, planId)?.approved))
    return retainedPlanMarkdown(record);
  return markdown;
}

export function prepareWorkFinalDelivery(root: string, options: WorkOptions = {}): void {
  const before = readWorkState(root);
  const expected = options.expectedRevision ?? before.revision;
  withStateLock(join(root, WORK_STATE_PATH), () => {
    const state = readWorkState(root);
    if (!Number.isSafeInteger(expected) || expected !== state.revision)
      throw invalid("another writer changed work state; reread before final preparation");
    const current = state.records.find((record) => record.planId === state.selected);
    if (current?.status !== "active")
      throw invalid("start or resume the selected work before preparing final delivery");
    if (
      (options.plan && normalizePlanPath(root, options.plan) !== current.path) ||
      (options.planId && options.planId !== current.planId)
    )
      throw invalid("the selected plan changed; inspect work status before retrying");
    prepareFinalDelivery(root, current.path, current.planId, current.approvalDigest);
  });
}

export function transitionWork(root: string, action: WorkAction, options: WorkOptions): WorkState {
  const before = readWorkState(root);
  const expected = options.expectedRevision ?? before.revision;
  if (options.gate !== undefined && !WORK_GATES.includes(options.gate as WorkGate))
    throw invalid(`next gate must be one of ${WORK_GATES.join(", ")}`);
  if (!Number.isSafeInteger(expected) || expected < 0)
    throw invalid("expected revision must be a nonnegative integer");
  for (const value of [options.reason, options.resumeCondition])
    if (value !== undefined && !textOrNull(value))
      throw invalid("reasons and resume conditions must be nonempty and at most 2000 characters");
  return withStateLock(join(root, WORK_STATE_PATH), () => {
    const state = readWorkState(root);
    if (state.revision !== expected)
      throw invalid("another writer changed work state; reread before retrying");
    let current = state.records.find((row) => row.planId === state.selected);
    const now = new Date().toISOString();
    if (action === "start" || action === "supersede" || (action === "resume" && options.plan)) {
      const plan = approvedSelection(root, options, action === "start" ? current : undefined);
      let target = state.records.find((row) => row.planId === plan.planId);
      if (!plan.active && (action === "start" || !target))
        throw invalid(
          "the selected plan has no unfinished step; finish its pending delivery instead of starting it again",
        );
      if (action === "supersede" && (!current || current.planId === plan.planId))
        throw invalid("supersession requires a different current plan and an explicit replacement");
      if (
        current &&
        current.planId !== plan.planId &&
        !["completed", "superseded"].includes(current.status)
      ) {
        if (!options.reason?.trim())
          throw invalid("switching plans requires a reason; previous work will be preserved");
        current.status = action === "supersede" ? "superseded" : "paused";
        current.reason = options.reason.trim();
        current.replacement = action === "supersede" ? plan.planId! : null;
        current.updatedAt = now;
      }
      if (action === "resume" && !target)
        throw invalid("that plan has no saved work to resume; start it explicitly");
      if (target?.status === "superseded")
        throw invalid("superseded work cannot resume; select its replacement");
      if (target?.status === "completed")
        throw invalid("completed work cannot restart; create and approve a new plan");
      if (!target) {
        target = {
          planId: plan.planId!,
          path: plan.path,
          approvalDigest: plan.approval!.digest!,
          status: "active",
          nextGate: "implement",
          step: plan.active!.n,
          reason: null,
          resumeCondition: null,
          replacement: null,
          delivery: null,
          updatedAt: now,
        };
        state.records.push(target);
      }
      if (
        action === "start" &&
        target.approvalDigest === plan.approval!.digest &&
        target.step !== plan.active?.n &&
        !target.delivery
      )
        throw invalid(
          "the previous step still needs verified delivery; finish it before advancing",
        );
      resumeRecord(root, target, plan);
      target.updatedAt = now;
      state.selected = target.planId;
      current = target;
    } else {
      if (!current) throw invalid("no selected work; start an approved plan first");
      if (["superseded", "completed"].includes(current.status))
        throw invalid("this work has already ended; select unfinished approved work");
      if (options.planId && options.planId !== current.planId)
        throw invalid("the selected plan changed; inspect work status before retrying");
      if (options.plan && normalizePlanPath(root, options.plan) !== current.path)
        throw invalid("the selected plan changed; inspect work status before retrying");
      if (action === "pause" || action === "block") {
        if (!options.reason?.trim()) throw invalid("pausing or blocking work requires a reason");
        if (action === "block" && !options.resumeCondition?.trim())
          throw invalid("blocking work requires a resume condition");
        current.status = action === "pause" ? "paused" : "blocked";
        current.reason = options.reason.trim();
        current.resumeCondition = options.resumeCondition?.trim() ?? null;
      } else if (action === "resume") {
        const plan = approvedSelection(root, options, current);
        const inspected = inspectWorkState(root);
        if (inspected.selected?.status === "completed")
          throw invalid("the plan has already been delivered");
        resumeRecord(root, current, plan);
      } else if (action === "finish") {
        if (!reconcileInterruptedFinal(root, current)) {
          if (current.status !== "active" && current.status !== "ready")
            throw invalid("resume interrupted work before marking it ready");
          const plan = approvedSelection(root, options, current);
          if (current.approvalDigest !== plan.approval!.digest)
            throw invalid(
              "approval changed; explicitly resume the revised plan before finishing work",
            );
          if (current.delivery && delivered(root, current.delivery)) {
            resumeRecord(root, current, plan);
            if (current.step === null) current.status = "completed";
          } else {
            if (current.step === null || !plan.steps.find((step) => step.n === current!.step)?.done)
              throw invalid("the selected delivery step is not complete");
            current.delivery = verifiedDelivery(root, plan, current.step);
            current.status = "ready";
            current.nextGate = "commit";
            current.reason = "Verified step is ready; commit is still pending.";
            current.resumeCondition = "Commit the verified staged boundary.";
          }
        }
      }
      current.updatedAt = now;
    }
    if (options.gate && action !== "finish") current.nextGate = options.gate as WorkGate;
    state.revision++;
    const encoded = JSON.stringify(state, null, 2) + "\n";
    if (Buffer.byteLength(encoded) > 2 * 1024 * 1024)
      throw invalid(
        "work state exceeds its size limit; preserve and archive ended work before retrying",
      );
    atomicWriteFileSync(join(root, WORK_STATE_PATH), encoded);
    return state;
  });
}
