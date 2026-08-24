import { createHash } from "node:crypto";
import { isAbsolute, posix, sep } from "node:path";
import {
  getBlobOidAtRef,
  getHeadSha,
  getIndexWorktreeOverlaps,
  getStagedChanges,
  getWorkingTreeChanges,
  getWorkingTreeDeletions,
  repoFor,
  resolveWorkspace,
  type IndexChange,
  type Workspace,
} from "./git.js";
import { GateError } from "./gate-error.js";
import {
  changedPathsBetween,
  EMPTY_TREE_SHA,
  resolveBase,
} from "./two-ref.js";

export type ChangeSetMode = "staged" | "explicit-staged" | "range";

export interface ChangeSetEntry {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  /** Git object id of the exact selected content. Absent for deletions. */
  contentOid?: string;
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

function basesForStaged(
  workspace: Workspace,
  changes: readonly ChangeSetEntry[],
): ChangeSetBase[] {
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
    changedFiles: changes.filter((change) => change.status !== "deleted").map((change) => change.path),
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
    throw new GateError(`git could not resolve selected content for ${missing.join(", ")}`, "git-failed");
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
  const resolved = resolveBase(root, options.base, head);
  const entries: ChangeSetEntry[] = changedPathsBetween(root, resolved.sha, head).map((change) => ({
    ...change,
    ...(change.status === "deleted"
      ? {}
      : { contentOid: getBlobOidAtRef(root, head, change.path, workspace) ?? undefined }),
  }));
  ensureContentOids(entries);
  const bases = [{ prefix: "", sha: resolved.sha }];
  return project(
    "range",
    bases,
    head,
    true,
    entries,
    [],
    currentDirty(root, workspace),
  );
}

/** Resolve the exact delivery boundary all later change-control consumers share. */
export function resolveChangeSet(root: string, options: ChangeSetOptions): ChangeSet {
  return options.mode === "range" ? resolveRange(root, options) : resolveStaged(root, options);
}
