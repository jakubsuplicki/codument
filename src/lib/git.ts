import { execFileSync } from "node:child_process";
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
 * Paths git ignores, repo-relative and POSIX. Wholly-ignored directories are
 * collapsed to a single entry (e.g. `node_modules`, `.nuxt`) via `--directory`
 * instead of listing every file, so this stays cheap even on large trees.
 * Returns an empty array when `git` is unavailable or the directory is not a repo.
 *
 * Used to keep generated/build/vendored files (which are gitignored by
 * convention and never hand-maintained) out of the documentation-coverage scope.
 */
export function listIgnoredPaths(root: string): string[] {
  if (!isGitRepo(root)) return [];
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
  } catch {
    return [];
  }
  const paths = new Set<string>();
  for (const entry of out.split("\0")) {
    if (!entry) continue;
    // `--directory` appends a trailing slash to collapsed dirs; normalise it off.
    paths.add(entry.replace(/\/$/, ""));
  }
  return sortPaths(paths);
}

/**
 * Changed paths in the working tree (modified, added, renamed, and untracked),
 * repo-relative and POSIX, sorted and deduped. Deletions are excluded — a deleted
 * file is not a "change to review" for ownership/doc-drift purposes. Returns an
 * empty array when `git` is unavailable or the directory is not a repo.
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
 * POSIX, sorted. The complement of getWorkingTreeChanges, which drops these for
 * the ownership/doc-drift view. The adversarial-review gate needs them: a
 * deletion is a real, load-bearing change that must count toward proportionality
 * and move the review fingerprint.
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
