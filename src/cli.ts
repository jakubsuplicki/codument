import { Command } from "commander";
import pc from "picocolors";
import { ackCommand } from "./commands/ack.js";
import { adopt } from "./commands/adopt.js";
import { auditCommand } from "./commands/audit.js";
import { createBenchmarkCommand } from "./commands/benchmark.js";
import { contextCommand } from "./commands/context.js";
import { cost } from "./commands/cost.js";
import { demo } from "./commands/demo.js";
import { doctor } from "./commands/doctor.js";
import { emitReviewCommand, emitTokensCommand } from "./commands/emit.js";
import { feed } from "./commands/feed.js";
import { hooksInstall, hooksStatus, hooksUninstall } from "./commands/hooks.js";
import { init } from "./commands/init.js";
import { mapCheck, mapMaterialize, mapRoute } from "./commands/map.js";
import { report } from "./commands/report.js";
import { review } from "./commands/review.js";
import { scan } from "./commands/scan.js";
import { stepsCommand } from "./commands/steps.js";
import { update } from "./commands/update.js";
import { watch } from "./commands/watch.js";
import { ExcludedSourceError, RegistryError } from "./lib/registry.js";
import { ConfigValueError, StateFileError } from "./lib/state-io.js";
import { GateError } from "./lib/two-ref.js";
import { version } from "./lib/version.js";

const program = new Command();

program
  .name("codument")
  .description(
    "Docs-based guardrails for AI coding workflows: coverage scoring, doc-drift checks, and diff safety review.",
  )
  .version(version);

program
  .command("init")
  .description("Initialize codument in your project")
  .option("--agents <agents>", "Comma-separated agent profiles to install: codex, claude")
  .option("--force", "Overwrite existing files")
  .option("--hooks", "Also install the git pre-commit gate (codument hooks install)")
  .option(
    "--no-scan",
    "Skip mapping existing source to docs (init scans when the repo has code and no registry yet)",
  )
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
  .option(
    "--write",
    "Write .codument/coverage.json and .codument/coverage.svg (the score artifact + badge)",
  )
  .option("--max-doc-lines <n>", "Whole-doc line threshold for bloat (default 400)")
  .option("--max-section-lines <n>", "Per-section line threshold for bloat (default 150)")
  .option("--max-completed-log <n>", "Completed-log [x] item threshold for bloat (default 15)")
  .option("--high-fanout <n>", "Distinct-entry count to flag a high-fanout file (default 3)")
  .option(
    "--strict",
    "Exit 1 if there are findings, for CI gating (opt-in; bare doctor stays warning-only and notes never fail)",
  )
  .option(
    "--verify-invariants",
    "Opt-in: RUN the test each doc invariant cites (not just check the pointer exists) and score the enforced share. Environment-touching and slower than bare doctor; a broken or unpinned invariant is a warning that --strict fails on",
  )
  .option(
    "--test-command <argv...>",
    'How to run a cited invariant test under --verify-invariants; the literal {file} token is the resolved path. Pass as ONE quoted string, e.g. --test-command "vitest run {file}". OVERRIDES "testCommand" in .codument-meta.json (default: npx --no-install tsx --test {file} — local-only, never a network fetch)',
  )
  .action(doctor);

program
  .command("review")
  .description(
    "Review the git diff against the registry: owners, stale docs, risk touches, out-of-plan and unmapped changes, dependents",
  )
  .option("--json", "Emit the machine-readable review contract")
  .option(
    "--log",
    "Append a `caught` snapshot (provable catches) to .codument/events.jsonl (for the impact ledger)",
  )
  .option(
    "--strict",
    "Exit 1 if the change left a new source unmapped or a mapped doc stale (the step-sync gate)",
  )
  .option(
    "--require-review",
    "Exit 1 if a non-trivial diff has no current adversarial-review artifact, or one with unresolved confirmed findings (opt-in; default-on flip is soak-deferred)",
  )
  .option(
    "--test-command <argv...>",
    'how to run a finding\'s named test under --require-review; the literal {file} token is the resolved path. Pass the whole command as ONE quoted string, e.g. --test-command "npx tsx --test {file}" or "vitest run {file}". OVERRIDES "testCommand" in .codument-meta.json, which is where a project should declare its runner once (default: npx --no-install tsx --test {file} — local-only, never a network fetch). Point at a TAP-emitting runner for non-node:test projects',
  )
  .option(
    "--bundle",
    "Emit the adversarial-review bundle as JSON (the documented invariants + their tests + the diff an independent reviewer attacks) and exit",
  )
  .option(
    "--full",
    "With --bundle: attack the whole change set even when a prior review of this base narrows it to a delta (a deliberate fresh attack)",
  )
  .option(
    "--record <file>",
    "Record a fingerprint-bound adversarial review from a findings JSON file ({invariantsChecked, findings, signer}); the gate then enforces it",
  )
  .option(
    "--base <ref>",
    "Review the branch's drift since it diverged from <ref> (merge-base..working-tree), not just uncommitted changes",
  )
  .option(
    "--require-independent-ack",
    "Strict mode (ADR 006): only an ack whose signer is independent of the change's commit author clears a finding — a self-signed ack leaves it open (and --strict fails on it)",
  )
  .option(
    "--format <format>",
    "Output format for the verdict: sarif emits SARIF 2.1.0 for CI code-scanning (upload with github/codeql-action/upload-sarif or reviewdog); mutually exclusive with --json. Only changes stdout; combine with --strict for the failing check",
  )
  .action(review);

