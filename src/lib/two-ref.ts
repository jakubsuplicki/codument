import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import ts from "typescript";
import { GateError, type GateErrorKind } from "./gate-error.js";
import { resolveWorkspace, repoFor } from "./git.js";
import { type GrammarManifestEntry, grammarManifest } from "./tree-sitter.js";

// Re-exported so every existing importer keeps its import path; the type now
// lives in a leaf module both this and the git seam can depend on.
export { GateError, type GateErrorKind };

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
// v2: precise TS anchors split into a signature hash + a body hash and the
// composite is recomposed over the pair, so a recorded per-symbol ack (which
// binds a composite transition) auto-invalidates on upgrade — the intended
// one-time reset. (Coarse and module-residual formats are unchanged, so acks
// bound to those legitimately survive.)
// v3: each precise anchor span is rendered through the local-identifier
// canonicalizer before hashing (a name bound within the declaration becomes a
// positional index), so a meaning-preserving local rename no longer moves the
// composite. v2 and v3 are both post-0.7.0 (unreleased), so users cross one
// fingerprint-universe shift, not two.
export const ALGO_VERSION = 4;

// The determinism unit: a verdict is reproducible only for a fixed parser, the
// exact bundled TS version, the algo version, and — once any adapter bundles a
// grammar — the exact bundled grammar set. A TS bump changes this stamp, which
// later phases use to invalidate anchors rather than mass-stale the repo; a
// grammar upgrade is the same algo-visible event for its language. The segment
// is a digest over (language, content hash) pairs sorted here (codepoint order,
// caller-independent) and is OMITTED while no grammar ships, so TS-only
// installs cross no stamp shift before the first adapter release.
export function algoStamp(manifest: readonly GrammarManifestEntry[] = grammarManifest()): string {
  const base = `parser=tworef;ts=${ts.version};algo=${ALGO_VERSION}`;
  if (manifest.length === 0) return base;
  const lines = manifest
    .map((m) => `${m.language}:${m.sha256}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
  return `${base};grammars=${digest}`;
}

// execFileSync's default maxBuffer is 1MB; git output on a large tree (e.g.
// `status --porcelain` with tens of thousands of untracked files) exceeds it and
// throws ENOBUFS. Without a generous cap that throw was swallowed into an empty
// change set — the gate reading green because it could not see the repo. 512MB
// is a limit, not a preallocation, so it costs nothing on small repos.
const GIT_MAX_BUFFER = 512 * 1024 * 1024;

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: GIT_MAX_BUFFER,
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

// Route a (ref, path) read to the member repository that owns the path, with the
// path rewritten relative to that member. In a plain single repo this returns
// (root, path) unchanged. In a workspace, `HEAD` names *that member's* HEAD —
// which is the whole point: an edit inside a member is diffed against the
// member's own history, not against a root sha that does not exist there. A ref
// that is a concrete sha only ever reaches here in single-repo mode, because
// ref-ranged review across a workspace is refused before this point (a single
// sha cannot name a state of several repositories).
function routeRead(root: string, path: string): { repoRoot: string; relPath: string } {
  const workspace = resolveWorkspace(root);
  if (!workspace.isWorkspace) return { repoRoot: root, relPath: path };
  const owner = repoFor(workspace, path);
  // A path no member owns (a loose file under a non-repo workspace root) has no
  // ref to be read at; leaving it as-is lets the read fail loud rather than be
  // silently attributed to some member.
  return owner ? { repoRoot: owner.member.root, relPath: owner.relPath } : { repoRoot: root, relPath: path };
}

// True when `path` exists at `ref`, with honest failure semantics: an absent
// path is git's clean "no" (exit 0, empty ls-tree output), while a broken git
// invocation or unresolvable ref THROWS — a caller can never read "could not
// look" as "absent". readBlobAtRef below cannot make this distinction (its
// `git show` catch conflates absence with failure), so a caller whose FALLBACK
// on absence is more permissive than its failure path must check here first.
export function blobExistsAtRef(root: string, ref: string, path: string): boolean {
  const { repoRoot, relPath } = routeRead(root, path);
  try {
    return git(repoRoot, ["ls-tree", ref, "--", relPath]).trim().length > 0;
  } catch (err) {
    throw new GateError(
      `git ls-tree ${ref} -- ${path} failed: ${(err as Error).message}`,
      "git-failed",
    );
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
  const { repoRoot, relPath } = routeRead(root, path);
  if (!refReachable(repoRoot, ref)) {
    throw new GateError(`ref not reachable: ${ref}`, "bad-ref");
  }
  try {
    return byteNormalize(git(repoRoot, ["show", `${ref}:${relPath}`]));
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

interface DiffEntry {
  code: string;
  // The path at head — the new path for a rename/copy, the path otherwise.
  path: string;
  // The path at base, for a rename/copy.
  oldPath?: string;
}

// Parse `git diff --name-status -z` into entries. NUL framing disables git's
// C-style path quoting, so a non-ASCII path (e.g. `src/föo.ts`) arrives verbatim
// instead of octal-escaped and silently dropped from the verdict. Unlike
// `status -z`, diff keeps from→to order: a rename/copy is
// `<code>\0<oldPath>\0<newPath>\0`; every other status is `<code>\0<path>\0`.
function parseDiffNameStatusZ(out: string): DiffEntry[] {
  const tokens = out.split("\0");
  const entries: DiffEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i];
    if (!code) {
      i++; // trailing NUL leaves an empty final token
      continue;
    }
    if (code.startsWith("R") || code.startsWith("C")) {
      entries.push({ code, path: tokens[i + 2], oldPath: tokens[i + 1] });
      i += 3;
    } else {
      entries.push({ code, path: tokens[i + 1] });
      i += 2;
    }
  }
  return entries;
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
    out = git(root, ["diff", "--name-status", "-M", "-z", base, head]);
  } catch (err) {
    // Fail closed: with valid refs this diff does not legitimately fail, so a
    // throw here is a broken/oversized git invocation, never "no changes."
    throw new GateError(
      `git diff ${base}..${head} failed: ${(err as Error).message}`,
      "git-failed",
    );
  }
  const changes: ChangedPath[] = [];
  for (const e of parseDiffNameStatusZ(out)) {
    if (e.code.startsWith("R")) {
      changes.push({ path: e.path, status: "renamed", oldPath: e.oldPath });
    } else if (e.code.startsWith("A")) {
      changes.push({ path: e.path, status: "added" });
    } else if (e.code.startsWith("D")) {
      changes.push({ path: e.path, status: "deleted" });
    } else {
      // M (modified), C (copy), T (type change) all read as a content change;
      // for a copy the new path is what appeared, which parseDiffNameStatusZ
      // reports as `path`.
      changes.push({ path: e.path, status: "modified" });
    }
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// Pure deletions between the merge-base of (base, HEAD) and the working tree —
// the deletions worktreeChangesSince drops. The adversarial-review gate counts a
// deletion as a real change. Throws GateError when `base` is unreachable.
export function worktreeDeletionsSince(root: string, base: string): string[] {
  const { sha } = resolveBase(root, base, "HEAD");
  const files = new Set<string>();
  try {
    const out = git(root, ["diff", "--name-status", "-M", "-z", sha]);
    for (const e of parseDiffNameStatusZ(out)) {
      if (e.code.startsWith("D")) files.add(e.path);
    }
  } catch {
    // no diff available
  }
  return [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Paths changed between the merge-base of (base, HEAD) and the current working
// tree — the LOCAL two-ref advisory view: everything on this branch since it
// diverged from `base`, committed or not, which is the same question CI answers
// head↔merge-base. Deletions are excluded here because `changedFiles` carries
// extant paths only; they travel as the SEPARATE first-class input
// (worktreeDeletionsSince → ChangeStateInput.deletedFiles), where a deleted
// owned source wakes its owners' docs. Returns sorted, deduped, repo-relative
// paths. Throws GateError when `base` is unreachable.
export function worktreeChangesSince(root: string, base: string): string[] {
  const { sha } = resolveBase(root, base, "HEAD");
  const files = new Set<string>();
  // tracked changes from the merge-base to the working tree (committed + uncommitted)
  try {
    const out = git(root, ["diff", "--name-status", "-M", "-z", sha]);
    for (const e of parseDiffNameStatusZ(out)) {
      if (e.code.startsWith("D")) continue;
      // parseDiffNameStatusZ already reports the new path for a rename/copy.
      files.add(e.path);
    }
  } catch {
    // no diff available — fall through to untracked only
  }
  // untracked files (new, not yet added) are also "changed since base"
  try {
    const out = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const p of out.split("\0")) {
      if (p) files.add(p);
    }
  } catch {
    // ignore
  }
  return [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
