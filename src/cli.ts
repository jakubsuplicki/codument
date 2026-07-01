import { Command } from "commander";
import pc from "picocolors";
import { adopt } from "./commands/adopt.js";
import { createBenchmarkCommand } from "./commands/benchmark.js";
import { demo } from "./commands/demo.js";
import { doctor } from "./commands/doctor.js";
import { emitTokensCommand, emitReviewCommand } from "./commands/emit.js";
import { ackCommand } from "./commands/ack.js";
import { init } from "./commands/init.js";
import { report } from "./commands/report.js";
import { review } from "./commands/review.js";
import { watch } from "./commands/watch.js";
import { feed } from "./commands/feed.js";
import { cost } from "./commands/cost.js";
import { stepsCommand } from "./commands/steps.js";
import { scan } from "./commands/scan.js";
import { update } from "./commands/update.js";
import { mapRoute, mapCheck, mapMaterialize } from "./commands/map.js";
import { version } from "./lib/version.js";

const program = new Command();

program
  .name("codument")
  .description("Docs-based guardrails for AI coding workflows: coverage scoring, doc-drift checks, and diff safety review.")
  .version(version);

program
  .command("init")
  .description("Initialize codument in your project")
  .option(
    "--agents <agents>",
    "Comma-separated agent profiles to install: codex, claude",
  )
  .option("--force", "Overwrite existing files")
  .action(init);

program
  .command("scan")
  .description("Scan codebase and create documentation scaffolds for existing code")
  .action(scan);

program
  .command("doctor")
  .description(
    "Report documentation coverage (ownership, dependency, risk) and registry lint warnings",
  )
  .option("--json", "Emit the machine-readable report contract")
  .option("--write", "Write .codument/coverage.json and .codument/coverage.svg (the score artifact + badge)")
  .option("--max-doc-lines <n>", "Whole-doc line threshold for bloat (default 400)")
  .option("--max-section-lines <n>", "Per-section line threshold for bloat (default 150)")
  .option("--max-completed-log <n>", "Completed-log [x] item threshold for bloat (default 15)")
  .option("--high-fanout <n>", "Distinct-entry count to flag a high-fanout file (default 3)")
  .option(
    "--strict",
    "Exit 1 if there are findings, for CI gating (opt-in; bare doctor stays warning-only and notes never fail)",
  )
  .action(doctor);

program
  .command("review")
  .description(
    "Review the git diff against the registry: owners, stale docs, risk touches, out-of-plan and unmapped changes, dependents",
  )
  .option("--json", "Emit the machine-readable review contract")
  .option("--log", "Append a `caught` snapshot (provable catches) to .codument/events.jsonl (for the impact ledger)")
  .option("--strict", "Exit 1 if the change left a new source unmapped or a mapped doc stale (the step-sync gate)")
  .option("--require-review", "Exit 1 if a non-trivial diff has no current adversarial-review artifact, or one with unresolved confirmed findings (opt-in; default-on flip is soak-deferred)")
  .option("--test-command <argv...>", "how to run a finding's named test under --require-review; the literal {file} token is the resolved path. Pass the whole command as ONE quoted string, e.g. --test-command \"npx tsx --test {file}\" or \"vitest run {file}\" (default: npx tsx --test {file}). Point at a TAP-emitting runner for non-node:test projects")
  .option("--bundle", "Emit the adversarial-review bundle as JSON (the documented invariants + their tests + the diff an independent reviewer attacks) and exit")
  .option("--record <file>", "Record a fingerprint-bound adversarial review from a findings JSON file ({invariantsChecked, findings, signer}); the gate then enforces it")
  .option("--base <ref>", "Review the branch's drift since it diverged from <ref> (merge-base..working-tree), not just uncommitted changes")
  .action(review);

program
  .command("ack")
  .description(
    "Acknowledge a change that owes no doc change — records a fingerprint-bound, auto-invalidating decision so review stops flagging it. A moved symbol: <path>::<symbol>. A whole file's additive/concept residue: <path> (never masks a moved symbol)",
  )
  .argument(
    "[anchor]",
    "the moved anchor <path>::<symbol> (run the exact line `codument review` prints, or <path>::<bareName>), OR a bare <path> for a file-grain ack of additive/concept staleness",
  )
  .option("--reason <text>", "why no doc change is owed — name the contract that stayed constant")
  .option("--base <ref>", "resolve the move against the merge-base with <ref> (match the ref `review --base` used)")
  .option("--signer <id>", "attribution (defaults to the git author; an independent signer is what strict-mode independence checks)")
  .option("--list", "list recorded acknowledgments with their handles")
  .option("--remove <handle>", "remove a recorded acknowledgment by its handle")
  .option("--root <dir>", "project root (defaults to current directory)")
  .action((anchor, options) => ackCommand(anchor, options));

program
  .command("report")
  .description(
    "Write a self-contained HTML review report (verdict + coverage delta + findings) and open it",
  )
  .option("--out <path>", "Output path (default .codument/report.html)")
  .option("--no-open", "Write the report without opening a browser")
  .action(report);

program
  .command("demo")
  .description(
    "Click-through showcase: runs doctor → an AI change → review → coverage drop on a throwaway sample repo",
  )
  .option("--auto", "Run straight through without pausing between scenes")
  .option("--live", "Live watch panel: one terminal, the change lands and the counts light up in place")
  .option("--dir <path>", "Where to materialize the sample repo (default: a temp dir)")
  .action(demo);

