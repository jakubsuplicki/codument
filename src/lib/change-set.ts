import { createHash } from "node:crypto";
import { isAbsolute, posix, sep } from "node:path";
import { GateError } from "./gate-error.js";
import {
  getTreeEntryAtRef,
  getHeadSha,
  getIndexWorktreeOverlaps,
  getStagedChanges,
  getWorkingTreeChanges,
  getWorkingTreeDeletions,
  type IndexChange,
  readIndexText,
  repoFor,
  resolveWorkspace,
  type Workspace,
} from "./git.js";
import {
  byteNormalize,
  changedPathsBetween,
  EMPTY_TREE_SHA,
  readBlobAtRef,
  resolveBase,
} from "./two-ref.js";

export type ChangeSetMode = "staged" | "explicit-staged" | "range";

export interface ChangeSetEntry {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  /** Git object id of the exact selected content. Absent for deletions. */
  contentOid?: string;
  /** Git file type and executable mode of the selected entry. */
  contentMode?: string;
}

export interface ChangeSetBase {
  /** Empty for a conventional single repository; otherwise the member path. */
  prefix: string;
  /** Resolved commit or the canonical empty tree. */
  sha: string;
}

export interface ChangeSet {
  version: 1;
  mode: ChangeSetMode;
  /** Resolved bases that the selected transitions start from. */
  bases: ChangeSetBase[];
  /** INDEX for local modes; the caller's ref for a committed range. */
  head: string;
  /** True only when this projection covers the complete commit boundary. */
  complete: boolean;
  changes: ChangeSetEntry[];
  changedFiles: string[];
  additions: string[];
  deletions: string[];
  renames: Array<{ from: string; to: string }>;
  /** Staged entries deliberately left outside an explicit projection. */
  unselectedStagedPaths: string[];
  /** Current filesystem changes outside the selected commit boundary. */
  dirtyOutside: string[];
  /** Stable identity of the bases, transitions, paths, and selected bytes. */
  fingerprint: string;
}

/** Durable identity of a change-set projection, without its diagnostic path lists. */
export interface ChangeSetBinding {
  version: 1;
  mode: ChangeSetMode;
  bases: ChangeSetBase[];
  head: string;
  paths: string[];
  fingerprint: string;
}

export interface VerificationReceipt {
  version: 1;
  codumentVersion: string;
  boundary: ChangeSetBinding;
  planApproval?: { path: string; planId: string | null; digest: string | null } | null;
}

export function changeSetBinding(set: ChangeSet): ChangeSetBinding {
  return {
    version: 1,
    mode: set.mode,
    bases: set.bases.map((base) => ({ ...base })),
    head: set.head,
    paths: sorted(set.changes.map((change) => change.path)),
    fingerprint: set.fingerprint,
  };
}

export function parseChangeSetBinding(value: unknown): ChangeSetBinding | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    !["staged", "explicit-staged", "range"].includes(String(candidate.mode)) ||
    typeof candidate.head !== "string" ||
    candidate.head.length === 0 ||
    typeof candidate.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.fingerprint) ||
    !Array.isArray(candidate.bases) ||
    !Array.isArray(candidate.paths) ||
    candidate.paths.some((path) => typeof path !== "string" || path.length === 0)
  ) {
    return null;
  }
  const bases: ChangeSetBase[] = [];
  for (const raw of candidate.bases) {
    if (typeof raw !== "object" || raw === null) return null;
    const base = raw as Record<string, unknown>;
    if (typeof base.prefix !== "string" || typeof base.sha !== "string" || base.sha.length === 0) {
      return null;
    }
    bases.push({ prefix: base.prefix, sha: base.sha });
  }
  return {
    version: 1,
    mode: candidate.mode as ChangeSetMode,
    bases,
    head: candidate.head,
    paths: sorted(candidate.paths as string[]),
    fingerprint: candidate.fingerprint,
  };
}

export function parseVerificationReceipt(value: unknown): VerificationReceipt | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const boundary = parseChangeSetBinding(candidate.boundary);
  if (
    candidate.version !== 1 ||
    typeof candidate.codumentVersion !== "string" ||
    candidate.codumentVersion.length === 0 ||
    !boundary
  ) {
    return null;
  }
  let planApproval: VerificationReceipt["planApproval"];
  if (candidate.planApproval !== undefined && candidate.planApproval !== null) {
    const plan = candidate.planApproval as Record<string, unknown>;
    if (typeof plan !== "object" || typeof plan.path !== "string" || !(plan.planId === null || typeof plan.planId === "string") || !(plan.digest === null || (typeof plan.digest === "string" && /^[a-f0-9]{64}$/.test(plan.digest)))) return null;
    planApproval = { path: plan.path, planId: plan.planId, digest: plan.digest };
  } else if (candidate.planApproval === null) planApproval = null;
  return { version: 1, codumentVersion: candidate.codumentVersion, boundary, ...(planApproval !== undefined ? { planApproval } : {}) };
}

