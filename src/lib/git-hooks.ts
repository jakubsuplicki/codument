import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./events.js";
import { getHooksDir } from "./git.js";

// The git pre-commit hook is the local enforcement arm of the change-control
// gate: `review --strict` already exits nonzero on an out-of-sync step, but
// nothing invoked it at commit time, and the dogfood run proved instructions
// alone leak (one red-gate commit slipped through in 44). The managed block
// between these markers is the ONLY region install/uninstall/update ever
// touch, so a user's own pre-commit logic survives every codument operation.
export const HOOK_BLOCK_START = "# >>> codument gate >>>";
export const HOOK_BLOCK_END = "# <<< codument gate <<<";

const SHEBANG = "#!/bin/sh";

/** An installer failure the command surfaces verbatim (path + remedy). */
export class HookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookError";
  }
}

/**
 * The managed pre-commit block. Resolution order prefers the project-local
 * binary over PATH so the repo's pinned codument version decides the verdict;
 * neither branch can fetch. A missing binary degrades LOUDLY OPEN (warn, allow
 * the commit): blocking every commit after an `rm -rf node_modules` trains
 * users to delete the hook, and "could not run, said out loud" is the same
 * stance the adversarial gate takes for an unrunnable verdict. When the gate
 * RUNS red, the commit is blocked and both escapes are named — skipping is a
 * stated act, never a slip.
 */
export function hookBlock(): string {
  return [
    HOOK_BLOCK_START,
    '# Installed by `codument hooks install`; `codument hooks uninstall` removes it.',
    "# Runs the strict step-sync gate: static analysis only, no network, no tests.",
    "# Want the adversarial gate too? Add --require-review to the review line.",
    'if [ "$CODUMENT_SKIP_GATE" = "1" ]; then',
    '  echo "codument gate: skipped (CODUMENT_SKIP_GATE=1)"',
    "else",
    '  CODUMENT_BIN=""',
    '  if [ -x "./node_modules/.bin/codument" ]; then',
    '    CODUMENT_BIN="./node_modules/.bin/codument"',
    "  elif command -v codument >/dev/null 2>&1; then",
    '    CODUMENT_BIN="codument"',
    "  fi",
    '  if [ -z "$CODUMENT_BIN" ]; then',
    '    echo "codument gate: codument not found (node_modules/.bin or PATH); gate NOT run" >&2',
    '  elif ! "$CODUMENT_BIN" review --strict; then',
    '    echo "" >&2',
    '    echo "codument gate: commit blocked by a red strict gate (details above)." >&2',
    '    echo "  skip once: git commit --no-verify   (or CODUMENT_SKIP_GATE=1 git commit)" >&2',
    "    exit 1",
    "  fi",
    "fi",
    HOOK_BLOCK_END,
  ].join("\n");
}

export type HookState =
  | "installed" // markers present, block matches this codument version
  | "outdated" // markers present, block content differs (install refreshes it)
  | "appendable" // a marker-less shell hook exists; install appends the block
  | "foreign" // a marker-less NON-shell hook exists; install refuses
  | "absent" // no pre-commit file
  | "no-repo"; // not a git repository (or git unavailable)

export interface HookInspection {
  state: HookState;
  /** Absolute pre-commit path (honors core.hooksPath/worktrees); null for no-repo. */
  hookPath: string | null;
}

export type HookInstallAction = "created" | "appended" | "updated" | "unchanged";

// A hook file we did not write is only append-safe when sh will run it: a
// shell shebang, or no shebang at all (execve fails ENOEXEC and git retries
// the hook via sh). A NUL byte means a binary; a non-sh interpreter (python,
// node, perl…) would choke on an appended sh block — refuse those instead of
// corrupting them.
function isAppendSafeShell(content: string): boolean {
  if (content.includes("\u0000")) return false;
  const firstLine = content.split("\n", 1)[0] ?? "";
  if (!firstLine.startsWith("#!")) return true;
  return /\b(sh|bash|dash|ksh|zsh)\b/.test(firstLine);
}

function hasMarkers(content: string): boolean {
  return content.includes(HOOK_BLOCK_START) && content.includes(HOOK_BLOCK_END);
}

// Replace the managed region (markers inclusive) with `block`. Null when the
// markers are missing or inverted — the caller then treats the file as
// marker-less rather than guessing at a region.
function replaceBlock(content: string, block: string): string | null {
  const start = content.indexOf(HOOK_BLOCK_START);
  const end = content.indexOf(HOOK_BLOCK_END);
  if (start === -1 || end === -1 || end < start) return null;
  return content.slice(0, start) + block + content.slice(end + HOOK_BLOCK_END.length);
}