program
  .command("watch")
  .description(
    "Live terminal view of the working-tree change-state (coverage, stale docs, risk, unmapped, out-of-plan) — no daemon",
  )
  .option("--once", "Render a single frame and exit (for CI/inspection)")
  .option("--interval <ms>", "Refresh interval in milliseconds (default 2000)")
  .option("--dir <path>", "Repo to watch (default: current directory)")
  .option("--no-feed", "Do not auto-tail the Claude session log into events.jsonl")
  .action(watch);

program
  .command("feed")
  .description(
    "Tail the active Claude Code session log and normalize per-turn token usage + tool activity into .codument/events.jsonl (for watch / studio)",
  )
  .option("--once", "Single backfill pass and exit")
  .option("--interval <ms>", "Poll interval in milliseconds (default 1000)")
  .option("--dir <path>", "Repo to feed (default: current directory)")
  .option(
    "--reset",
    "Rebuild feed-sourced events from the transcript at the current normalization (re-prices stale/unpriced events); preserves manual emits and review notes",
  )
  .option(
    "--backfill",
    "Ingest every matching transcript from offset 0, adding only turns not already captured (picks up sessions that were never watched); idempotent",
  )
  .action(feed);

program
  .command("cost")
  .description(
    "Print the full estimated token-cost ledger (all sessions, by feature / model / step) from captured usage in .codument/events.jsonl",
  )
  .option("--dir <path>", "Project root (default: current directory)")
  .option("--root <dir>", "Project root (default: current directory)")
  .option("--json", "Emit the machine-readable token summary instead of the ledger")
  .action(cost);

program
  .command("steps")
  .description(
    "Print the active plan's delivery-plan checklist (to mirror into a native to-do panel) and optionally log the active step for watch",
  )
  .option("--plan <path>", "Plan doc to read (default: the single approved plan with an unchecked step)")
  .option("--json", "Machine-readable checklist with per-step to-do status (for mirroring)")
  .option("--emit", "Append a `step` event for the active step into .codument/events.jsonl (for watch)")
  .option("--dir <path>", "Project root (default: current directory)")
  .option("--root <dir>", "Project root (default: current directory)")
  .action(stepsCommand);

const map = program
  .command("map")
  .description("Feature Map routing + materialization (feature decomposition)");

map
  .command("route <file>")
  .description("Print which feature owns <file> per the plan's Feature Map")
  .option("--plan <path>", "Plan doc to read (default: the single approved plan)")
  .option("--json", "Machine-readable owner lookup")
  .option("--root <dir>", "Project root (default: current directory)")
  .action((file, options) => mapRoute({ file, ...options }));

map
  .command("check")
  .description("Validate the plan's Feature Map and flag a too-coarse shape")
  .option("--plan <path>", "Plan doc to read (default: the single approved plan)")
  .option("--json", "Machine-readable check report + plan grounding (the plan adversary's oracle)")
  .option("--root <dir>", "Project root (default: current directory)")
  .action((options) => mapCheck(options));

map
  .command("materialize <file>")
  .description("Create/extend the owning feature's registry entry + doc for <file>")
  .option("--plan <path>", "Plan doc to read (default: the single approved plan)")
  .option("--root <dir>", "Project root (default: current directory)")
  .action((file, options) => mapMaterialize({ file, ...options }));

program
  .command("adopt")
  .description("Adopt an existing Codument project")
  .option(
    "--agents <agents>",
    "Agent profiles to install or refresh: codex, claude",
  )
  .option("--dry-run", "Preview adoption without modifying files")
  .action(adopt);

program
  .command("update")
  .description("Update managed files after a codument package upgrade")
  .option(
    "--agents <agents>",
    "Override stored agent profiles for this update: codex, claude",
  )
  .option("--dry-run", "Preview changes without modifying files")
  .action(update);

program
  .command("run [args...]")
  .alias("autopilot")
  .description(
    "Explain how to run the approved plan (Codument does not run your agent)",
  )
  .action(() => {
    console.log(
      [
        "Codument does not run your coding agent — your agent does.",
        "",
        `To run an approved plan, tell your agent:  ${pc.bold('"codument, run the plan"')}`,
        "",
        "The CLI only does setup and deterministic checks:",
        `  ${pc.dim("codument init | scan | doctor | review | report | watch | feed | steps | demo | adopt | update | benchmark")}`,
      ].join("\n"),
    );
  });

const emit = program
  .command("emit")
  .description("Emit a codument event into .codument/events.jsonl");

emit
  .command("tokens")
  .description("Record agent token usage for cost tracking (estimate, not a bill)")
  .requiredOption("--model <model>", "model id, e.g. opus-4.8")
  .option("--input <n>", "input tokens", "0")
  .option("--output <n>", "output tokens", "0")
  .option("--cache-read <n>", "cache read tokens", "0")
  .option("--cache-create <n>", "cache creation tokens", "0")
  .option("--feature <feature>", "feature to attribute this usage to")
  .option("--step <step>", "delivery-plan step to attribute this usage to")
  .option("--root <dir>", "project root (defaults to current directory)")
  .action(emitTokensCommand);

emit
  .command("review")
  .description("Record a resolved review finding (self-reported, tiered) for the impact ledger")
  .requiredOption("--tier <tier>", "correctness | minor")
  .requiredOption("--resolution <resolution>", "fixed | deferred")
  .option("--feature <feature>", "feature this finding belongs to")
  .option("--step <step>", "delivery-plan step this finding belongs to")
  .option("--summary <text>", "one-line description of the finding")
  .option("--root <dir>", "project root (defaults to current directory)")
  .action(emitReviewCommand);

program.addCommand(createBenchmarkCommand());

program.parse();
