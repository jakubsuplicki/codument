import pc from "picocolors";
import { backfillFeed, pumpFeed, resetFeed, resolveSessionLogs } from "../lib/claude-feed.js";

interface FeedOptions {
  root?: string;
  dir?: string;
  once?: boolean;
  interval?: string | number;
  reset?: boolean;
  backfill?: boolean;
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

  // Maintenance one-shot: rebuild feed-sourced events under the current
  // normalization (re-prices stale/unpriced events). Runs even with no live
  // session, since it can rebuild from the transcripts the cursor already knows.
  if (options.reset) {
    const { removed, kept, preserved, emitted, session } = resetFeed(root);
    console.log(
      `${pc.green("✓")} feed reset · re-fed ${emitted} event${emitted === 1 ? "" : "s"}, ` +
        `dropped ${removed} stale, kept ${kept} other`,
    );
    if (preserved > 0) {
      console.log(
        pc.yellow(
          `  ⚠ preserved ${preserved} event${preserved === 1 ? "" : "s"} from transcript(s) no longer present — kept as-is, not re-priced`,
        ),
      );
    }
    if (removed === 0 && emitted === 0 && preserved === 0) {
      console.log(
        pc.dim("  (nothing to rebuild — no feed events and no Claude session for this project)"),
      );
    } else if (!session) {
      console.log(
        pc.dim("  (no active session resolved — rebuilt from prior feed history only)"),
      );
    }
    if (options.backfill) {
      console.log(
        pc.dim("  (--backfill was redundant with --reset — reset already rebuilds from every matching session)"),
      );
    }
    return;
  }

  // Retroactive one-shot: ingest every matching transcript from offset 0, adding
  // only turns not already captured — picks up sessions that were never watched.
  if (options.backfill) {
    const { sessions, newSessions, added } = backfillFeed(root);
    if (sessions === 0) {
      NO_SESSION(root);
      process.exitCode = 1;
      return;
    }
    console.log(
      `${pc.green("✓")} backfill · +${added} event${added === 1 ? "" : "s"} from ` +
        `${newSessions} of ${sessions} session${sessions === 1 ? "" : "s"}`,
    );
    if (added === 0) {
      console.log(pc.dim("  (already complete — every turn was already captured)"));
    }
    return;
  }

  // Guard on the full matching set (the same discovery `pumpFeed` uses), not the
  // single newest — otherwise the command can report "no session" in a fallback
  // case where `pumpFeed` would in fact find and pump one.
  const sessions = resolveSessionLogs(root);
  if (sessions.length === 0) {
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

  const label = sessions.length === 1 ? sessions[0] : `${sessions.length} sessions`;
  console.log(pc.bold("codument feed") + pc.dim(`  ·  ${label}`));
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