export function verificationReceiptCovers(
  receipt: VerificationReceipt,
  boundary: ChangeSetBinding,
  codumentVersion: string,
  planApproval?: VerificationReceipt["planApproval"],
): boolean {
  const normalizeStagedMode = (binding: ChangeSetBinding): ChangeSetBinding => ({
    ...binding,
    mode: binding.mode === "explicit-staged" ? "staged" : binding.mode,
  });
  return (
    receipt.codumentVersion === codumentVersion &&
    JSON.stringify(receipt.planApproval ?? null) === JSON.stringify(planApproval ?? null) &&
    sameChangeSetBinding(normalizeStagedMode(receipt.boundary), normalizeStagedMode(boundary))
  );
}

export function sameChangeSetBinding(
  left: ChangeSetBinding | undefined,
  right: ChangeSetBinding | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.version === right.version &&
    left.mode === right.mode &&
    left.head === right.head &&
    left.fingerprint === right.fingerprint &&
    JSON.stringify(left.paths) === JSON.stringify(right.paths) &&
    JSON.stringify(left.bases) === JSON.stringify(right.bases)
  );
}

export type ChangeSetErrorCode =
  | "invalid-path"
  | "path-not-staged"
  | "worktree-overlap"
  | "range-workspace";

export class ChangeSetError extends Error {
  constructor(
    readonly code: ChangeSetErrorCode,
    message: string,
    readonly paths: string[] = [],
  ) {
    super(message);
    this.name = "ChangeSetError";
  }
}

export type ChangeSetOptions =
  | { mode: "staged" }
  | { mode: "explicit-staged"; paths: readonly string[] }
  | { mode: "range"; base: string; head?: string };

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function normalizeSelectedPath(input: string): string {
  const platformPath = sep === "\\" ? input.replace(/\\/g, "/") : input;
  const withoutDot = platformPath.replace(/^\.\/+/, "");
  const normalized = posix.normalize(withoutDot);
  if (
    input.trim().length === 0 ||
    isAbsolute(input) ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new ChangeSetError("invalid-path", `invalid repository-relative path: ${input}`, [input]);
  }
  return normalized;
}

function currentDirty(root: string, workspace: Workspace): string[] {
  return sorted([
    ...getWorkingTreeChanges(root, workspace),
    ...getWorkingTreeDeletions(root, workspace),
  ]);
}

function basesForStaged(workspace: Workspace, changes: readonly ChangeSetEntry[]): ChangeSetBase[] {
  const prefixes = new Set<string>();
  for (const change of changes) {
    const owner = repoFor(workspace, change.path);
    if (!owner) {
      throw new GateError(`no repository owns staged path ${change.path}`, "wrong-topology");
    }
    prefixes.add(owner.member.prefix);
  }
  if (prefixes.size === 0) {
    for (const member of workspace.members) prefixes.add(member.prefix);
  }
  return workspace.members
    .filter((member) => prefixes.has(member.prefix))
    .map((member) => ({
      prefix: member.prefix,
      sha: getHeadSha(member.root) ?? EMPTY_TREE_SHA,
    }))
    .sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
}

