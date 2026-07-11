import pc from "picocolors";
import { HookError, inspectHook, installHook, uninstallHook } from "../lib/git-hooks.js";
import { assertRootIsRepoToplevel } from "../lib/git.js";

// The command surface over the pre-commit arm (src/lib/git-hooks.ts). All three
// verbs are read-plan-write over ONE managed block; every failure path prints
// the path involved and the remedy, then exits nonzero — an installer that
// half-succeeds silently would be worse than none.

interface HooksOptions {
  root?: string;
}

const STATE_LINES: Record<string, string> = {
  installed: "installed — the strict gate runs on every commit",
  outdated: "installed but outdated — run `codument hooks install` to refresh the block",
  appendable: "a pre-commit hook exists without the gate — `codument hooks install` appends it",
  foreign: "a non-shell pre-commit hook exists — wire `codument review --strict` in manually",
  absent: "not installed — run `codument hooks install`",
  "no-repo": "not a git repository",
};

function fail(err: unknown): void {
  if (err instanceof HookError) {
    console.log(pc.red(`  ✗ ${err.message}`));
    process.exitCode = 1;
    return;
  }
  throw err;
}

export function hooksInstall(options: HooksOptions = {}): void {
  const root = options.root ?? process.cwd();
  try {
    assertRootIsRepoToplevel(root);
    const { action, hookPath } = installHook(root);
    const verb = {
      created: "created",
      appended: "appended to",
      updated: "refreshed in",
      unchanged: "already current in",
    }[action];
    console.log(pc.green(`  ✓ pre-commit gate ${verb} ${hookPath}`));
    console.log(pc.dim("    Runs `review --strict` before every commit; a red gate blocks."));
    console.log(
      pc.dim("    Skip once: git commit --no-verify   (or CODUMENT_SKIP_GATE=1 git commit)"),
    );
    console.log(
      pc.dim("    Honest limit: the gate checks the working tree, not the staged bytes."),
    );
  } catch (err) {
    fail(err);
  }
}

export function hooksStatus(options: HooksOptions = {}): void {
  const root = options.root ?? process.cwd();
  const { state, hookPath } = inspectHook(root);
  const line = STATE_LINES[state] ?? state;
  const mark = state === "installed" ? pc.green("✓") : pc.yellow("•");
  console.log(`  ${mark} pre-commit gate: ${line}`);
  if (hookPath) console.log(pc.dim(`    hook: ${hookPath}`));
  if (state === "installed" || state === "outdated") {
    console.log(pc.dim("    escapes: git commit --no-verify · CODUMENT_SKIP_GATE=1"));
  }
}

export function hooksUninstall(options: HooksOptions = {}): void {
  const root = options.root ?? process.cwd();
  try {
    const { result, hookPath } = uninstallHook(root);
    const lines: Record<string, string> = {
      "removed-file": `removed ${hookPath}`,
      "removed-block": `removed the gate block from ${hookPath} (your own hook lines kept)`,
      absent: "nothing installed",
      "not-managed": `no codument block in ${hookPath} — left untouched`,
    };
    const mark = result === "absent" || result === "not-managed" ? pc.yellow("•") : pc.green("✓");
    console.log(`  ${mark} pre-commit gate: ${lines[result]}`);
  } catch (err) {
    fail(err);
  }
}
