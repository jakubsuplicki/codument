import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWriteFileSync } from "./events.js";
import {
  extractStatus,
  identifyPlan,
  isPlanPath,
  parseDeliveryPlan,
  planContractMarkdown,
  selectedPlanId,
  normalizePlanPath,
} from "./plan-steps.js";
import { ConfigValueError, readBoundedState, withStateLock } from "./state-io.js";

export const APPROVALS_PATH = "docs/.approvals.json";
export interface PlanApprovalRecord {
  planId: string;
  path: string;
  revision: number;
  digest: string;
  contract: string;
  approvedAt: string;
  signer: string;
}
export interface ApprovalStore {
  version: 1;
  revision: number;
  records: PlanApprovalRecord[];
}
export interface ApprovalAssessment {
  state: "bound" | "unbound" | "stale";
  allowed: boolean;
  digest: string | null;
  reason: string;
}
const emptyStore = (): ApprovalStore => ({ version: 1, revision: 0, records: [] });
const validId = (id: unknown): id is string =>
  typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id);

export function approvalDigest(path: string, planId: string, contract: string): string {
  return createHash("sha256")
    .update(JSON.stringify([path, planId, contract]))
    .digest("hex");
}

export function parseApprovalStore(raw: string | null): ApprovalStore {
  if (raw === null) return emptyStore();
  const invalid = () =>
    new ConfigValueError(
      APPROVALS_PATH,
      "approval records",
      "malformed, duplicate, unsupported or inconsistent record; restore the tracked file before retrying",
    );
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw invalid();
  let value: ApprovalStore;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (
    value?.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.records)
  )
    throw invalid();
  if (Object.keys(value).some((key) => !["version", "revision", "records"].includes(key)))
    throw invalid();
  const ids = new Set<string>();
  for (const row of value.records) {
    if (
      row &&
      Object.keys(row).some(
        (key) =>
          !["planId", "path", "revision", "digest", "contract", "approvedAt", "signer"].includes(
            key,
          ),
      )
    )
      throw invalid();
    if (
      !row ||
      !validId(row.planId) ||
      ids.has(row.planId) ||
      typeof row.path !== "string" ||
      !isPlanPath(row.path) ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      row.revision > value.revision ||
      typeof row.contract !== "string" ||
      typeof row.signer !== "string" ||
      !row.signer.trim() ||
      row.signer.length > 200 ||
      typeof row.approvedAt !== "string" ||
      !Number.isFinite(Date.parse(row.approvedAt)) ||
      row.digest !== approvalDigest(row.path, row.planId, row.contract)
    )
      throw invalid();
    ids.add(row.planId);
  }
  return value;
}

export function readApprovalStore(root: string): ApprovalStore {
  return parseApprovalStore(readBoundedState(join(root, APPROVALS_PATH)));
}

export function parseApprovalPolicy(raw: string | null): boolean {
  if (raw === null) return false;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ConfigValueError(".codument-meta.json", "approval policy", "invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ConfigValueError(".codument-meta.json", "approval policy", "expected an object");
  const policy = (value as Record<string, unknown>).requireBoundApproval;
  if (policy !== undefined && typeof policy !== "boolean")
    throw new ConfigValueError(".codument-meta.json", "requireBoundApproval", "expected a boolean");
  return policy === true;
}

export function readApprovalPolicy(root: string): boolean {
  return parseApprovalPolicy(readBoundedState(join(root, ".codument-meta.json")));
}

export function assessPlanApproval(
  path: string,
  markdown: string,
  store: ApprovalStore,
  required = false,
  planId?: string,
): ApprovalAssessment {
  const id = selectedPlanId(markdown, planId);
  const record = id ? store.records.find((row) => row.planId === id) : undefined;
  const wasBound = store.records.some((row) => row.path === path);
  if (!record)
    return {
      state: "unbound",
      allowed: !required && !id && !wasBound,
      digest: null,
      reason:
        id || required || wasBound
          ? "Approval is unbound; after human approval run codument work approve --plan <path>."
          : "Legacy unbound approval: only Markdown status is recorded; migrate with codument work approve after human approval.",
    };
  const digest = approvalDigest(path, id!, planContractMarkdown(markdown, planId));
  if (record.path !== path || record.digest !== digest)
    return {
      state: "stale",
      allowed: false,
      digest,
      reason:
        "Approved scope changed; show the changed plan to the human and record fresh approval before implementation.",
    };
  return {
    state: "bound",
    allowed: true,
    digest,
    reason: "Approval matches the recorded plan contract; attribution is self-reported.",
  };
}

/** The caller invokes this only after the human approved the displayed plan. */
export function approvePlan(
  root: string,
  path: string,
  options: { planId?: string; signer: string; expectedRevision?: number },
): PlanApprovalRecord {
  const absolute = resolve(root, path);
  const rel = normalizePlanPath(root, path);
  if (!options.signer.trim() || options.signer.length > 200)
    throw new ConfigValueError(
      path,
      "signer",
      "name who recorded the human approval in at most 200 characters",
    );
  const original = readFileSync(absolute, "utf8");
  if (
    extractStatus(original, options.planId) !== "approved" ||
    !parseDeliveryPlan(original, options.planId).length
  ) {
    throw new ConfigValueError(
      path,
      "approval",
      "display the plan, obtain human approval, and set its exact Status: approved before recording",
    );
  }
  const storeBefore = readApprovalStore(root);
  const expected = options.expectedRevision ?? storeBefore.revision;
  return withStateLock(join(root, APPROVALS_PATH), () => {
    const store = readApprovalStore(root);
    if (store.revision !== expected || readFileSync(absolute, "utf8") !== original)
      throw new ConfigValueError(
        path,
        "approval revision",
        "another writer changed the plan or approval records; reread before retrying",
      );
    const id = selectedPlanId(original, options.planId) ?? randomUUID();
    const identified = identifyPlan(original, id, options.planId);
    const contract = planContractMarkdown(identified, id);
    const digest = approvalDigest(rel, id, contract);
    const existing = store.records.find((row) => row.planId === id);
    if (existing && existing.path !== rel)
      throw new ConfigValueError(path, "Plan-ID", "identifier already belongs to another document");
    if (existing?.digest === digest) return existing;
    const revision = store.revision + 1;
    const record: PlanApprovalRecord = {
      planId: id,
      path: rel,
      revision,
      digest,
      contract,
      approvedAt: new Date().toISOString(),
      signer: options.signer.trim(),
    };
    const updated: ApprovalStore = {
      version: 1,
      revision,
      records: [...store.records.filter((row) => row.planId !== id), record].sort((a, b) =>
        a.planId.localeCompare(b.planId),
      ),
    };
    const encoded = JSON.stringify(updated, null, 2) + "\n";
    parseApprovalStore(encoded);
    // If interrupted between these writes, the new ID is visibly unbound and cannot grant approval.
    if (identified !== original) atomicWriteFileSync(absolute, identified);
    atomicWriteFileSync(join(root, APPROVALS_PATH), encoded);
    return record;
  });
}