program
  .command("audit")
  .description(
    "Audit doc drift over committed history: for each documented feature, symbol moves in <base>..<head> whose owning doc got no attention in the same range. Informational — findings never change the exit code",
  )
  .argument(
    "<range>",
    "the commit range <baseRef>..<headRef>, e.g. v1.0.0..HEAD (diffed from the merge-base)",
  )
  .option(
    "--json",
    "Emit the machine-readable audit contract (version-tagged; byte-identical for the same repo state)",
  )
  .option("--root <dir>", "project root (defaults to current directory)")
  .option("--dir <dir>", "project root (alias of --root)")
  .action((range, options) => auditCommand(range, options));

program
  .command("context")
  .description(
    "Project the minimal grounded working set for a feature, file, or plan (owning doc + invariants with test pointers, primary sources, one-hop deps) — a deterministic pull-based context pack over the registry",
  )
  .option("--feature <slug>", "pack the named feature")
  .option("--file <path>", "pack the feature(s) that own a source file")
  .option("--plan <path>", "pack every feature a plan's Feature Map routes to")
  .option(
    "--owner",
    "with --file: answer ownership in one line (which doc owns this file) instead of packing it",
  )
  .option(
    "--budget <tokens>",
    "trim the pack tail-first toward an estimated token budget (reports what it dropped)",
  )
  .option(
    "--json",
    "Emit the machine-readable context contract (version-tagged; byte-identical for the same repo state)",
  )
  .option("--root <dir>", "project root (defaults to current directory)")
  .option("--dir <dir>", "project root (alias of --root)")
  .action((options) => contextCommand(options));

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
  .option(
    "--base <ref>",
    "resolve the move against the merge-base with <ref> (match the ref `review --base` used)",
  )
  .option(
    "--signer <id>",
    "attribution (defaults to the git author; an independent signer is what strict-mode independence checks)",
  )
  .option(
    "--standing",
    "with a bare <path>: bind the judgment to the owning doc's claims instead of the file's bytes — it stands across later content changes and dies when that doc moves (every review it covers names what it swept)",
  )
  .option("--list", "list recorded acknowledgments with their handles")
  .option(
    "--json",
    "with --list, emit the acks as a versioned JSON contract (anchor, transition, signer, reason, recomputed validity)",
  )
  .option("--remove <handle>", "remove a recorded acknowledgment by its handle")
  .option(
    "--prune",
    "remove every auto-invalidated acknowledgment in one pass (covering and indeterminate ones are left alone)",
  )
  .option("--root <dir>", "project root (defaults to current directory)")
  .action((anchor, options) => ackCommand(anchor, options));

program
  .command("report")
  .description(
    "Write a self-contained HTML review report (verdict + coverage delta + findings) and open it",
  )
  .option("--out <path>", "Output path (default .codument/report.html)")
  .option("--no-open", "Write the report without opening a browser")
  .option("--json", "Emit the machine-readable report contract (impact ledger + acks)")
  .action(report);

program
  .command("demo")
  .description(
    "Click-through showcase: runs doctor → an AI change → review → coverage drop on a throwaway sample repo",
  )
  .option("--auto", "Run straight through without pausing between scenes")
  .option(
    "--live",
    "Live watch panel: one terminal, the change lands and the counts light up in place",
  )
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
    "Tail the active Claude Code session log and normalize per-turn token usage + tool activity into .codument/events.jsonl (consumed by watch and any reader of the event stream)",
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
  .option(
    "--plan <path>",
    "Plan doc to read (default: the single approved plan with an unchecked step)",
  )
  .option("--json", "Machine-readable checklist with per-step to-do status (for mirroring)")
  .option(
    "--emit",
    "Append a `step` event for the active step into .codument/events.jsonl (for watch)",
  )
  .option("--dir <path>", "Project root (default: current directory)")
  .option("--root <dir>", "Project root (default: current directory)")
  .action(stepsCommand);

