import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DELIVERY_SKILLS,
  getAgentProfiles,
  parseAgentIds,
  type AgentProfileId,
} from "./agent-profiles.js";
import {
  buildManagedSection,
  agentsDir,
  ensureDir,
  packageRoot,
  rulesDir,
  skillsDir,
  upsertManagedSection,
} from "./scaffold.js";
import { ensureClaudeDocsHook } from "./claude-settings.js";
import { readRegistry } from "./registry.js";
import { version as pkgVersion } from "./version.js";

export interface QualityBenchmarkInitOptions {
  agents?: string;
}

export interface QualityBenchmarkInitReport {
  schemaVersion: 1;
  fixture: "quality-app";
  taskId: "skip-day-support";
  targetDir: string;
  agents: AgentProfileId[];
  taskPrompt: string;
}

export type QualityBenchmarkCheckStatus = "pass" | "fail";

export interface QualityBenchmarkScoreCheck {
  id: string;
  title: string;
  status: QualityBenchmarkCheckStatus;
  evidence: string;
}

export interface QualityBenchmarkScoreReport {
  schemaVersion: 1;
  fixture: "quality-app";
  taskId: "skip-day-support";
  targetDir: string;
  result: QualityBenchmarkCheckStatus;
  score: {
    passed: number;
    total: number;
    percent: number;
  };
  checks: QualityBenchmarkScoreCheck[];
}

const QUALITY_FIXTURE = "quality-app";
const QUALITY_TASK_ID = "skip-day-support";
const QUALITY_SOURCE_GLOBS = ["src/**/*.js", "test/**/*.js"];

export async function initializeQualityBenchmark(
  targetDir: string,
  options: QualityBenchmarkInitOptions = {},
): Promise<QualityBenchmarkInitReport> {
  const root = resolve(targetDir);
  const fixtureRoot = join(
    packageRoot(),
    "fixtures",
    "benchmarks",
    QUALITY_FIXTURE,
  );
  const projectSource = join(fixtureRoot, "project");
  const taskPrompt = await readFile(join(fixtureRoot, "task.md"), "utf-8");
  const agentIds = parseAgentIds(options.agents);
  const selectedAgentIds: AgentProfileId[] =
    agentIds.length > 0 ? agentIds : ["codex"];

  await assertTargetIsWritable(root);
  await mkdir(dirname(root), { recursive: true });
  await cp(projectSource, root, { recursive: true, force: true });

  await installBenchmarkAgentAssets(root, selectedAgentIds);
  await writeCodumentMeta(root, selectedAgentIds);
  await writeFile(join(root, "BENCHMARK_TASK.md"), taskPrompt);

  return {
    schemaVersion: 1,
    fixture: QUALITY_FIXTURE,
    taskId: QUALITY_TASK_ID,
    targetDir: root,
    agents: selectedAgentIds,
    taskPrompt,
  };
}

export function formatQualityBenchmarkInitReport(
  report: QualityBenchmarkInitReport,
): string {
  const agents = report.agents.join(", ");

  return [
    "codument benchmark init",
    "",
    `Fixture: ${report.fixture}`,
    `Task: ${report.taskId}`,
    `Target: ${report.targetDir}`,
    `Agents: ${agents}`,
    "",
    "Created a self-contained fixture project.",
    "",
    "Next:",
    `  cd ${report.targetDir}`,
    "  npm test",
    "  Give your coding agent the prompt below, or open BENCHMARK_TASK.md.",
    "",
    "----- agent prompt -----",
    report.taskPrompt.trimEnd(),
    "----- end prompt -----",
    "",
  ].join("\n");
}

export async function scoreQualityBenchmark(
  targetDir: string,
): Promise<QualityBenchmarkScoreReport> {
  const root = resolve(targetDir);
  if (!existsSync(root)) {
    throw new Error(`Target directory does not exist: ${root}`);
  }

  const targetStat = await stat(root);
  if (!targetStat.isDirectory()) {
    throw new Error(`Target is not a directory: ${root}`);
  }

  const checks = await runQualityChecks(root);
  const passed = checks.filter((check) => check.status === "pass").length;
  const total = checks.length;

  return {
    schemaVersion: 1,
    fixture: QUALITY_FIXTURE,
    taskId: QUALITY_TASK_ID,
    targetDir: root,
    result: passed === total ? "pass" : "fail",
    score: {
      passed,
      total,
      percent: total === 0 ? 0 : Math.round((passed / total) * 100),
    },
    checks,
  };
}

