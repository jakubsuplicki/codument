import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type AgentProfileId, parseAgentIds } from "./agent-profiles.js";
import {
  assertTargetIsWritable,
  installBenchmarkAgentAssets,
  writeCodumentMeta,
} from "./benchmark-quality.js";
import { classifyDetectorRun } from "./detector-result.js";
import { packageRoot } from "./scaffold.js";

const SEEDED_FIXTURE = "seeded-bugs";
const SEEDED_TASK_ID = "review-the-transactions-report";
const SEEDED_SOURCE_GLOBS = ["src/**/*.js", "test/**/*.js"];
const SCENARIO_FILE = join(".codument", "benchmark.json");
const RESULT_FILE = join(".codument", "seeded-result.json");

export type SeededBenchmarkMode = "loop" | "no-loop" | "unspecified";

export interface SeededBenchmarkInitOptions {
  agents?: string;
}

export interface SeededBenchmarkInitReport {
  schemaVersion: 1;
  fixture: typeof SEEDED_FIXTURE;
  taskId: typeof SEEDED_TASK_ID;
  targetDir: string;
  agents: AgentProfileId[];
  taskPrompt: string;
  gitInitialized: boolean;
  gitNote: string;
}

interface SeededBugManifestEntry {
  id: string;
  title: string;
  file: string;
  tier: string;
  detector: string;
  description?: string;
  origin?: string;
}

export type SeededBugStatus = "caught" | "survived";

export interface SeededBugResult {
  id: string;
  title: string;
  file: string;
  tier: string;
  status: SeededBugStatus;
  evidence: string;
}

export interface SeededBenchmarkComparison {
  baselineMode: SeededBenchmarkMode;
  baselineCatchRatePercent: number;
  deltaPercent: number;
}

export interface SeededBenchmarkScoreReport {
  schemaVersion: 1;
  fixture: typeof SEEDED_FIXTURE;
  taskId: string;
  targetDir: string;
  mode: SeededBenchmarkMode;
  lockCheck: { status: "pass" | "fail"; evidence: string };
  caught: number;
  total: number;
  catchRatePercent: number;
  bugs: SeededBugResult[];
  comparison?: SeededBenchmarkComparison;
}

export interface SeededBenchmarkScoreOptions {
  mode?: SeededBenchmarkMode;
  baselineDir?: string;
}

export async function initializeSeededBenchmark(
  targetDir: string,
  options: SeededBenchmarkInitOptions = {},
): Promise<SeededBenchmarkInitReport> {
  const root = resolve(targetDir);
  const fixtureRoot = seededFixtureRoot();
  const projectSource = join(fixtureRoot, "project");
  const changesSource = join(fixtureRoot, "changes");
  const taskPrompt = await readFile(join(fixtureRoot, "task.md"), "utf-8");
  const agentIds = parseAgentIds(options.agents);
  const selectedAgentIds: AgentProfileId[] =
    agentIds.length > 0 ? agentIds : ["codex"];

  await assertTargetIsWritable(root);
  await mkdir(dirname(root), { recursive: true });

  // 1. Lay the clean committed baseline and the workflow scaffolding.
  await cp(projectSource, root, { recursive: true, force: true });
  await installBenchmarkAgentAssets(root, selectedAgentIds, SEEDED_SOURCE_GLOBS);
  await writeCodumentMeta(root, selectedAgentIds, {
    sourceGlobs: SEEDED_SOURCE_GLOBS,
    fixture: SEEDED_FIXTURE,
    taskId: SEEDED_TASK_ID,
  });
  await writeFile(join(root, "BENCHMARK_TASK.md"), taskPrompt);

  // 2. Commit the baseline so the feature work lands as a reviewable diff.
  const git = gitInitBaseline(root);

  // 3. Overlay the buggy feature work as the uncommitted working tree.
  await cp(changesSource, root, { recursive: true, force: true });

  return {
    schemaVersion: 1,
    fixture: SEEDED_FIXTURE,
    taskId: SEEDED_TASK_ID,
    targetDir: root,
    agents: selectedAgentIds,
    taskPrompt,
    gitInitialized: git.initialized,
    gitNote: git.note,
  };
}

export function formatSeededBenchmarkInitReport(
  report: SeededBenchmarkInitReport,
): string {
  const lines = [
    "codument benchmark init (seeded)",
    "",
    `Fixture: ${report.fixture}`,
    `Task: ${report.taskId}`,
    `Target: ${report.targetDir}`,
    `Agents: ${report.agents.join(", ")}`,
    `Baseline commit: ${report.gitInitialized ? "created" : `skipped — ${report.gitNote}`}`,
    "",
    "Laid a clean baseline plus an uncommitted feature branch carrying planted bugs.",
    "",
    "Next:",
    `  cd ${report.targetDir}`,
    "  npm test",
    "  # loop run:    review the diff, fix what you find, then commit",
    "  # no-loop run: commit the diff as-is",
    `  codument benchmark score ${report.targetDir} --mode loop   # or --mode no-loop`,
    "",
    "----- agent prompt -----",
    report.taskPrompt.trimEnd(),
    "----- end prompt -----",
    "",
  ];
  return lines.join("\n");
}

