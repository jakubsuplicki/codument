import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
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
  hasPlanSection,
} from "./plan-steps.js";
import { ConfigValueError, readBoundedState, withStateLock } from "./state-io.js";
import { resolveChangeSet, readChangeSetFile, type ChangeSet } from "./change-set.js";
import { parsePlanScope } from "./plan-steps.js";
import { readBlobAtRef, EMPTY_TREE_SHA } from "./two-ref.js";
import { getHeadSha } from "./git.js";
import { REVIEW_MANIFEST_PATH, parseReviewTransfer } from "./review-transfer.js";

export const APPROVALS_PATH = "docs/.approvals.json";
export interface PlanApprovalRecord {
  planId: string;
  path: string;
  revision: number;
  digest: string;
  contract: string;
  approvedAt: string;
  signer: string;
  finalDelivery?: { base: string; fingerprint: string };
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
          ![
            "planId",
            "path",
            "revision",
            "digest",
            "contract",
            "approvedAt",
            "signer",
            "finalDelivery",
          ].includes(key),
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
    if (
      row.finalDelivery !== undefined &&
      (!row.finalDelivery ||
        typeof row.finalDelivery !== "object" ||
        Object.keys(row.finalDelivery).sort().join(",") !== "base,fingerprint" ||
        !/^[a-f0-9]{40,64}$/.test(row.finalDelivery.base) ||
        !/^[a-f0-9]{64}$/.test(row.finalDelivery.fingerprint))
    )
      throw invalid();
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
  if (record.finalDelivery)
    return {
      state: "stale",
      allowed: false,
      digest,
      reason:
        "This approval is retained for final delivery; create a new plan identity for new work. Existing pending work may resume its saved gate.",
    };
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
    if (existing?.finalDelivery)
      throw new ConfigValueError(
        path,
        "Plan-ID",
        "final delivery is already bound; create a new plan identity for new work",
      );
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

/** Canonicalize only this binding's own payload; all approval contracts and other changes remain covered. */
export function finalDeliveryFingerprint(
  boundary: ChangeSet,
  store: ApprovalStore,
  planId: string,
  manifest: string | null = null,
): string {
  if (boundary.changes.some((change) => change.path === REVIEW_MANIFEST_PATH)) {
    if (manifest === null)
      throw new ConfigValueError(
        REVIEW_MANIFEST_PATH,
        "final delivery",
        "the reserved manifest must contain valid review evidence",
      );
    parseReviewTransfer(manifest);
  }
  const canonical = structuredClone(store);
  const selected = canonical.records.find((record) => record.planId === planId);
  if (selected) delete selected.finalDelivery;
  return createHash("sha256")
    .update(
      JSON.stringify([
        boundary.bases,
        boundary.changes.filter(
          (change) => change.path !== APPROVALS_PATH && change.path !== REVIEW_MANIFEST_PATH,
        ),
        canonical,
      ]),
    )
    .digest("hex");
}

/** Select only an explicit, exact final delivery; archived records grant no permission to later changes. */
export function finalApprovalForBoundary(
  root: string,
  boundary: ChangeSet,
  selection?: { plan?: string; planId?: string },
): PlanApprovalRecord | null {
  if (boundary.bases.length !== 1 || boundary.bases[0].prefix !== "") return null;
  const store = parseApprovalStore(readChangeSetFile(root, boundary, APPROVALS_PATH));
  const candidates = store.records.filter(
    (record) =>
      record.finalDelivery &&
      (!selection?.plan || record.path === normalizePlanPath(root, selection.plan)) &&
      (!selection?.planId || record.planId === selection.planId),
  );
  if (!candidates.length) return null;
  const previous = parseApprovalStore(readBlobAtRef(root, boundary.bases[0].sha, APPROVALS_PATH));
  const matches = candidates.filter((record) => {
    const final = record.finalDelivery!;
    if (
      previous.records.find((row) => row.planId === record.planId)?.finalDelivery?.fingerprint ===
      final.fingerprint
    )
      return false;
    if (
      boundary.mode === "range" &&
      !boundary.changes.some((change) => change.path === APPROVALS_PATH)
    )
      return false;
    const selected =
      boundary.mode === "range"
        ? resolveChangeSet(root, { mode: "range", base: final.base, head: boundary.head })
        : boundary;
    if (
      selected.bases.length !== 1 ||
      selected.bases[0].sha !== final.base ||
      selected.bases[0].prefix !== ""
    )
      return false;
    // A narrower range after final delivery must not inherit an archived approval.
    return (
      finalDeliveryFingerprint(
        selected,
        store,
        record.planId,
        readChangeSetFile(root, selected, REVIEW_MANIFEST_PATH),
      ) === final.fingerprint
    );
  });
  if (matches.length > 1)
    throw new ConfigValueError(
      APPROVALS_PATH,
      "final delivery",
      "multiple final deliveries match; select one plan explicitly",
    );
  return matches[0] ?? null;
}

export function finalApprovalScope(record: PlanApprovalRecord): {
  plan: string;
  scope: string[];
  contenders: string[];
  planId: string;
  approvalDigest: string;
} {
  return {
    plan: record.path,
    scope: parsePlanScope(record.contract),
    contenders: [record.path],
    planId: record.planId,
    approvalDigest: record.digest,
  };
}

export function retainedPlanMarkdown(record: PlanApprovalRecord): string {
  return identifyPlan(record.contract, record.planId);
}

/** A tracked final binding is consumed by its matching reachable delivery, even
 * when a normal Git commit interrupted the local readiness bookkeeping. */
export function finalApprovalWasDelivered(root: string, record: PlanApprovalRecord): boolean {
  const final = record.finalDelivery;
  const head = final ? getHeadSha(root) : null;
  if (!final || !head || head === final.base) return false;
  const commits = execFileSync(
    "git",
    [
      "rev-list",
      "--max-count=257",
      final.base === EMPTY_TREE_SHA ? head : `${final.base}..${head}`,
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
    const boundary = resolveChangeSet(root, { mode: "range", base: final.base, head: commit });
    const archived = finalApprovalForBoundary(root, boundary, {
      plan: record.path,
      planId: record.planId,
    });
    if (archived?.digest === record.digest) return true;
  }
  if (commits.length > 256)
    throw new ConfigValueError(
      record.path,
      "final delivery",
      "delivery history exceeds the recovery window; inspect the recorded base before retrying",
    );
  return false;
}

/** Called after saving approved recovery context, compacting the plan, and staging the final slice. */
export function prepareFinalDelivery(
  root: string,
  path: string,
  planId: string,
  approval: string,
): PlanApprovalRecord {
  const before = readApprovalStore(root);
  return withStateLock(join(root, APPROVALS_PATH), () => {
    const store = readApprovalStore(root);
    if (store.revision !== before.revision)
      throw new ConfigValueError(
        APPROVALS_PATH,
        "revision",
        "another writer changed approval; reread before retrying",
      );
    const record = store.records.find(
      (row) => row.path === path && row.planId === planId && row.digest === approval,
    );
    if (!record)
      throw new ConfigValueError(
        path,
        "approval",
        "selected approval changed; record the required human approval before final delivery",
      );
    if (finalApprovalWasDelivered(root, record))
      throw new ConfigValueError(
        path,
        "final delivery",
        "this approved final boundary was already delivered; use work finish to reconcile it and a newly approved plan for later work",
      );
    const recovery = readBoundedState(join(root, ".codument/pending-plans", path));
    if (
      !recovery ||
      approvalDigest(path, planId, planContractMarkdown(recovery, planId)) !== record.digest ||
      extractStatus(recovery, planId) !== "approved" ||
      !parseDeliveryPlan(recovery, planId).length ||
      parseDeliveryPlan(recovery, planId).some((step) => !step.done)
    )
      throw new ConfigValueError(
        path,
        "final delivery",
        "save the completed approved plan in its pending-plans recovery copy first",
      );
    const boundary = resolveChangeSet(root, { mode: "staged" });
    if (boundary.bases.length !== 1 || boundary.bases[0].prefix !== "" || !boundary.complete)
      throw new ConfigValueError(
        path,
        "final delivery",
        "select one complete member repository boundary",
      );
    const compacted = readChangeSetFile(root, boundary, path);
    if (compacted === null || hasPlanSection(compacted, planId))
      throw new ConfigValueError(
        path,
        "final delivery",
        "compact and stage the durable plan document before preparing final delivery",
      );
    const manifest = readChangeSetFile(root, boundary, REVIEW_MANIFEST_PATH);
    if (
      record.finalDelivery?.fingerprint ===
      finalDeliveryFingerprint(boundary, store, planId, manifest)
    )
      return record;
    store.revision++;
    record.finalDelivery = {
      base: boundary.bases[0].sha,
      fingerprint: finalDeliveryFingerprint(boundary, store, planId, manifest),
    };
    const encoded = JSON.stringify(store, null, 2) + "\n";
    parseApprovalStore(encoded);
    atomicWriteFileSync(join(root, APPROVALS_PATH), encoded);
    return record;
  });
}