export function preCommitPath(root: string): string | null {
  const dir = getHooksDir(root);
  return dir ? join(dir, "pre-commit") : null;
}

export function inspectHook(root: string): HookInspection {
  const hookPath = preCommitPath(root);
  if (!hookPath) return { state: "no-repo", hookPath: null };
  if (!existsSync(hookPath)) return { state: "absent", hookPath };
  const content = readFileSync(hookPath, "utf-8");
  if (hasMarkers(content)) {
    return { state: content.includes(hookBlock()) ? "installed" : "outdated", hookPath };
  }
  return { state: isAppendSafeShell(content) ? "appendable" : "foreign", hookPath };
}

/**
 * Idempotently install (or refresh) the managed block. Never touches a byte
 * outside the markers; a foreign (non-shell) hook is refused with the exact
 * manual wiring instead of being corrupted.
 */
export function installHook(root: string): { action: HookInstallAction; hookPath: string } {
  const { state, hookPath } = inspectHook(root);
  if (!hookPath) {
    throw new HookError(`${root} is not a git repository — nowhere to install a pre-commit hook`);
  }
  const block = hookBlock();
  const writeExecutable = (content: string): void => {
    mkdirSync(join(hookPath, ".."), { recursive: true });
    atomicWriteFileSync(hookPath, content);
    chmodSync(hookPath, 0o755);
  };
  switch (state) {
    case "absent": {
      writeExecutable(`${SHEBANG}\n\n${block}\n`);
      return { action: "created", hookPath };
    }
    case "appendable": {
      const existing = readFileSync(hookPath, "utf-8");
      const sep = existing.endsWith("\n") ? "\n" : "\n\n";
      writeExecutable(`${existing}${sep}${block}\n`);
      return { action: "appended", hookPath };
    }
    case "installed": {
      // Content is current; still assert the exec bit so a copied-in file works.
      chmodSync(hookPath, 0o755);
      return { action: "unchanged", hookPath };
    }
    case "outdated": {
      const existing = readFileSync(hookPath, "utf-8");
      const next = replaceBlock(existing, block);
      // Markers were seen by inspect, so replaceBlock cannot miss here.
      writeExecutable(next ?? `${SHEBANG}\n\n${block}\n`);
      return { action: "updated", hookPath };
    }
    case "foreign": {
      throw new HookError(
        `${hookPath} exists and is not a shell script — refusing to modify it.\n` +
          `Wire the gate into your hook manager yourself; the command to run is:\n` +
          `  codument review --strict`,
      );
    }
    default: {
      throw new HookError(`${root} is not a git repository`);
    }
  }
}

export type HookUninstallResult = "removed-block" | "removed-file" | "absent" | "not-managed";

/**
 * Remove the managed block; the file too when nothing but our scaffold
 * remains. Content outside the markers is preserved byte-for-byte.
 */
export function uninstallHook(root: string): { result: HookUninstallResult; hookPath: string } {
  const { state, hookPath } = inspectHook(root);
  if (!hookPath) {
    throw new HookError(`${root} is not a git repository — no hooks directory to clean`);
  }
  if (state === "absent") return { result: "absent", hookPath };
  if (state === "appendable" || state === "foreign") return { result: "not-managed", hookPath };
  const existing = readFileSync(hookPath, "utf-8");
  // Splice the block out together with the blank lines at ITS seam only —
  // never a global newline collapse, which would rewrite foreign content and
  // break the byte-preservation promise.
  const start = existing.indexOf(HOOK_BLOCK_START);
  const endMarker = existing.indexOf(HOOK_BLOCK_END);
  if (start === -1 || endMarker === -1 || endMarker < start) {
    return { result: "not-managed", hookPath };
  }
  const end = endMarker + HOOK_BLOCK_END.length;
  let before = existing.slice(0, start);
  let after = existing.slice(end);
  before = before.replace(/\n+$/, "\n");
  after = after.replace(/^\n+/, "\n");
  if (after === "\n") after = "";
  const remainder = before + after;
  const inert = remainder.replace(SHEBANG, "").trim().length === 0;
  if (inert) {
    rmSync(hookPath);
    return { result: "removed-file", hookPath };
  }
  atomicWriteFileSync(hookPath, remainder);
  chmodSync(hookPath, 0o755);
  return { result: "removed-block", hookPath };
}