export async function scoreSeededBenchmark(
  targetDir: string,
  options: SeededBenchmarkScoreOptions = {},
): Promise<SeededBenchmarkScoreReport> {
  const root = resolve(targetDir);
  if (!existsSync(root)) {
    throw new Error(`Target directory does not exist: ${root}`);
  }
  const targetStat = await stat(root);
  if (!targetStat.isDirectory()) {
    throw new Error(`Target is not a directory: ${root}`);
  }

  const scenario = await readJson<{ fixture?: unknown }>(
    join(root, SCENARIO_FILE),
  ).catch(() => null);
  if (!scenario || scenario.fixture !== SEEDED_FIXTURE) {
    throw new Error(
      `Not a seeded-bugs benchmark scenario: ${join(root, SCENARIO_FILE)} is missing or has a different fixture`,
    );
  }

  const mode: SeededBenchmarkMode = options.mode ?? "unspecified";
  const lockCheck = await checkScenarioLock(root);

  // A tampered scenario identity invalidates the run; the catch rate is
  // meaningless, so do not run the detectors against it. Drop any result a
  // prior clean run left behind, so a tampered directory can never be reused as
  // a trusted `--baseline` after the fact.
  if (lockCheck.status === "fail") {
    await rm(join(root, RESULT_FILE), { force: true });
    const report: SeededBenchmarkScoreReport = {
      schemaVersion: 1,
      fixture: SEEDED_FIXTURE,
      taskId: SEEDED_TASK_ID,
      targetDir: root,
      mode,
      lockCheck,
      caught: 0,
      total: 0,
      catchRatePercent: 0,
      bugs: [],
    };
    return report;
  }

  const manifest = await readSeededManifest();
  const bugs: SeededBugResult[] = [];
  for (const bug of manifest.bugs) {
    bugs.push(runDetector(root, bug));
  }
  const caught = bugs.filter((bug) => bug.status === "caught").length;
  const total = bugs.length;
  const catchRatePercent = total === 0 ? 0 : Math.round((caught / total) * 100);

  const comparison = await loadComparison(options.baselineDir, catchRatePercent);

  const report: SeededBenchmarkScoreReport = {
    schemaVersion: 1,
    fixture: SEEDED_FIXTURE,
    taskId: SEEDED_TASK_ID,
    targetDir: root,
    mode,
    lockCheck,
    caught,
    total,
    catchRatePercent,
    bugs,
    ...(comparison ? { comparison } : {}),
  };

  await persistResult(root, report);
  return report;
}