export function formatQualityBenchmarkScoreReport(
  report: QualityBenchmarkScoreReport,
): string {
  const result = report.result === "pass" ? "PASS" : "FAIL";
  const lines = [
    "codument benchmark score",
    "",
    `Fixture: ${report.fixture}`,
    `Task: ${report.taskId}`,
    `Target: ${report.targetDir}`,
    `Score: ${report.score.passed}/${report.score.total} (${report.score.percent}%)`,
    `Result: ${result}`,
    "",
    "Evidence:",
  ];

  for (const check of report.checks) {
    lines.push(`  ${check.status.toUpperCase()} ${check.id}: ${check.title}`);
    lines.push(`    ${check.evidence}`);
  }

  lines.push("");
  return lines.join("\n");
}

async function assertTargetIsWritable(targetDir: string): Promise<void> {
  if (!existsSync(targetDir)) return;

  const targetStat = await stat(targetDir);
  if (!targetStat.isDirectory()) {
    throw new Error(`Target exists and is not a directory: ${targetDir}`);
  }

  const entries = await readdir(targetDir);
  if (entries.length > 0) {
    throw new Error(`Target directory must be empty: ${targetDir}`);
  }
}

async function installBenchmarkAgentAssets(
  root: string,
  agentIds: AgentProfileId[],
): Promise<void> {
  const profiles = getAgentProfiles(agentIds);

  for (const profile of profiles) {
    for (const skill of DELIVERY_SKILLS) {
      const source = join(skillsDir(), skill);
      if (!existsSync(source)) continue;

      const dest = join(root, profile.skillsDir, skill);
      await mkdir(dirname(dest), { recursive: true });
      await cp(source, dest, { recursive: true, force: true });
    }

    for (const file of profile.instructionFiles) {
      const content =
        file === "CLAUDE.md" ? buildClaudeManagedSection() : buildManagedSection();
      await upsertManagedSection(join(root, file), content);
    }

    if (profile.rulesDir) {
      const rulesDest = join(root, profile.rulesDir, "documentation.md");
      ensureDir(dirname(rulesDest));
      const ruleTemplate = await readFile(
        join(rulesDir(), "documentation.md"),
        "utf-8",
      );
      const rule = ruleTemplate.replace(
        /^paths: \[.*\]/m,
        `paths: ${JSON.stringify(QUALITY_SOURCE_GLOBS)}`,
      );
      await writeFile(rulesDest, rule);
    }

    if (profile.agentsDir) {
      ensureDir(join(root, profile.agentsDir));
      for (const agent of ["doc-writer.md", "doc-scanner.md", "code-reviewer.md"]) {
        await cp(join(agentsDir(), agent), join(root, profile.agentsDir, agent));
      }
    }

    if (profile.settingsFile) {
      const settingsPath = join(root, profile.settingsFile);
      ensureDir(dirname(settingsPath));
      const result = ensureClaudeDocsHook();
      await writeFile(
        settingsPath,
        JSON.stringify(result.settings, null, 2) + "\n",
      );
    }
  }
}

async function writeCodumentMeta(
  root: string,
  agents: AgentProfileId[],
): Promise<void> {
  const date = new Date().toISOString().split("T")[0];

  await writeFile(
    join(root, ".codument-meta.json"),
    JSON.stringify(
      {
        version: pkgVersion,
        initialized: date,
        agents,
        project: {
          language: "javascript",
          framework: null,
          srcDir: "src",
          sourceGlobs: QUALITY_SOURCE_GLOBS,
        },
        benchmark: {
          schemaVersion: 1,
          fixture: QUALITY_FIXTURE,
          taskId: QUALITY_TASK_ID,
        },
      },
      null,
      2,
    ) + "\n",
  );
}

function buildClaudeManagedSection(): string {
  return `## Claude Compatibility

Shared agent guidance lives in \`AGENTS.md\`. Follow that file as the canonical Codument workflow contract.

${buildManagedSection()}`;
}

async function runQualityChecks(
  root: string,
): Promise<QualityBenchmarkScoreCheck[]> {
  const checks: Array<{
    id: string;
    title: string;
    run: () => Promise<string>;
  }> = [
    {
      id: "benchmark-metadata",
      title: "Benchmark metadata identifies the packaged quality task",
      run: () => checkBenchmarkMetadata(root),
    },
    {
      id: "locked-files",
      title: "Locked benchmark files were not modified",
      run: () => checkLockedFiles(root),
    },
    {
      id: "package-tests",
      title: "Fixture test suite passes",
      run: () => checkPackageTests(root),
    },
    {
      id: "required-behavior",
      title: "Skip-day behavior works through the public API",
      run: () => checkRequiredBehavior(root),
    },
    {
      id: "tests-updated",
      title: "Task behavior is covered by fixture tests",
      run: () => checkTestsUpdated(root),
    },
    {
      id: "registry-coverage",
      title: "Docs registry still maps the affected source files",
      run: () => checkRegistryCoverage(root),
    },
    {
      id: "docs-updated",
      title: "Feature docs describe the new skip-day behavior",
      run: () => checkDocsUpdated(root),
    },
    {
      id: "source-boundary",
      title: "Meal catalog boundary stayed unchanged",
      run: () => checkSourceBoundary(root),
    },
    {
      id: "shortcut-scan",
      title: "Source does not contain benchmark-specific shortcuts",
      run: () => checkForbiddenShortcuts(root),
    },
  ];

  const results: QualityBenchmarkScoreCheck[] = [];
  for (const check of checks) {
    results.push(await runQualityCheck(check.id, check.title, check.run));
  }
  return results;
}

