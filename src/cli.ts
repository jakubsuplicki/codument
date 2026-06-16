import { Command } from "commander";
import pc from "picocolors";
import { adopt } from "./commands/adopt.js";
import { createBenchmarkCommand } from "./commands/benchmark.js";
import { demo } from "./commands/demo.js";
import { doctor } from "./commands/doctor.js";
import { init } from "./commands/init.js";
import { migrateRegistryCommand } from "./commands/migrate.js";
import { report } from "./commands/report.js";
import { review } from "./commands/review.js";
import { watch } from "./commands/watch.js";
import { scan } from "./commands/scan.js";
import { update } from "./commands/update.js";
import { version } from "./lib/version.js";

const program = new Command();

program
  .name("codument")
  .description("Docs-backed delivery workflow for AI coding agents")
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
  .description("Scan codebase and generate documentation for existing code")
  .action(scan);

program
  .command("doctor")
  .description(
    "Report documentation coverage (ownership, freshness, dependency, risk) and registry lint warnings",
  )
  .option("--json", "Emit the machine-readable report contract")
  .option("--write", "Write .codument/coverage.json and .codument/coverage.svg (the score artifact + badge)")
  .option("--max-doc-lines <n>", "Whole-doc line threshold for bloat (default 400)")
  .option("--max-section-lines <n>", "Per-section line threshold for bloat (default 150)")
  .option("--max-completed-log <n>", "Completed-log [x] item threshold for bloat (default 15)")
  .option("--high-fanout <n>", "Distinct-entry count to flag a high-fanout file (default 3)")
  .action(doctor);

program
  .command("review")
  .description(
    "Review the uncommitted git diff against the v2 registry: owners, stale docs, risk touches, out-of-plan and unmapped changes, dependents",
  )
  .option("--json", "Emit the machine-readable review contract")
  .option("--log", "Append a review event to .codument/events.jsonl (for watch)")
  .action(review);

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
  .action(watch);

program
  .command("migrate-registry")
  .description("One-shot convert docs/.registry.json from the legacy flat shape to v2 (with backup)")
  .option("--dry-run", "Preview the migration without modifying files")
  .action((options) => migrateRegistryCommand(options));

program
  .command("adopt")
  .description("Adopt an existing Codument project and migrate legacy registry data")
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
        `  ${pc.dim("codument init | scan | doctor | review | report | watch | demo | migrate-registry | adopt | update | benchmark")}`,
      ].join("\n"),
    );
  });

program.addCommand(createBenchmarkCommand());

program.parse();