export function formatSeededBenchmarkScoreReport(
  report: SeededBenchmarkScoreReport,
): string {
  if (report.lockCheck.status === "fail") {
    return [
      "codument benchmark score (catch-rate)",
      "",
      `Fixture: ${report.fixture}`,
      `Target: ${report.targetDir}`,
      "Result: FAIL",
      `  FAIL locked-files: ${report.lockCheck.evidence}`,
      "",
      "The scenario identity was altered, so the catch rate cannot be trusted.",
      "",
    ].join("\n");
  }

  const lines = [
    "codument benchmark score (catch-rate)",
    "",
    `Fixture: ${report.fixture}`,
    `Task: ${report.taskId}`,
    `Target: ${report.targetDir}`,
    `Mode: ${report.mode}`,
    `Catch rate: ${report.caught}/${report.total} (${report.catchRatePercent}%)`,
    "",
    "Bugs:",
  ];

  for (const bug of report.bugs) {
    const label = bug.status === "caught" ? "CAUGHT  " : "SURVIVED";
    lines.push(`  ${label} ${bug.id} [${bug.tier}] ${bug.file}`);
    lines.push(`    ${bug.evidence}`);
  }

  if (report.comparison) {
    const { baselineMode, baselineCatchRatePercent, deltaPercent } =
      report.comparison;
    const sign = deltaPercent >= 0 ? "+" : "";
    lines.push("");
    lines.push(`Comparison vs ${baselineMode} baseline:`);
    lines.push(
      `  ${baselineMode}: ${baselineCatchRatePercent}%   ${report.mode}: ${report.catchRatePercent}%   delta: ${sign}${deltaPercent}%`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

function runDetector(
  root: string,
  bug: SeededBugManifestEntry,
): SeededBugResult {
  const detectorPath = join(seededFixtureRoot(), bug.detector);
  const result = spawnSync(process.execPath, ["--test", detectorPath], {
    encoding: "utf-8",
    timeout: 60000,
    env: { ...cleanNodeTestEnv(), CODUMENT_TARGET: root },
  });

  const status = classifyDetectorRun(result, bug.id);
  const evidence =
    status === "caught"
      ? "detector passed — bug fixed before commit"
      : `detector failed — bug still present: ${summarizeCommandOutput(result)}`;

  return {
    id: bug.id,
    title: bug.title,
    file: bug.file,
    tier: bug.tier,
    status,
    evidence,
  };
}

async function checkScenarioLock(
  root: string,
): Promise<{ status: "pass" | "fail"; evidence: string }> {
  const expected = await readFile(
    join(seededProjectFixtureRoot(), SCENARIO_FILE),
    "utf-8",
  );
  const actual = await readFile(join(root, SCENARIO_FILE), "utf-8").catch(
    () => null,
  );
  if (actual !== expected) {
    return {
      status: "fail",
      evidence: `${SCENARIO_FILE} does not match the packaged scenario`,
    };
  }
  return {
    status: "pass",
    evidence: `${SCENARIO_FILE} matches the packaged scenario`,
  };
}

async function loadComparison(
  baselineDir: string | undefined,
  catchRatePercent: number,
): Promise<SeededBenchmarkComparison | undefined> {
  if (!baselineDir) return undefined;
  const baselinePath = join(resolve(baselineDir), RESULT_FILE);
  const baseline = await readJson<{
    mode?: unknown;
    catchRatePercent?: unknown;
    lockCheck?: unknown;
  }>(baselinePath).catch(() => null);

  if (!baseline || typeof baseline.catchRatePercent !== "number") {
    throw new Error(
      `Baseline result not found or unscored: ${baselinePath} (score the baseline directory first)`,
    );
  }

  // Only a result from a clean (lock-passing) run is a trustworthy baseline.
  if (baseline.lockCheck !== "pass") {
    throw new Error(
      `Baseline result is not from a clean run: ${baselinePath} (its lock check did not pass) — re-score an untampered baseline`,
    );
  }

  const baselineMode: SeededBenchmarkMode =
    baseline.mode === "loop" || baseline.mode === "no-loop"
      ? baseline.mode
      : "unspecified";

  return {
    baselineMode,
    baselineCatchRatePercent: baseline.catchRatePercent,
    deltaPercent: catchRatePercent - baseline.catchRatePercent,
  };
}

async function persistResult(
  root: string,
  report: SeededBenchmarkScoreReport,
): Promise<void> {
  const payload = {
    schemaVersion: 1,
    fixture: report.fixture,
    mode: report.mode,
    lockCheck: report.lockCheck.status,
    caught: report.caught,
    total: report.total,
    catchRatePercent: report.catchRatePercent,
    bugs: report.bugs.map((bug) => ({ id: bug.id, status: bug.status })),
  };
  await writeFile(
    join(root, RESULT_FILE),
    JSON.stringify(payload, null, 2) + "\n",
  );
}

function gitInitBaseline(root: string): { initialized: boolean; note: string } {
  const base = {
    cwd: root,
    encoding: "utf-8" as const,
    timeout: 15000,
  };
  const init = spawnSync("git", ["init", "-q"], base);
  if (init.status !== 0) {
    return { initialized: false, note: "git not available" };
  }
  const identity = [
    "-c",
    "user.email=benchmark@codument.dev",
    "-c",
    "user.name=Codument Benchmark",
    "-c",
    "commit.gpgsign=false",
  ];
  spawnSync("git", ["add", "-A"], base);
  const commit = spawnSync(
    "git",
    [...identity, "commit", "-q", "-m", "baseline"],
    base,
  );
  if (commit.status !== 0) {
    return {
      initialized: false,
      note: `git commit failed: ${summarizeCommandOutput(commit)}`,
    };
  }
  return { initialized: true, note: "baseline committed" };
}

async function readSeededManifest(): Promise<{ bugs: SeededBugManifestEntry[] }> {
  const manifest = await readJson<{ bugs?: unknown }>(
    join(seededFixtureRoot(), "bugs.json"),
  );
  if (!Array.isArray(manifest.bugs)) {
    throw new Error("seeded-bugs manifest is missing a bugs array");
  }
  return { bugs: manifest.bugs as SeededBugManifestEntry[] };
}

function seededFixtureRoot(): string {
  return join(packageRoot(), "fixtures", "benchmarks", SEEDED_FIXTURE);
}

function seededProjectFixtureRoot(): string {
  return join(seededFixtureRoot(), "project");
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf-8")) as T;
}

function cleanNodeTestEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Strip every variable that can change a `node --test` subprocess's exit code
  // independently of the target's code (NODE_OPTIONS flags like
  // --test-name-pattern, coverage/instrumentation hooks, the test-runner
  // context). Otherwise the caller's ambient environment could flip a detector's
  // verdict and the catch rate would not be a pure function of the file state.
  delete env.NODE_OPTIONS;
  delete env.NODE_V8_COVERAGE;
  for (const key of Object.keys(env)) {
    if (key.startsWith("NODE_TEST_")) delete env[key];
  }
  return env;
}

function summarizeCommandOutput(result: ReturnType<typeof spawnSync>): string {
  const output = [result.error?.message, result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  return output.slice(0, 300) || `exit status ${String(result.status)}`;
}
