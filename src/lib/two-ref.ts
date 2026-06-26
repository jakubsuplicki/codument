import { execFileSync } from "node:child_process";
import ts from "typescript";

// Two-ref determinism plumbing for the freshness gate. Everything here is a pure
// function of repo state at two refs — no wall clock enters any result. This
// module asserts NOTHING about the verdict (Phase 0a): it reads blobs at a ref,
// resolves a single deterministic base, byte-normalizes content, classifies
// changed paths (deletions first-class), and stamps the algorithm version.

// git's canonical empty tree object. When two refs share no common ancestor we
// diff against this, so "everything at head is new" is well-defined rather than
// an error.
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

// Bumping ALGO_VERSION (a fingerprint / identity / closure change) invalidates
// every cached anchor — a clean re-baseline, never cross-version reuse.
export const ALGO_VERSION = 1;

// The determinism unit: a verdict is reproducible only for a fixed parser, the
// exact bundled TS version, and the algo version. A TS bump changes this stamp,
// which later phases use to invalidate anchors rather than mass-stale the repo.
export function algoStamp(): string {
  return `parser=tworef;ts=${ts.version};algo=${ALGO_VERSION}`;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "ignore"],
  });
}

// Byte-normalize text before hashing: strip a leading UTF-8 BOM and fold CRLF/CR
// to LF, so the same logical content hashes identically across platforms and
// editors. JS strings are UTF-16 in memory, so encoding is implicit; this only
// removes the cross-platform line-ending and BOM variance.
export function byteNormalize(content: string): string {
  let s = content;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.replace(/\r\n?/g, "\n");
}

export type GateErrorKind = "bad-ref" | "unreachable-base" | "ambiguous-base";

// A gate-level failure that must fail CLOSED (red, blocking) — the gate could not
// run, which is distinct from "ran and passed." Branch protection requires the
// latter, so this is never swallowed into a green verdict.
export class GateError extends Error {
  constructor(
    message: string,
    readonly kind: GateErrorKind,
  ) {
    super(message);
    this.name = "GateError";
  }
}

// True when `ref` resolves to a real object in this repo. A shallow clone whose
// history does not reach the base reports false here, which the gate treats as
// fail-closed rather than fail-open.
export function refReachable(root: string, ref: string): boolean {
  try {
    git(root, ["cat-file", "-e", `${ref}^{commit}`]);
    return true;
  } catch {
    // tree-ish refs (e.g. the empty tree) do not resolve as a commit; accept those.
    try {
      git(root, ["cat-file", "-e", ref]);
      return true;
    } catch {
      return false;
    }
  }
}

// The byte-normalized content of `path` at `ref`, or null when the path does not
// exist at that ref — a first-class signal (added at head / absent at base).
// Throws GateError("bad-ref") when the ref itself is unresolvable, so a genuine
// misconfiguration fails loud instead of silently reading as "absent".
export function readBlobAtRef(
  root: string,
  ref: string,
  path: string,
): string | null {
  if (!refReachable(root, ref)) {
    throw new GateError(`ref not reachable: ${ref}`, "bad-ref");
  }
  try {
    return byteNormalize(git(root, ["show", `${ref}:${path}`]));
  } catch {
    // ref is reachable but the path is absent in it → not an error.
    return null;
  }
}

// Best-effort shallow-clone recovery: a shallow CI checkout may not reach the
// base. If `ref` is unreachable, try to deepen history from the default remote
// and re-check. This needs a remote, so in a local repo it is a no-op and the
// caller then fails closed. (The deepen path is exercised only in CI, not units.)
function deepenAndRetry(root: string, ref: string): boolean {
  if (refReachable(root, ref)) return true;
  try {
    git(root, ["fetch", "--deepen", "100"]);
  } catch {
    // no remote / offline / not shallow — fall through to fail-closed
  }
  return refReachable(root, ref);
}

export interface ResolvedBase {
  // The base to diff `head` against: a single merge-base sha, or the empty tree
  // when the refs share no common ancestor.
  sha: string;
  // True when the refs share no common ancestor (everything at head is new).
  emptyTree: boolean;
  // True when more than one merge-base existed (criss-cross) and we tie-broke.
  ambiguous: boolean;
}

// Resolve a single, deterministic base to diff `head` against. Linear history has
// exactly one merge-base. A criss-cross merge has several; we tie-break to the
// lexicographically smallest sha so the choice is reproducible (recorded via
// `ambiguous`). No common ancestor → the empty tree, so "everything is new" is
// well-defined. Fails closed if either ref is unreachable (shallow clone).
export function resolveBase(
  root: string,
  base: string,
  head: string,
): ResolvedBase {
  if (!deepenAndRetry(root, head)) {
    throw new GateError(`head not reachable: ${head}`, "unreachable-base");
  }
  if (!deepenAndRetry(root, base)) {
    throw new GateError(`base not reachable: ${base}`, "unreachable-base");
  }
  let bases: string[];
  try {
    bases = git(root, ["merge-base", "--all", base, head])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    bases = [];
  }
  if (bases.length === 0) {
    return { sha: EMPTY_TREE_SHA, emptyTree: true, ambiguous: false };
  }
  if (bases.length === 1) {
    return { sha: bases[0], emptyTree: false, ambiguous: false };
  }
  const sorted = [...bases].sort();
  return { sha: sorted[0], emptyTree: false, ambiguous: true };
}

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedPath {
  // The path at head, or the removed path for a deletion; repo-relative POSIX.
  path: string;
  status: ChangeStatus;
  // For renames, the path at base.
  oldPath?: string;
}

// Changed paths between two refs, with deletions and renames first-class (unlike
// the working-tree view, which drops deletions for ownership). The gate path must
// see a removed owned symbol as a change demanding co-movement. Sorted by path.
export function changedPathsBetween(
  root: string,
  base: string,
  head: string,
): ChangedPath[] {
  let out: string;
  try {
    out = git(root, ["diff", "--name-status", "-M", base, head]);
  } catch {
    return [];
  }
  const changes: ChangedPath[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0];
    if (code.startsWith("R")) {
      changes.push({ path: parts[2], status: "renamed", oldPath: parts[1] });
    } else if (code.startsWith("A")) {
      changes.push({ path: parts[1], status: "added" });
    } else if (code.startsWith("D")) {
      changes.push({ path: parts[1], status: "deleted" });
    } else {
      // M (modified), C (copy), T (type change) all read as a content change.
      changes.push({ path: parts[1], status: "modified" });
    }
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
