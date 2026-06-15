import { Command } from "commander";
import pc from "picocolors";
import { adopt } from "./commands/adopt.js";
import { createBenchmarkCommand } from "./commands/benchmark.js";
import { init } from "./commands/init.js";
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
        `  ${pc.dim("codument init | scan | adopt | update | benchmark")}`,
      ].join("\n"),
    );
  });

program.addCommand(createBenchmarkCommand());

program.parse();
