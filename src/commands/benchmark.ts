import { Command } from "commander";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
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
import {
  formatSeededBenchmarkInitReport,
  formatSeededBenchmarkScoreReport,
  initializeSeededBenchmark,
  scoreSeededBenchmark,
  type SeededBenchmarkMode,
} from "../lib/benchmark-seeded.js";
import { packageRoot } from "../lib/scaffold.js";
import {
  initializeSessionBenchmark,
  scoreSessionBenchmark,
  snapshotSessionBenchmark,
  type SessionTask,
  type SessionCondition,
} from "../lib/benchmark-sessions.js";

interface ContextBenchmarkOptions {
  json?: boolean;
}

interface BenchmarkInitOptions {
  agents?: string;
  seeded?: boolean;
  scenario?: string;
  condition?: string;
  json?: boolean;
}

interface BenchmarkScoreOptions {
  mode?: string;
  baseline?: string;
  sessionRecord?: string;
  snapshot?: boolean;
  json?: boolean;
}

export function createBenchmarkCommand(): Command {
  const command = new Command("benchmark").description("Run Codument proof benchmarks");

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
    .description("Create a benchmark fixture project")
    .argument("<dir>", "Target directory for the benchmark fixture")
    .option("--agents <agents>", "Agent profiles to install: codex, claude")
    .option("--scenario <task>", "Session task: retrieval, approval-change, interrupted-work")
    .option(
      "--condition <condition>",
      "Session integration: plain or integrated (required with --scenario)",
    )
    .option(
      "--json",
      "Print session initialization as JSON, including the input binding for an observer",
    )
    .option("--seeded", "Lay the planted-bug catch-rate scenario instead of the quality task")
    .action(async (targetDir: string, options: BenchmarkInitOptions) => {
      try {
        if (options.scenario !== undefined) {
          if (options.seeded || options.agents)
            throw new Error("--scenario cannot combine with --seeded or --agents");
          const report = await initializeSessionBenchmark(targetDir, {
            task: options.scenario as SessionTask,
            condition: options.condition as SessionCondition,
          });
          process.stdout.write(
            options.json
              ? JSON.stringify(report, null, 2) + "\n"
              : `Session fixture: ${report.task} (${report.condition})\nTarget: ${report.root}\nInput binding: ${report.inputDigest}\nRead BENCHMARK_TASK.md. An external observer must retain this binding and record the actual attempt before scoring.\n`,
          );
        } else if (options.condition || options.json) {
          throw new Error("--condition and init --json require --scenario");
        } else if (options.seeded) {
          const report = await initializeSeededBenchmark(targetDir, options);
          process.stdout.write(formatSeededBenchmarkInitReport(report));
        } else {
          const report = await initializeQualityBenchmark(targetDir, options);
          process.stdout.write(formatQualityBenchmarkInitReport(report));
        }
      } catch (error) {
        console.error(pc.red(`codument benchmark init failed: ${(error as Error).message}`));
        process.exitCode = 1;
      }
    });

  command
    .command("score")
    .description("Score a completed benchmark fixture")
    .argument("<dir>", "Benchmark fixture directory to score")
    .option(
      "--session-record <file>",
      "Score a session using an externally recorded observation JSON file",
    )
    .option(
      "--snapshot",
      "Print the session's current file binding for its external observer; does not score",
    )
    .option("--json", "Print the session score as JSON")
    .option("--mode <mode>", "Record the run as loop or no-loop (catch-rate scenarios)")
    .option("--baseline <dir>", "Compare a catch-rate run against another scored directory")
    .action(async (targetDir: string, options: BenchmarkScoreOptions) => {
      try {
        if (
          options.sessionRecord ||
          options.snapshot ||
          existsSync(join(resolve(targetDir), ".benchmark-session.json"))
        ) {
          if (options.mode || options.baseline || (options.sessionRecord && options.snapshot))
            throw new Error(
              "Session options cannot combine with seeded comparison options or with each other",
            );
          if (options.snapshot) {
            process.stdout.write(
              JSON.stringify(snapshotSessionBenchmark(targetDir), null, 2) + "\n",
            );
          } else {
            if (!options.sessionRecord)
              throw new Error(
                "Session scoring requires --session-record <external-observation.json>; init and snapshot do not constitute an agent run",
              );
            const inputStat = await stat(options.sessionRecord);
            if (!inputStat.isFile() || inputStat.size > 128 * 1024)
              throw new Error("Session observation is not a bounded file");
            const raw = await readFile(options.sessionRecord, "utf8");
            if (Buffer.byteLength(raw) > 128 * 1024)
              throw new Error("Session observation exceeds its byte bound");
            const report = scoreSessionBenchmark(targetDir, JSON.parse(raw));
            process.stdout.write(
              options.json
                ? JSON.stringify(report, null, 2) + "\n"
                : `${report.result.toUpperCase()}: ${report.task} (${report.condition}, ${report.kind})\nMissed constraints: ${report.missedConstraints}; false positives/unnecessary stops: ${report.falsePositives}\n${report.limitations.join("\n")}\n`,
            );
            if (report.result === "fail") process.exitCode = 1;
          }
        } else if (options.json) {
          throw new Error("score --json requires a session fixture");
        } else if (await isSeededScenario(targetDir)) {
          const report = await scoreSeededBenchmark(targetDir, {
            mode: parseMode(options.mode),
            baselineDir: options.baseline,
          });
          process.stdout.write(formatSeededBenchmarkScoreReport(report));
          if (report.lockCheck.status === "fail") {
            process.exitCode = 1;
          }
        } else {
          const report = await scoreQualityBenchmark(targetDir);
          process.stdout.write(formatQualityBenchmarkScoreReport(report));
          if (report.result === "fail") {
            process.exitCode = 1;
          }
        }
      } catch (error) {
        console.error(pc.red(`codument benchmark score failed: ${(error as Error).message}`));
        process.exitCode = 1;
      }
    });

  return command;
}

async function isSeededScenario(targetDir: string): Promise<boolean> {
  const root = resolve(targetDir);
  if ((await readFixtureId(join(root, ".codument", "benchmark.json"))) === "seeded-bugs") {
    return true;
  }
  // The scenario id is tamperable, so consult the lock file as a second signal:
  // a flipped benchmark.json still routes to the seeded scorer, whose lock check
  // then reports the tamper instead of misrouting to the quality scorer.
  return (await readFixtureId(join(root, "benchmark.lock.json"))) === "seeded-bugs";
}

async function readFixtureId(filePath: string): Promise<string | null> {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf-8")) as {
      fixture?: unknown;
    };
    return typeof parsed.fixture === "string" ? parsed.fixture : null;
  } catch {
    return null;
  }
}

function parseMode(mode: string | undefined): SeededBenchmarkMode {
  if (mode === "loop" || mode === "no-loop") return mode;
  return "unspecified";
}
