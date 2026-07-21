import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { GateError } from "./two-ref.js";

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
    // A rename/copy carries its origin path in the next NUL field — skip it.
    if (x === "R" || x === "C" || y === "R" || y === "C") i += 2;
    else i += 1;
    entries.push({ x, y, path });
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
export function listIgnoredPaths(root: string): GitPathListing {
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
    return { ok: false, reason: `git failed: ${(err as Error).message}` };
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
export function listTrackedFiles(root: string): GitPathListing {
  if (!isGitRepo(root)) return { ok: false, reason: NOT_A_REPO };
  try {
    return {
      ok: true,
      paths: git(root, ["ls-files", "-z"])
        .split("\0")
        .filter((p) => p.length > 0),
    };
  } catch (err) {
    return { ok: false, reason: `git failed: ${(err as Error).message}` };
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
export function getWorkingTreeChanges(root: string): string[] {
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
export function getWorkingTreeDeletions(root: string): string[] {
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