const hooks = program
  .command("hooks")
  .description("Git pre-commit enforcement of the strict gate (install/status/uninstall)");

hooks
  .command("install")
  .description("Install or refresh the managed pre-commit block that runs `review --strict`")
  .option("--ci", "Also scaffold the PR gate workflow (.github/workflows/codument.yml)")
  .option("--root <dir>", "Project root (default: current directory)")
  .action((options) => hooksInstall(options));

hooks
  .command("status")
  .description("Report whether the pre-commit gate is installed and where")
  .option("--root <dir>", "Project root (default: current directory)")
  .action((options) => hooksStatus(options));

hooks
  .command("uninstall")
  .description("Remove the managed block (your own pre-commit lines are kept)")
  .option("--root <dir>", "Project root (default: current directory)")
  .action((options) => hooksUninstall(options));

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
  .option(
    "--feature <slug>",
    "Name the owning feature directly (must already exist) — the route once a plan has shipped and its Feature Map is compacted away",
  )
  .option("--root <dir>", "Project root (default: current directory)")
  .action((file, options) => mapMaterialize({ file, ...options }));

program
  .command("adopt")
  .description("Adopt an existing Codument project")
  .option("--agents <agents>", "Agent profiles to install or refresh: codex, claude")
  .option("--dry-run", "Preview adoption without modifying files")
  .action(adopt);

program
  .command("update")
  .description("Update managed files after a codument package upgrade")
  .option("--agents <agents>", "Override stored agent profiles for this update: codex, claude")
  .option("--dry-run", "Preview changes without modifying files")
  .action(update);

program
  .command("run [args...]")
  .alias("autopilot")
  .description("Explain how to run the approved plan (Codument does not run your agent)")
  .action(() => {
    // Derived from the registered commands at print time — a hand-maintained
    // list drifts the moment a command is added (cost/map/ack/emit all went
    // missing that way).
    const others = program.commands.map((c) => c.name()).filter((name) => name !== "run");
    console.log(
      [
        "Codument does not run your coding agent — your agent does.",
        "",
        "An approved plan already runs without this command: approving it is what starts",
        "your agent working the steps end to end.",
        "",
        `To stop at every gate instead, tell your agent:  ${pc.bold('"step by step"')}`,
        "",
        "The CLI only does setup and deterministic checks:",
        `  ${pc.dim(`codument ${others.join(" | ")}`)}`,
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

// Fail closed on a corrupt state file: any command that reads an unparseable
// registry or config (settings, project metadata, a target package.json) throws
// rather than reading it as empty (which would let the next write destroy it).
// Render it red and exit non-zero here, at the one boundary every command
// dispatches through.
program.parseAsync().catch((err) => {
  if (err instanceof RegistryError || err instanceof StateFileError) {
    console.log(pc.red(`  ✗ ${err.message}`));
    console.log(
      pc.dim(
        `    Fix or restore ${err.path} — codument will not overwrite a state file it could not first read.`,
      ),
    );
    process.exitCode = 1;
    return;
  }
  // A config file that parsed but carries an invalid value. Rendered here rather
  // than left to crash, because the commands that read project metadata include
  // the ones a user would reach for to FIX the file — a raw stack trace from
  // `codument update` is a dead end where a named value and a file path is not.
  if (err instanceof ConfigValueError) {
    console.log(pc.red(`  ✗ ${err.message}`));
    console.log(pc.dim(`    Correct the value in ${err.path}, then re-run.`));
    process.exitCode = 1;
    return;
  }
  // An entry that tried to name an out-of-scope source. Rendered here because
  // the refusal is a routine authoring outcome, not a crash: the user needs the
  // path and the reason, and a raw stack trace teaches nothing about the rule.
  if (err instanceof ExcludedSourceError) {
    console.log(pc.red(`  ✗ ${err.message}`));
    process.exitCode = 1;
    return;
  }
  // A GateError that no command caught locally (review renders its own): the gate
  // could not run, so fail closed here rather than crash with a raw stack.
  if (err instanceof GateError) {
    console.log(pc.red(`  ✗ ${err.message} (gate could not run)`));
    process.exitCode = 1;
    return;
  }
  throw err;
});
