import pc from "picocolors";
import { pumpFeed, resolveSessionLog } from "../lib/claude-feed.js";

interface FeedOptions {
  root?: string;
  dir?: string;
  once?: boolean;
  interval?: string | number;
}

const NO_SESSION = (root: string): void => {
  console.log(
    pc.yellow("codument feed: no active Claude Code session log found for this project."),
  );
  console.log(
    pc.dim(
      `  Looked under ~/.claude/projects for a session with cwd ${root}. Run this from a repo where Claude Code is (or was) active.`,
    ),
  );
};

/**
 * Producer side of the live view: tail the active Claude Code transcript and
 * normalize its per-turn token usage + tool activity into
 * .codument/events.jsonl, which `watch` (and a future studio) consume. Idempotent
 * — safe to run alongside `watch` or restart at will.
 */
export async function feed(options: FeedOptions = {}): Promise<void> {
  const root = options.root ?? options.dir ?? process.cwd();
  const session = resolveSessionLog(root);
  if (!session) {
    NO_SESSION(root);
    process.exitCode = 1;
    return;
  }

  if (options.once) {
    const { emitted } = pumpFeed(root);
    console.log(
      `${pc.green("✓")} fed ${emitted} event${emitted === 1 ? "" : "s"} into .codument/events.jsonl`,
    );
    return;
  }

  console.log(pc.bold("codument feed") + pc.dim(`  ·  ${session}`));
  console.log(
    pc.dim("  normalizing token usage + tool activity → .codument/events.jsonl · Ctrl-C to stop"),
  );

  const intervalMs = Math.max(250, Number(options.interval) || 1000);
  const first = pumpFeed(root);
  if (first.emitted) console.log(pc.dim(`  +${first.emitted} (backfill)`));

  const timer = setInterval(() => {
    const { emitted } = pumpFeed(root);
    if (emitted) console.log(pc.dim(`  +${emitted}`));
  }, intervalMs);

  const stop = () => {
    clearInterval(timer);
    process.stdout.write("\n");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
