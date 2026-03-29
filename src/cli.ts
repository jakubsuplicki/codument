import { Command } from "commander";
import { init } from "./commands/init.js";
import { scan } from "./commands/scan.js";
import { update } from "./commands/update.js";
import { version } from "./lib/version.js";

const program = new Command();

program
  .name("codument")
  .description("Automated documentation for JS/TS projects using Claude Code")
  .version(version);

program
  .command("init")
  .description("Initialize codument in your project")
  .option("--force", "Overwrite existing files")
  .action(init);

program
  .command("scan")
  .description("Scan codebase and generate documentation for existing code")
  .action(scan);

program
  .command("update")
  .description("Update managed files after a codument package upgrade")
  .option("--dry-run", "Preview changes without modifying files")
  .action(update);

program.parse();