async function runQualityCheck(
  id: string,
  title: string,
  run: () => Promise<string>,
): Promise<QualityBenchmarkScoreCheck> {
  try {
    return {
      id,
      title,
      status: "pass",
      evidence: await run(),
    };
  } catch (error) {
    return {
      id,
      title,
      status: "fail",
      evidence: (error as Error).message,
    };
  }
}

async function checkBenchmarkMetadata(root: string): Promise<string> {
  const metadata = await readJson<Record<string, unknown>>(
    join(root, ".codument", "benchmark.json"),
  );

  assertEqual(metadata.schemaVersion, 1, "schemaVersion must be 1");
  assertEqual(metadata.fixture, QUALITY_FIXTURE, "fixture must be quality-app");
  assertEqual(metadata.taskId, QUALITY_TASK_ID, "taskId must be skip-day-support");

  return ".codument/benchmark.json matches the expected quality fixture metadata";
}

async function checkLockedFiles(root: string): Promise<string> {
  const baselineRoot = qualityProjectFixtureRoot();
  const lock = await readJson<{ lockedFiles?: unknown }>(
    join(baselineRoot, "benchmark.lock.json"),
  );
  const lockedFiles = Array.isArray(lock.lockedFiles)
    ? lock.lockedFiles.filter((file): file is string => typeof file === "string")
    : [];

  if (lockedFiles.length === 0) {
    throw new Error("packaged benchmark.lock.json does not define lockedFiles");
  }

  const changedFiles: string[] = [];
  for (const file of lockedFiles) {
    const expected = await readFile(join(baselineRoot, file), "utf-8");
    const actual = await readFile(join(root, file), "utf-8").catch(() => null);
    if (actual !== expected) {
      changedFiles.push(file);
    }
  }

  if (changedFiles.length > 0) {
    throw new Error(`locked files changed: ${changedFiles.join(", ")}`);
  }

  return `${lockedFiles.length} locked files match the packaged fixture`;
}

async function checkPackageTests(root: string): Promise<string> {
  const result = spawnSync("npm", ["test"], {
    cwd: root,
    encoding: "utf-8",
    env: cleanNodeTestEnv(),
    timeout: 15000,
  });

  if (result.status !== 0) {
    throw new Error(`npm test failed: ${summarizeCommandOutput(result)}`);
  }

  return "npm test completed successfully";
}

async function checkRequiredBehavior(root: string): Promise<string> {
  const moduleUrl = pathToFileURL(
    join(root, "src", "plans", "weekly-plan.js"),
  );
  moduleUrl.search = `codument-score=${Date.now()}-${Math.random()}`;
  const weeklyPlan = await import(moduleUrl.href) as Record<string, unknown>;
  const createWeeklyPlan = weeklyPlan.createWeeklyPlan;
  const skipDay = weeklyPlan.skipDay;
  const summarizePlan = weeklyPlan.summarizePlan;
  const updateMeal = weeklyPlan.updateMeal;

  if (typeof createWeeklyPlan !== "function") {
    throw new Error("createWeeklyPlan export is missing");
  }
  if (typeof skipDay !== "function") {
    throw new Error("skipDay export is missing");
  }
  if (typeof summarizePlan !== "function") {
    throw new Error("summarizePlan export is missing");
  }
  if (typeof updateMeal !== "function") {
    throw new Error("updateMeal export is missing");
  }

  const plan = createWeeklyPlan({
    startDate: "2026-06-01",
    days: 3,
  });
  const skipped = skipDay(plan, "2026-06-02", "  Eating out  ");
  const skippedDay = skipped.days.find(
    (day: { isoDate?: string }) => day.isoDate === "2026-06-02",
  );

  if (!skippedDay) {
    throw new Error("skipDay removed the skipped day from the plan");
  }
  assertEqual(skippedDay.skipped, true, "skipped day must set skipped: true");
  assertEqual(
    skippedDay.skipReason,
    "Eating out",
    "skipped day must store the trimmed skip reason",
  );
  assertEqual(
    skippedDay.meals.length,
    0,
    "skipped day must not keep meal entries",
  );

  const summary = summarizePlan(skipped);
  assertEqual(summary.days, 3, "summarizePlan must keep the day count");
  assertEqual(summary.meals, 6, "summarizePlan must exclude skipped-day meals");
  assertEqual(summary.skippedDays, 1, "summarizePlan must count skipped days");

  let rejectedSkippedEdit = false;
  try {
    updateMeal(skipped, "2026-06-02", "dinner", "pizza");
  } catch {
    rejectedSkippedEdit = true;
  }
  if (!rejectedSkippedEdit) {
    throw new Error("updateMeal must reject edits for skipped days");
  }

  return "skipDay, summarizePlan, and updateMeal satisfy the task behavior";
}