function fingerprint(bases: readonly ChangeSetBase[], changes: readonly ChangeSetEntry[]): string {
  const payload = {
    version: 1,
    bases,
    changes: changes.map((change) => ({
      path: change.path,
      status: change.status,
      oldPath: change.oldPath ?? null,
      contentOid: change.contentOid ?? null,
      contentMode: change.contentMode ?? null,
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function project(
  mode: ChangeSetMode,
  bases: ChangeSetBase[],
  head: string,
  complete: boolean,
  changes: ChangeSetEntry[],
  unselectedStagedPaths: string[],
  dirtyOutside: string[],
): ChangeSet {
  return {
    version: 1,
    mode,
    bases,
    head,
    complete,
    changes,
    changedFiles: changes
      .filter((change) => change.status !== "deleted")
      .map((change) => change.path),
    additions: changes.filter((change) => change.status === "added").map((change) => change.path),
    deletions: changes.filter((change) => change.status === "deleted").map((change) => change.path),
    renames: changes
      .filter((change) => change.status === "renamed" && change.oldPath)
      .map((change) => ({ from: change.oldPath as string, to: change.path })),
    unselectedStagedPaths,
    dirtyOutside,
    fingerprint: fingerprint(bases, changes),
  };
}

function ensureContentOids(changes: readonly ChangeSetEntry[]): void {
  const missing = changes
    .filter((change) => change.status !== "deleted" && !change.contentOid)
    .map((change) => change.path);
  if (missing.length > 0) {
    throw new GateError(
      `git could not resolve selected content for ${missing.join(", ")}`,
      "git-failed",
    );
  }
}

function resolveStaged(
  root: string,
  options: Extract<ChangeSetOptions, { mode: "staged" | "explicit-staged" }>,
): ChangeSet {
  const workspace = resolveWorkspace(root);
  const all = getStagedChanges(root, workspace);
  let selected: IndexChange[] = all;
  let unselected: string[] = [];

  if (options.mode === "explicit-staged") {
    const requested = sorted(options.paths.map(normalizeSelectedPath));
    const matched = new Set<IndexChange>();
    const missing: string[] = [];
    for (const path of requested) {
      const change = all.find((candidate) => candidate.path === path || candidate.oldPath === path);
      if (change) matched.add(change);
      else missing.push(path);
    }
    if (missing.length > 0) {
      throw new ChangeSetError(
        "path-not-staged",
        `path${missing.length === 1 ? " is" : "s are"} not staged: ${missing.join(", ")}`,
        missing,
      );
    }
    selected = all.filter((change) => matched.has(change));
    const selectedSet = new Set(selected);
    unselected = all.filter((change) => !selectedSet.has(change)).map((change) => change.path);
  }

  ensureContentOids(selected);
  const overlaps = getIndexWorktreeOverlaps(root, selected, workspace);
  if (overlaps.length > 0) {
    throw new ChangeSetError(
      "worktree-overlap",
      `working-tree bytes differ from the selected index snapshot: ${overlaps.join(", ")}`,
      overlaps,
    );
  }

  const stagedPaths = new Set(all.map((change) => change.path));
  const dirtyOutside = currentDirty(root, workspace).filter((path) => !stagedPaths.has(path));
  const entries: ChangeSetEntry[] = selected.map((change) => ({ ...change }));
  const bases = basesForStaged(workspace, entries);
  return project(
    options.mode,
    bases,
    "INDEX",
    unselected.length === 0,
    entries,
    sorted(unselected),
    dirtyOutside,
  );
}

function resolveRange(
  root: string,
  options: Extract<ChangeSetOptions, { mode: "range" }>,
): ChangeSet {
  const workspace = resolveWorkspace(root);
  if (workspace.isWorkspace) {
    throw new ChangeSetError(
      "range-workspace",
      "a single Git range cannot name a state across multiple repositories",
    );
  }
  const head = options.head ?? "HEAD";
  const resolved = head === "INDEX" && options.base === EMPTY_TREE_SHA && !getHeadSha(root) ? { sha: EMPTY_TREE_SHA } : resolveBase(root, options.base, head === "INDEX" ? "HEAD" : head);
  const entries: ChangeSetEntry[] = head === "INDEX" ? getStagedChanges(root, workspace, resolved.sha) : changedPathsBetween(root, resolved.sha, head).map((change) => ({
    ...change,
    ...(change.status === "deleted"
      ? {}
      : getTreeEntryAtRef(root, head, change.path, workspace) ?? {}),
  }));
  ensureContentOids(entries);
  if (head === "INDEX") {
    const overlaps = getIndexWorktreeOverlaps(root, entries, workspace);
    if (overlaps.length) throw new ChangeSetError("worktree-overlap", `working-tree bytes differ from the selected index snapshot: ${overlaps.join(", ")}`, overlaps);
  }
  const bases = [{ prefix: "", sha: resolved.sha }];
  return project("range", bases, head, true, entries, [], currentDirty(root, workspace));
}

/** Resolve the exact delivery boundary all later change-control consumers share. */
export function resolveChangeSet(root: string, options: ChangeSetOptions): ChangeSet {
  return options.mode === "range" ? resolveRange(root, options) : resolveStaged(root, options);
}

/** Read a text file from the same snapshot the change set describes. */
export function readChangeSetFile(root: string, set: ChangeSet, path: string): string | null {
  if (set.mode === "range" && set.head !== "INDEX") return readBlobAtRef(root, set.head, path);
  const content = readIndexText(root, path);
  return content === null ? null : byteNormalize(content);
}
