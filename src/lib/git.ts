import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DEFAULT_EXCLUSION_SPEC } from "./exclusion-spec.js";
import { GateError } from "./gate-error.js";

// Git access for the diff analyzer. Codument is positioned as git-native, so we
// shell out to the already-required `git` CLI rather than add a dependency.
// GIT_OPTIONAL_LOCKS=0 keeps `git status` polling (especially from `watch`) from
// creating index lock churn that could re-trigger the agent.

// See two-ref.ts: the default 1MB maxBuffer let a large tree's git output throw
// ENOBUFS, which the catch-to-empty helpers below swallowed into a false "clean."
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

export function isGitRepo(root: string): boolean {
  try {
    return git(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Absolute path of the work-tree toplevel that contains `root`, or null when
 * git is unavailable or `root` is not inside a work tree.
 */
export function getRepoToplevel(root: string): string | null {
  try {
    const p = git(root, ["rev-parse", "--show-toplevel"]).trim();
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

// Canonical identity for a directory: symlink-stable (macOS tmpdirs live
// behind /var → /private/var) AND kernel-canonical in case/Unicode form via
// the native realpath — git's --show-toplevel reports the kernel spelling, so
// a user-typed `--dir .../caserepo` naming the on-disk `.../CaseRepo` must
// compare equal, not be falsely refused. A path that cannot be resolved is
// compared as given (it then never equals a real toplevel — a loud mismatch,
// never a false pass).
function dirIdentity(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * Assert that `root` IS the repository toplevel, not a subdirectory of it.
 * Everything codument computes is keyed by registry-relative paths under
 * `root`, while git reports toplevel-relative paths — run from a package
 * subdirectory the two can never match, so every file would read unmapped and
 * every doc fresh: the gate answering the wrong question. Fail loud instead.
 * A non-git `root` is not asserted here; each command keeps its own
 * informational non-git handling.
 */
export function assertRootIsRepoToplevel(root: string): void {
  if (!isGitRepo(root)) return;
  const toplevel = getRepoToplevel(root);
  if (!toplevel) {
    // Inside a work tree but the toplevel is unresolvable — a broken git.
    throw new GateError(`git rev-parse --show-toplevel failed under ${root}`, "git-failed");
  }
  if (dirIdentity(root) !== dirIdentity(toplevel)) {
    throw new GateError(
      `${root} is a subdirectory of the git repository at ${toplevel}; ` +
        `codument must run at the repository root — run it from ${toplevel}`,
      "wrong-root",
    );
  }
}

/**
 * The current HEAD commit sha (full 40-char), or null when there is no commit
 * yet (a fresh repo), git is unavailable, or the directory is not a repo. Used
 * as provenance on a `caught` snapshot — the commit a pending change sits on at
 * the moment review logged it — not as a dedup key.
 */
export function getHeadSha(root: string): string | null {
  if (!isGitRepo(root)) return null;
  try {
    const sha = git(root, ["rev-parse", "HEAD"]).trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * The configured git identity for this repo ("Name <email>", or whichever of
 * name/email is set). Used as the default ack signer and to detect a self-ack
 * (signer == change author). Returns null when git is unavailable or no identity
 * is configured, so the caller falls back to a generic "agent" rather than
 * fabricating attribution.
 */
export function getGitAuthor(root: string): string | null {
  if (!isGitRepo(root)) return null;
  const read = (key: string): string | null => {
    try {
      const v = git(root, ["config", key]).trim();
      return v.length > 0 ? v : null;
    } catch {
      return null;
    }
  };
  const name = read("user.name");
  const email = read("user.email");
  if (name && email) return `${name} <${email}>`;
  return name ?? email ?? null;
}

/**
 * The commit authors ("Name <email>") of the commits in `base..head` — the people
 * who actually MADE the change under review, read from the commit graph. This is a
 * pure function of repo state (unlike `getGitAuthor`, which reads the ambient
 * `git config user.*` of whoever runs the command), so it is the correct source of
 * "the change author" for detecting a self-ack: an ack whose signer is one of these
 * authors is a self-adjudication, wherever the review runs. An empty range (a
 * pending working-tree diff with no commits, where authorship is not yet recorded)
 * returns an empty set, so independence stays conservatively unproven rather than
 * keyed to the current process identity. Never throws — an unreachable ref or git
 * failure yields the empty set.
 */
export function getChangeAuthors(root: string, base: string, head = "HEAD"): Set<string> {
  try {
    const out = git(root, ["log", "--format=%an <%ae>", `${base}..${head}`]);
    return new Set(
      out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    );
  } catch {
    return new Set();
  }
}

interface StatusEntry {
  x: string;
  y: string;
  path: string;
  /** For a rename/copy, the path it came FROM. Absent otherwise. Git reports this
   *  as a separate NUL field, and it used to be consumed and thrown away — which
   *  is why a `git mv` presented to the gate as a bare add, leaving the registry
   *  pointing at a path that no longer exists with nothing to notice. */
  origin?: string;
}

/** A path that moved: git's own rename detection, never a similarity guess of
 *  ours. Both halves matter — `to` is the change to judge, `from` is the path any
 *  registry entry naming it has just been left pointing at. */
export interface RenamePair {
  from: string;
  to: string;
}

// A COPY is not a move. Git reports `C` alongside `R` when copy detection is on
// (`status.renames copies`), and both carry an origin path — but a copy's origin
// is still right there, so treating one as a rename says a present file was
// removed AND reads the new file's base content from the original, laundering an
// entirely new contract as unchanged. `R` only, which is also what the ref-ranged
// twin (`worktreeRenamesSince`) has always matched: the two listers must not
// disagree about what moved.
function isRenameEntry(e: StatusEntry): boolean {
  return e.x === "R" || e.y === "R";
}

/**
 * The subset of `pairs` that are genuinely MOVES: git's rename detection is a
 * similarity pass over one side of the change, so it can pair an origin that is
 * still present at head. The routine case is a file split — `git mv a b`, then
 * re-create `a` as a re-export shim — where git reports the rename AND an
 * untracked `a`. Judged as a move, that says a file you can see on disk was
 * removed, and no registry state clears it (dropping the entry makes the shim
 * unmapped; keeping it re-fires the finding). A move is a pair whose origin is
 * gone, so the origin must not appear in the change set as a path of its own.
 */
export function movesOnly(
  pairs: readonly RenamePair[],
  presentAtHead: ReadonlySet<string>,
): RenamePair[] {
  return pairs.filter((p) => !presentAtHead.has(p.from));
}

// Parse `git status --porcelain -z` into entries. NUL-terminated output disables
// git's C-style path quoting entirely, so a non-ASCII or space-bearing path (e.g.
// `src/föo.ts`) arrives verbatim instead of octal-escaped and silently dropped
// from the verdict. It also removes the rename " -> " ambiguity: a rename/copy
// entry is followed by its origin path as a separate NUL field, which we consume
// but never treat as a change of its own. The current (post-rename) path is the
// field on the status entry itself.
function parseStatusZ(out: string): StatusEntry[] {
  const tokens = out.split("\0");
  const entries: StatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (!tok) {
      i++;
      continue;
    }
    const x = tok[0];
    const y = tok[1];
    const path = tok.slice(3); // "XY " prefix (two status chars + a space)
    // A rename/copy carries its origin path in the next NUL field. It is consumed
    // either way (it is not a change of its own), but it is KEPT: the vanished
    // path is the whole point of a rename for anything that holds a path. The
    // consume test is deliberately WIDER than `isRenameEntry` — a copy's origin
    // field is still on the wire, so failing to eat it would desync every
    // following entry — while only `R` is a move.
    const rename = x === "R" || x === "C" || y === "R" || y === "C";
    const origin = rename ? tokens[i + 1] : undefined;
    i += rename ? 2 : 1;
    entries.push(origin ? { x, y, path, origin } : { x, y, path });
  }
  return entries;
}

function sortPaths(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The result of asking git to enumerate a set of paths.
 *
 * `ok: false` means "could not determine", which is NOT the same answer as an
 * empty `paths` list ("determined; there are none"). Collapsing the two is how a
 * non-repo root silently became "nothing is ignored" and published a coverage
 * denominator full of build output — the conflation ADR-003 forbids by name
 * ("'the gate could not run' is distinguishable from 'the gate ran and passed'").
 * Callers that legitimately degrade must do so explicitly, at their own seam.
 */
export type GitPathListing =
  | { ok: true; paths: string[] }
  | { ok: false; reason: string };

/**
 * A stable `reason` for a failed git invocation. Node's own error text
 * ("Command failed: <argv>") is an internal formatting detail that is not
 * contractually stable across Node majors, and this reason reaches a machine
 * surface (`doctor --json`'s `scope.reason`) that a CI job may diff — so the
 * redundant prefix is stripped and ours is the one we own. The argv itself is
 * fixed, and `git()` pipes stderr to /dev/null, so no cwd, PID, locale, or
 * stderr text can vary the result for identical repo state.
 */
function gitFailureReason(err: unknown): string {
  const detail = (err as Error).message.replace(/^Command failed: /, "");
  return `git failed: ${detail}`;
}

/** The reason string for a root git cannot read as a repository. */
export const NOT_A_REPO = "not a git repository";

/**
 * Paths git ignores, repo-relative and POSIX. Wholly-ignored directories are
 * collapsed to a single entry (e.g. `node_modules`, `.nuxt`) via `--directory`
 * instead of listing every file, so this stays cheap even on large trees.
 *
 * Used to keep generated/build/vendored files (which are gitignored by
 * convention and never hand-maintained) out of the documentation-coverage scope.
 * A non-repo root or a broken `git` yields `ok: false` — the caller decides what
 * an undeterminable ignore set means for its own surface.
 */
function listIgnoredPathsIn(root: string): GitPathListing {
  if (!isGitRepo(root)) return { ok: false, reason: NOT_A_REPO };
  let out: string;
  try {
    out = git(root, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]);
  } catch (err) {
    return { ok: false, reason: gitFailureReason(err) };
  }
  const paths = new Set<string>();
  for (const entry of out.split("\0")) {
    if (!entry) continue;
    // `--directory` appends a trailing slash to collapsed dirs; normalise it off.
    paths.add(entry.replace(/\/$/, ""));
  }
  return { ok: true, paths: sortPaths(paths) };
}

/**
 * Every tracked path at HEAD, repo-relative and POSIX. The adapter warm-up's
 * cheap "does this repo plausibly contain language X" probe — read-only, no
 * verdict input. `ok: false` outside a repo or on a broken read; the warm caller
 * unions this with the registry's own sources precisely because git's view is
 * not authoritative over what the analyzers will parse (a nested member repo's
 * files, and untracked-but-mapped files, are invisible here). The gate path
 * itself stays fail-loud — a cold adapter raises rather than coarsens.
 */
function listTrackedFilesIn(root: string): GitPathListing {
  if (!isGitRepo(root)) return { ok: false, reason: NOT_A_REPO };
  try {
    return {
      ok: true,
      paths: git(root, ["ls-files", "-z"])
        .split("\0")
        .filter((p) => p.length > 0),
    };
  } catch (err) {
    return { ok: false, reason: gitFailureReason(err) };
  }
}

/**
 * Changed paths in the working tree (modified, added, renamed, and untracked),
 * repo-relative and POSIX, sorted and deduped. Deletions are excluded from THIS
 * list because it carries extant paths only; they are a first-class change in
 * their own right and travel via getWorkingTreeDeletions →
 * ChangeStateInput.deletedFiles, where a deleted owned source wakes its owners'
 * docs. Returns an empty array when the directory is not a repo.
 */
function getWorkingTreeChangesIn(root: string): string[] {
  if (!isGitRepo(root)) return [];
  let out: string;
  try {
    out = git(root, ["status", "--porcelain", "-z", "-uall"]);
  } catch (err) {
    // Fail closed: `git status` does not legitimately fail inside a work tree, so
    // a throw is a broken/oversized invocation. Never read it as "Working tree
    // clean" — that silently passes the gate on a repo it could not see.
    throw new GateError(`git status failed: ${(err as Error).message}`, "git-failed");
  }
  const files = new Set<string>();
  for (const e of parseStatusZ(out)) {
    // Skip pure deletions — a removed file is not a change to review for
    // ownership/doc-drift. A rename (status R) reports its post-rename path and
    // counts as a change; parseStatusZ has already consumed its origin field.
    if (e.x === "D" || e.y === "D") continue;
    files.add(e.path);
  }
  return sortPaths(files);
}

/**
 * Pure deletions in the working tree (a file removed, no rename), repo-relative
 * POSIX, sorted. The complement of getWorkingTreeChanges (which carries extant
 * paths only). Both gates consume these: the change-control gate wakes a deleted
 * owned source's docs file-grain, and the adversarial-review gate counts a
 * deletion toward proportionality and the review fingerprint.
 */
function getWorkingTreeDeletionsIn(root: string): string[] {
  if (!isGitRepo(root)) return [];
  let out: string;
  try {
    out = git(root, ["status", "--porcelain", "-z", "-uall"]);
  } catch (err) {
    // Fail closed for the same reason as getWorkingTreeChanges.
    throw new GateError(`git status failed: ${(err as Error).message}`, "git-failed");
  }
  const files = new Set<string>();
  for (const e of parseStatusZ(out)) {
    // A pure deletion is D in either column; a rename (R) is not a deletion of
    // its new path, so it is excluded here and counted as a change instead.
    if (e.x === "D" || e.y === "D") files.add(e.path);
  }
  return sortPaths(files);
}

/**
 * Renames in the working tree as `{from, to}` pairs, sorted by destination. A
 * rename is neither a bare add nor a bare delete: `to` already travels as a
 * change, but `from` travelled nowhere at all, so a registry entry naming it was
 * left pointing at a vanished path with no signal anywhere. Detection is entirely
 * git's (`status` reports R/C after its own similarity pass) — we add no
 * heuristic of our own, so what the gate sees is what git saw.
 */
function getWorkingTreeRenamesIn(root: string): RenamePair[] {
  if (!isGitRepo(root)) return [];
  let out: string;
  try {
    out = git(root, ["status", "--porcelain", "-z", "-uall"]);
  } catch (err) {
    // Fail closed for the same reason as getWorkingTreeChanges: a status that
    // throws must never read as "nothing moved".
    throw new GateError(`git status failed: ${(err as Error).message}`, "git-failed");
  }
  const pairs: RenamePair[] = [];
  for (const e of parseStatusZ(out)) {
    if (isRenameEntry(e) && e.origin) pairs.push({ from: e.origin, to: e.path });
  }
  return sortRenames(pairs);
}

function sortRenames(pairs: RenamePair[]): RenamePair[] {
  const seen = new Set<string>();
  const out: RenamePair[] = [];
  for (const p of pairs) {
    const key = `${p.from}\0${p.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.sort((a, b) =>
    a.to !== b.to ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : a.from > b.from ? 1 : 0,
  );
}

/**
 * Absolute path of the directory git will actually read hooks from — honors
 * `core.hooksPath` and linked worktrees, because `rev-parse --git-path hooks`
 * resolves both. Null when git is unavailable or `root` is not a repository,
 * so the caller can say "not a repo" rather than guess at `.git/hooks`.
 */
export function getHooksDir(root: string): string | null {
  if (!isGitRepo(root)) return null;
  try {
    const p = git(root, ["rev-parse", "--git-path", "hooks"]).trim();
    if (p.length === 0) return null;
    return isAbsolute(p) ? p : resolve(root, p);
  } catch {
    return null;
  }
}

// ── Workspaces (nested member repositories) ─────────────────────────────
//
// A single work tree is opaque to the one containing it: `git ls-files` in an
// outer repo reports a nested repository as a gitlink — one path, no extension,
// no contents — and `ls-files --ignored` reports nothing inside it at all. So a
// monorepo whose packages are their own repositories (and a super-repo with
// submodules) presents every git helper here with a view that is missing most of
// the tree, silently. The gate then answers over what it could see and calls it
// an answer, which is the one failure a change-control gate must not have.
//
// The fix is one seam rather than per-caller patches: resolve the member repos
// once, aggregate each member's own git answers, and prefix them back to
// workspace-root-relative paths. Every existing helper keeps its meaning; only
// the scope it reads over widens. A classic single repo resolves to exactly one
// member at the root and takes the same code path it always did.

export interface WorkspaceMember {
  /** Workspace-root-relative POSIX prefix; "" for a repository at the root. */
  prefix: string;
  /** Absolute path of the member's work tree. */
  root: string;
}

// Memoized because a member walk is a filesystem traversal and every git helper
// below wants the answer. Resolving per call turned each `git status` into a
// full tree walk — the discovery has to be cheap enough that no caller is
// tempted to skip it and fall back to a single-repo view.
const workspaceCache = new Map<string, Workspace>();

export interface Workspace {
  /** Absolute path of the workspace root (which may not be a repository). */
  root: string;
  /** Member repositories, deterministically ordered by prefix. */
  members: WorkspaceMember[];
  /**
   * Prefixes of gitlinks with no work tree (an uninitialized submodule). They
   * contribute no paths — never fabricated — and are named so a surface can say
   * why a subtree is missing rather than reporting it as empty.
   */
  uninitialized: string[];
  /**
   * Workspace-relative prefixes the member walk could not read. A member
   * repository could be hiding under any of them, so the member list is a floor
   * rather than the count whenever this is non-empty.
   */
  unreadable: string[];
  /**
   * True when git truth must be aggregated: more than one member, or a single
   * member that is not the root. A plain repository at the root is false, and
   * takes the pre-workspace code path unchanged.
   */
  isWorkspace: boolean;
}

/** Whether `dir` is the top of a work tree (a `.git` dir, or a file for a
 *  submodule or linked worktree). */
function hasGitEntry(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/**
 * Find every member repository under `root`, deterministically ordered.
 *
 * The walk prunes on the resolved exclusion dirs, so `node_modules` and build
 * trees are never descended — which is what keeps this affordable enough to run
 * once per command (and once per monitor tick). It DOES descend into a member to
 * find members nested inside it, because the same opacity applies one level
 * down: a submodule inside a package repo is invisible to that package repo the
 * same way the package repo is invisible to the root.
 */
export function resolveWorkspace(
  root: string,
  excludeDirs: string[] = DEFAULT_EXCLUSION_SPEC.dirs,
): Workspace {
  const cached = workspaceCache.get(root);
  if (cached) return cached;
  const skip = new Set(excludeDirs);
  const members: WorkspaceMember[] = [];
  const uninitialized: string[] = [];
  const unreadable: string[] = [];
  const rootIdentity = dirIdentity(root);

  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // Absent is not unreadable (a directory that vanished mid-walk).
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      // Unreadable subtree: it contributes no members — never fabricated — but
      // it is REPORTED, exactly as the analyzer's walker reports one. A member
      // repository can hide under a directory the process cannot open, and its
      // absence would otherwise present a short member list as the whole
      // workspace, taking the aggregated ignore rules down with it.
      unreadable.push(prefix || ".");
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || skip.has(entry.name)) continue;
      const childPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      const childDir = join(dir, entry.name);
      if (hasGitEntry(childDir)) {
        // A `.git` FILE with no readable work tree is an uninitialized submodule:
        // the gitlink is there, the contents are not.
        if (isGitRepo(childDir)) members.push({ prefix: childPrefix, root: childDir });
        else uninitialized.push(childPrefix);
      }
      walk(childDir, childPrefix);
    }
  };

  // The root is a member when it is itself a repository — but not when it is a
  // SUBDIRECTORY of one. That case is refused elsewhere, loudly; silently
  // treating it as a member here would launder the refusal.
  //
  // An unresolvable toplevel is deliberately NOT read as "subdirectory". git
  // said we are inside a work tree, so a repository is here; a toplevel that
  // will not resolve means git is broken, and demoting that to "no member" would
  // make the whole aggregate answer "not a git repository" — reporting a failure
  // as an absence, the one conflation this seam exists to prevent.
  // (`assertRootIsRepoToplevel` still raises on this case for the commands that
  // must not run at all.)
  const rootIsRepo = isGitRepo(root);
  const rootTop = rootIsRepo ? getRepoToplevel(root) : null;
  const rootIsMember =
    rootIsRepo && (rootTop === null || dirIdentity(rootTop) === rootIdentity);
  if (rootIsMember) members.push({ prefix: "", root });
  walk(root, "");

  members.sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
  uninitialized.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const workspace: Workspace = {
    root,
    members,
    uninitialized,
    unreadable: [...new Set(unreadable)].sort(),
    isWorkspace: members.length > 1 || (members.length === 1 && members[0].prefix !== ""),
  };
  workspaceCache.set(root, workspace);
  return workspace;
}

/**
 * Forget the memoized shape of a root. A CLI invocation is short-lived and its
 * member set cannot change under it, so the memo is normally permanent; the two
 * callers that outlive one answer are the live monitor (a member repo could be
 * cloned mid-session) and the test suite (which builds and rebuilds fixtures at
 * one path).
 */
export function forgetWorkspace(root?: string): void {
  if (root === undefined) workspaceCache.clear();
  else workspaceCache.delete(root);
}

/**
 * The member that owns a workspace-relative path, and that path rewritten
 * relative to the member's own work tree.
 *
 * Longest prefix wins, so a path inside a submodule routes to the submodule
 * rather than to the repository containing it — the same precedence the
 * aggregation uses when it drops an outer repo's gitlink entry in favor of the
 * member's own expansion. Null when no member owns the path (a file sitting in
 * a non-repository workspace root).
 */
export function repoFor(
  workspace: Workspace,
  relPath: string,
): { member: WorkspaceMember; relPath: string } | null {
  let best: WorkspaceMember | null = null;
  for (const member of workspace.members) {
    if (member.prefix === "") {
      if (best === null) best = member;
      continue;
    }
    if (relPath === member.prefix || relPath.startsWith(member.prefix + "/")) {
      if (best === null || member.prefix.length > best.prefix.length) best = member;
    }
  }
  if (!best) return null;
  const relative =
    best.prefix === "" ? relPath : relPath.slice(best.prefix.length + 1);
  return { member: best, relPath: relative };
}

// ── Aggregation over members ────────────────────────────────────────────
//
// Each helper below answers over the whole workspace by asking every member its
// own git question and prefixing the answers back. Two rules make the result
// honest rather than merely bigger:
//
//   1. A gitlink entry the OUTER repo reports for a member directory is dropped,
//      because the member's own expansion replaces it. This is the rule that
//      kills the false green: an edit inside a member surfaced to the outer repo
//      as `M child` — one extension-less path — which the source-file test
//      rejected into the "other changed" bucket, so the stale-doc verdict never
//      fired while `--strict` exited 0. The member now reports `child/src/app.py`
//      and the verdict sees a real source change.
//   2. One member failing is the whole answer failing, named. A partial result
//      presented as whole is the same conflation the typed listing exists to
//      prevent, one level up.

/** True when `relPath` is exactly a member's directory (the gitlink entry).
 *  `git status` reports an as-yet-unadded embedded repo as `child/` with a
 *  trailing slash, so normalize it off before the compare or the placeholder
 *  leaks past the drop the aggregation exists to perform. */
function isMemberDir(workspace: Workspace, relPath: string): boolean {
  const bare = relPath.replace(/\/$/, "");
  return workspace.members.some((m) => m.prefix !== "" && m.prefix === bare);
}

function prefixed(prefix: string, path: string): string {
  return prefix ? `${prefix}/${path}` : path;
}

function aggregateListing(
  workspace: Workspace,
  perMember: (memberRoot: string) => GitPathListing,
): GitPathListing {
  if (workspace.members.length === 0) return { ok: false, reason: NOT_A_REPO };
  const paths: string[] = [];
  for (const member of workspace.members) {
    const result = perMember(member.root);
    if (!result.ok) {
      return {
        ok: false,
        reason:
          member.prefix === ""
            ? result.reason
            : `${member.prefix}: ${result.reason}`,
      };
    }
    for (const path of result.paths) {
      const full = prefixed(member.prefix, path);
      if (isMemberDir(workspace, full)) continue;
      paths.push(full);
    }
  }
  return { ok: true, paths: sortPaths(paths) };
}

function aggregateChanges(
  workspace: Workspace,
  perMember: (memberRoot: string) => string[],
): string[] {
  const paths: string[] = [];
  for (const member of workspace.members) {
    for (const path of perMember(member.root)) {
      const full = prefixed(member.prefix, path);
      if (isMemberDir(workspace, full)) continue;
      paths.push(full);
    }
  }
  return sortPaths(paths);
}

/**
 * Paths git ignores, workspace-relative and POSIX — the union over every member
 * repository, each answering with its own ignore rules. Shelling to each member's
 * git (rather than parsing `.gitignore` files) is what keeps the semantics
 * exactly git's: `core.excludesFile`, `.git/info/exclude`, and precedence all
 * come along, where a reimplementation would drift.
 *
 * A non-repo root with no members, or a member whose git failed, yields
 * `ok: false` — the caller decides what an undeterminable ignore set means.
 */
export function listIgnoredPaths(
  root: string,
  workspace: Workspace = resolveWorkspace(root),
): GitPathListing {
  return aggregateListing(workspace, listIgnoredPathsIn);
}

/** Every tracked path across the workspace. See `listIgnoredPaths` for the
 *  aggregation rules; this one feeds the adapter warm probe. */
export function listTrackedFiles(
  root: string,
  workspace: Workspace = resolveWorkspace(root),
): GitPathListing {
  return aggregateListing(workspace, listTrackedFilesIn);
}

/**
 * Changed paths across the workspace (modified, added, renamed, untracked),
 * workspace-relative POSIX, sorted and deduped. Deletions travel separately.
 * Fails closed exactly as the single-repo read does: a `git status` that throws
 * inside any member raises rather than reading as clean.
 */
export function getWorkingTreeChanges(
  root: string,
  workspace: Workspace = resolveWorkspace(root),
): string[] {
  return aggregateChanges(workspace, getWorkingTreeChangesIn);
}

/** Pure deletions across the workspace. See `getWorkingTreeChanges`. */
export function getWorkingTreeDeletions(
  root: string,
  workspace: Workspace = resolveWorkspace(root),
): string[] {
  return aggregateChanges(workspace, getWorkingTreeDeletionsIn);
}

/**
 * Renames across the workspace, workspace-relative POSIX. Both halves of a pair
 * carry the same member prefix — a rename is always within one repository, since
 * git cannot see across a member boundary — so a member-local move surfaces to the
 * workspace root with its origin intact.
 */
export function getWorkingTreeRenames(
  root: string,
  workspace: Workspace = resolveWorkspace(root),
): RenamePair[] {
  const pairs: RenamePair[] = [];
  for (const member of workspace.members) {
    for (const p of getWorkingTreeRenamesIn(member.root)) {
      const from = prefixed(member.prefix, p.from);
      const to = prefixed(member.prefix, p.to);
      if (isMemberDir(workspace, to)) continue;
      pairs.push({ from, to });
    }
  }
  return sortRenames(pairs);
}

/**
 * A root the gate can run over: a repository, or a workspace of member
 * repositories under a (possibly non-repo) root. The field monorepo — no
 * repository at the root, packages that are each their own repo — is the second
 * case, and was previously refused as "not a git repository" despite every
 * member being perfectly readable.
 */
export function isGateableRoot(root: string): boolean {
  return isGitRepo(root) || resolveWorkspace(root).isWorkspace;
}

/**
 * Each member's current HEAD sha, workspace-order. The reproducibility record a
 * workspace verdict prints in place of the single base sha a plain repo prints:
 * a workspace state is the tuple of its members' heads, so any run is
 * reproducible from the list. A member with no commit yet contributes the empty
 * tree, named.
 */
export function workspaceBases(
  workspace: Workspace,
): Array<{ prefix: string; sha: string }> {
  return workspace.members.map((m) => ({
    prefix: m.prefix,
    sha: getHeadSha(m.root) ?? "(no commit)",
  }));
}
