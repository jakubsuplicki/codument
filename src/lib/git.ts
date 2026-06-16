import { execFileSync } from "node:child_process";

// Git access for the diff analyzer. Codument is positioned as git-native, so we
// shell out to the already-required `git` CLI rather than add a dependency.
// GIT_OPTIONAL_LOCKS=0 keeps `git status` polling (especially from `watch`) from
// creating index lock churn that could re-trigger the agent.

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf-8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function isGitRepo(root: string): boolean {
  try {
    return git(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

// Parse one `git status --porcelain` path field, taking the post-rename path and
// unquoting git's C-style quoting for paths with special characters.
function parsePath(field: string): string {
  let path = field;
  const arrow = path.indexOf(" -> ");
  if (arrow !== -1) path = path.slice(arrow + 4);
  path = path.trim();
  if (path.startsWith('"') && path.endsWith('"')) {
    path = path
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return path;
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
    out = git(root, ["status", "--porcelain", "-uall"]);
  } catch {
    return [];
  }
  const files = new Set<string>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const x = line[0];
    const y = line[1];
    // Skip pure deletions (D in either column with no rename).
    const status = `${x}${y}`;
    const field = line.slice(3);
    if ((x === "D" || y === "D") && !field.includes(" -> ")) continue;
    void status;
    files.add(parsePath(field));
  }
  return [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
