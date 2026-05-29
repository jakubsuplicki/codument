import { Command } from "commander";
import { join } from "node:path";
import pc from "picocolors";
import {
  formatContextBenchmarkJson,
  formatContextBenchmarkReport,
  runContextBenchmark,
} from "../lib/benchmark-context.js";
import {
  formatQualityBenchmarkInitReport,
  formatQualityBenchmarkScoreReport,
  initializeQualityBenchmark,
  scoreQualityBenchmark,
} from "../lib/benchmark-quality.js";
import { packageRoot } from "../lib/scaffold.js";

interface ContextBenchmarkOptions {
  json?: boolean;
}

interface QualityBenchmarkInitOptions {
  agents?: string;
}

export function createBenchmarkCommand(): Command {
  const command = new Command("benchmark")
    .description("Run Codument proof benchmarks");

  command
    .command("context")
    .description("Run the deterministic context-routing benchmark")
    .option("--json", "Print the benchmark report as stable JSON")
    .action(async (options: ContextBenchmarkOptions) => {
      const report = await runContextBenchmark(
        join(packageRoot(), "fixtures", "benchmarks", "context-routing"),
      );
      const output = options.json
        ? formatContextBenchmarkJson(report)
        : formatContextBenchmarkReport(report);
      process.stdout.write(output);
    });

  command
    .command("init")
    .description("Create a quality benchmark fixture project")
    .argument("<dir>", "Target directory for the benchmark fixture")
    .option("--agents <agents>", "Agent profiles to install: codex, claude")
    .action(async (targetDir: string, options: QualityBenchmarkInitOptions) => {
      try {
        const report = await initializeQualityBenchmark(targetDir, options);
        process.stdout.write(formatQualityBenchmarkInitReport(report));
      } catch (error) {
        console.error(pc.red(`codument benchmark init failed: ${(error as Error).message}`));
        process.exitCode = 1;
      }
    });

  command
    .command("score")
    .description("Score a completed quality benchmark fixture")
    .argument("<dir>", "Benchmark fixture directory to score")
    .action(async (targetDir: string) => {
      try {
        const report = await scoreQualityBenchmark(targetDir);
        process.stdout.write(formatQualityBenchmarkScoreReport(report));
        if (report.result === "fail") {
          process.exitCode = 1;
        }
      } catch (error) {
        console.error(pc.red(`codument benchmark score failed: ${(error as Error).message}`));
        process.exitCode = 1;
      }
    });

  return command;
}