async function checkTestsUpdated(root: string): Promise<string> {
  const testFile = await readFile(
    join(root, "test", "weekly-plan.test.js"),
    "utf-8",
  );
  const missingTerms = ["skipDay", "skippedDays", "skipReason"].filter(
    (term) => !testFile.includes(term),
  );

  if (missingTerms.length > 0) {
    throw new Error(
      `test/weekly-plan.test.js is missing coverage terms: ${missingTerms.join(", ")}`,
    );
  }

  return "test/weekly-plan.test.js names skipDay, skippedDays, and skipReason";
}

async function checkRegistryCoverage(root: string): Promise<string> {
  const registry = await readRegistry(join(root, "docs", ".registry.json"));
  const weeklyPlans = registry.features["weekly-plans"];
  const mealCatalog = registry.features["meal-catalog"];

  if (!weeklyPlans) {
    throw new Error("registry is missing weekly-plans");
  }
  if (!mealCatalog) {
    throw new Error("registry is missing meal-catalog");
  }
  if (!weeklyPlans.sources.includes("src/plans/weekly-plan.js")) {
    throw new Error("weekly-plans does not map src/plans/weekly-plan.js");
  }
  if (!weeklyPlans.depends_on.includes("meal-catalog")) {
    throw new Error("weekly-plans no longer depends on meal-catalog");
  }
  if (!mealCatalog.sources.includes("src/domain/menu.js")) {
    throw new Error("meal-catalog does not map src/domain/menu.js");
  }
  await readFile(join(root, weeklyPlans.doc), "utf-8");
  await readFile(join(root, mealCatalog.doc), "utf-8");

  return "weekly-plans and meal-catalog registry entries are intact";
}

async function checkDocsUpdated(root: string): Promise<string> {
  const doc = await readFile(
    join(root, "docs", "features", "weekly-plans.md"),
    "utf-8",
  );
  const missingTerms = ["skipDay", "skippedDays", "skipReason"].filter(
    (term) => !doc.includes(term),
  );

  if (missingTerms.length > 0) {
    throw new Error(
      `docs/features/weekly-plans.md is missing: ${missingTerms.join(", ")}`,
    );
  }

  return "weekly plan docs describe skipDay, skippedDays, and skipReason";
}

async function checkSourceBoundary(root: string): Promise<string> {
  const baseline = await readFile(
    join(qualityProjectFixtureRoot(), "src", "domain", "menu.js"),
    "utf-8",
  );
  const actual = await readFile(
    join(root, "src", "domain", "menu.js"),
    "utf-8",
  );

  if (actual !== baseline) {
    throw new Error("src/domain/menu.js changed, but catalog behavior is out of scope");
  }

  return "src/domain/menu.js matches the packaged fixture";
}

async function checkForbiddenShortcuts(root: string): Promise<string> {
  const scannedFiles = [
    "src/plans/weekly-plan.js",
    "src/domain/menu.js",
    "test/weekly-plan.test.js",
  ];
  const forbiddenTerms = [
    "BENCHMARK_TASK",
    "benchmark.lock",
    "skip-day-support",
    ".codument",
  ];
  const matches: string[] = [];

  for (const file of scannedFiles) {
    const content = await readFile(join(root, file), "utf-8");
    for (const term of forbiddenTerms) {
      if (content.includes(term)) {
        matches.push(`${file} contains ${term}`);
      }
    }
  }

  if (matches.length > 0) {
    throw new Error(`benchmark-specific shortcuts found: ${matches.join(", ")}`);
  }

  return `${scannedFiles.length} source/test files are free of benchmark-specific shortcuts`;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf-8")) as T;
}

function qualityProjectFixtureRoot(): string {
  return join(
    packageRoot(),
    "fixtures",
    "benchmarks",
    QUALITY_FIXTURE,
    "project",
  );
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}; expected ${String(expected)}, received ${String(actual)}`);
  }
}

function cleanNodeTestEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function summarizeCommandOutput(result: ReturnType<typeof spawnSync>): string {
  const output = [
    result.error?.message,
    result.stdout,
    result.stderr,
  ]
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();

  return output.slice(0, 500) || `exit status ${String(result.status)}`;
}
