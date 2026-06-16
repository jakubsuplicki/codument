import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  cp,
  symlink,
  writeFile,
  readFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  estimateTokens,
  runContextBenchmark,
} from "../src/lib/benchmark-context.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CLI = join(ROOT, "dist", "cli.js");
const CONTEXT_FIXTURE = join(ROOT, "fixtures", "benchmarks", "context-routing");
const CHILD_ENV = { ...process.env };
delete CHILD_ENV.NODE_TEST_CONTEXT;

function runCli(
  ...args: string[]
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe("benchmark command", () => {
  it("exposes the benchmark command family", () => {
    const result = runCli("benchmark", "--help");

    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("context"));
    assert.ok(result.stdout.includes("init"));
    assert.ok(result.stdout.includes("score"));
  });

  it("runs the deterministic context benchmark", () => {
    const context = runCli("benchmark", "context");

    assert.equal(context.status, 0);
    assert.ok(context.stdout.includes("Fixture: context-routing"));
    assert.ok(context.stdout.includes("Task: Add skip-day support"));
    assert.ok(context.stdout.includes("Naive context:"));
    assert.ok(context.stdout.includes("Codument context:"));
    assert.ok(context.stdout.includes("estimated file-context tokens"));
    assert.ok(context.stdout.includes("Reduction:"));
    assert.ok(context.stdout.includes("Required docs found:       3/3"));
    assert.ok(context.stdout.includes("Required source files:     4/4"));
    assert.ok(context.stdout.includes("Irrelevant files included: 0/8"));
  });

  it("prints the context benchmark as stable JSON", () => {
    const context = runCli("benchmark", "context", "--json");

    assert.equal(context.status, 0);
    const report = JSON.parse(context.stdout);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.fixture, "context-routing");
    assert.deepStrictEqual(report.tokenEstimate, {
      unit: "estimated file-context tokens",
      heuristic: "ceil(characters / 4)",
    });
    assert.equal(report.task.id, "meal-plan-skip-day");
    assert.equal(report.naive.files.length, 16);
    assert.equal(report.codument.files.length, 8);
    assert.equal(report.requiredDocsFound, 3);
    assert.equal(report.requiredSourcesFound, 4);
    assert.equal(report.irrelevantFilesIncluded, 0);
    assert.deepStrictEqual(report.codument.files, [
      "docs/.registry.json",
      "docs/concepts/date-utils.md",
      "docs/concepts/timezone-utils.md",
      "docs/features/meal-plans.md",
      "src/features/meal-plans/plans.ts",
      "src/features/meal-plans/schedule.ts",
      "src/lib/date-utils.ts",
      "src/lib/timezone-utils.ts",
    ]);
  });

  it("initializes a self-contained quality benchmark fixture", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-quality-init-"));
    const target = join(tmp, "quality-app");
    try {
      const init = runCli("benchmark", "init", target);

      assert.equal(init.status, 0);
      assert.ok(init.stdout.includes("Fixture: quality-app"));
      assert.ok(init.stdout.includes("Task: skip-day-support"));
      assert.ok(init.stdout.includes("Add skip-day support"));
      assert.ok(existsSync(join(target, "package.json")));
      assert.ok(existsSync(join(target, "BENCHMARK_TASK.md")));
      assert.ok(existsSync(join(target, "AGENTS.md")));
      assert.ok(
        existsSync(join(target, ".agents", "skills", "work-step", "SKILL.md")),
      );
      assert.ok(existsSync(join(target, ".codument", "benchmark.json")));
      const benchmarkMetadata = JSON.parse(
        await readFile(join(target, ".codument", "benchmark.json"), "utf-8"),
      );
      assert.deepStrictEqual(benchmarkMetadata, {
        schemaVersion: 1,
        fixture: "quality-app",
        taskId: "skip-day-support",
      });

      const meta = JSON.parse(
        await readFile(join(target, ".codument-meta.json"), "utf-8"),
      );
      assert.equal(meta.benchmark.fixture, "quality-app");
      assert.deepStrictEqual(meta.agents, ["codex"]);

      const registry = JSON.parse(
        await readFile(join(target, "docs", ".registry.json"), "utf-8"),
      );
      assert.deepStrictEqual(registry.features["weekly-plans"].primary_sources, [
        "src/plans/weekly-plan.js",
      ]);

      execFileSync("node", ["--test"], {
        cwd: target,
        env: CHILD_ENV,
        encoding: "utf-8",
        timeout: 10000,
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("initializes the quality benchmark with full Claude profile assets", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-quality-claude-"));
    const target = join(tmp, "quality-app");
    try {
      const init = runCli("benchmark", "init", "--agents", "claude", target);

      assert.equal(init.status, 0);
      assert.ok(existsSync(join(target, "AGENTS.md")));
      assert.ok(existsSync(join(target, "CLAUDE.md")));
      assert.ok(
        existsSync(join(target, ".claude", "skills", "work-step", "SKILL.md")),
      );
      assert.ok(
        existsSync(join(target, ".claude", "rules", "documentation.md")),
      );
      assert.ok(
        existsSync(join(target, ".claude", "agents", "code-reviewer.md")),
      );
      assert.ok(existsSync(join(target, ".claude", "settings.json")));
      assert.ok(!existsSync(join(target, ".agents")));

      const rule = await readFile(
        join(target, ".claude", "rules", "documentation.md"),
        "utf-8",
      );
      assert.ok(rule.includes('paths: ["src/**/*.js","test/**/*.js"]'));

      const settings = JSON.parse(
        await readFile(join(target, ".claude", "settings.json"), "utf-8"),
      );
      assert.equal(
        settings.hooks.PostToolUse[0].matcher,
        "Write|Edit|MultiEdit",
      );

      const meta = JSON.parse(
        await readFile(join(target, ".codument-meta.json"), "utf-8"),
      );
      assert.deepStrictEqual(meta.agents, ["claude"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("does not initialize into a non-empty target directory", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-quality-non-empty-"));
    try {
      await writeFile(join(tmp, "keep.txt"), "existing work\n");

      const init = runCli("benchmark", "init", tmp);

      assert.equal(init.status, 1);
      assert.ok(init.stderr.includes("Target directory must be empty"));
      assert.ok(!existsSync(join(tmp, "BENCHMARK_TASK.md")));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("scores an incomplete initialized quality benchmark as failed", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-quality-score-fail-"));
    const target = join(tmp, "quality-app");
    try {
      const init = runCli("benchmark", "init", target);
      assert.equal(init.status, 0);

      const score = runCli("benchmark", "score", target);

      assert.equal(score.status, 1);
      assert.ok(score.stdout.includes("Result: FAIL"));
      assert.ok(score.stdout.includes("FAIL required-behavior"));
      assert.ok(score.stdout.includes("skipDay export is missing"));
      assert.ok(score.stdout.includes("FAIL docs-updated"));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("scores a completed quality benchmark as passing", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-quality-score-pass-"));
    const target = join(tmp, "quality-app");
    try {
      const init = runCli("benchmark", "init", target);
      assert.equal(init.status, 0);
      await writePassingQualitySolution(target);

      const score = runCli("benchmark", "score", target);

      assert.equal(score.status, 0);
      assert.ok(score.stdout.includes("Result: PASS"));
      assert.ok(score.stdout.includes("Score: 9/9 (100%)"));
      assert.ok(score.stdout.includes("PASS required-behavior"));
      assert.ok(score.stdout.includes("PASS docs-updated"));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("fails quality scoring when locked benchmark metadata changes", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-quality-score-lock-"));
    const target = join(tmp, "quality-app");
    try {
      const init = runCli("benchmark", "init", target);
      assert.equal(init.status, 0);
      await writePassingQualitySolution(target);
      await writeFile(
        join(target, ".codument", "benchmark.json"),
        '{"schemaVersion":1,"fixture":"quality-app","taskId":"skip-day-support"}\n',
      );

      const score = runCli("benchmark", "score", target);

      assert.equal(score.status, 1);
      assert.ok(score.stdout.includes("Result: FAIL"));
      assert.ok(score.stdout.includes("FAIL locked-files"));
      assert.ok(score.stdout.includes(".codument/benchmark.json"));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("declares benchmark fixtures as packaged files", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf-8"));
    assert.ok(pkg.files.includes("fixtures"));
    assert.ok(existsSync(join(ROOT, "fixtures", "benchmarks", "manifest.json")));
  });

  it("runs the context benchmark from a packed package", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-packed-"));
    try {
      const packOutput = execFileSync(
        "npm",
        [
          "--cache",
          "/private/tmp/codument-npm-cache",
          "pack",
          "--json",
          "--pack-destination",
          tmp,
        ],
        {
          cwd: ROOT,
          encoding: "utf-8",
          timeout: 20000,
        },
      );
      const packInfo = JSON.parse(packOutput)[0] as { filename: string };
      const tarballPath = join(tmp, packInfo.filename);
      execFileSync("tar", ["-xzf", tarballPath, "-C", tmp], {
        encoding: "utf-8",
        timeout: 20000,
      });

      await symlink(join(ROOT, "node_modules"), join(tmp, "package", "node_modules"));
      const packedCli = join(tmp, "package", "dist", "cli.js");
      const output = execFileSync("node", [packedCli, "benchmark", "context"], {
        encoding: "utf-8",
        timeout: 10000,
      });

      assert.ok(output.includes("Fixture: context-routing"));
      assert.ok(output.includes("Required docs found:       3/3"));
      assert.ok(output.includes("Irrelevant files included: 0/8"));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("estimates tokens with a stable local heuristic", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("a"), 1);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
  });

  it("scores the context fixture deterministically", async () => {
    const report = await runContextBenchmark(
      CONTEXT_FIXTURE,
    );

    assert.equal(report.fixture, "context-routing");
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.task.id, "meal-plan-skip-day");
    assert.equal(report.requiredDocsFound, 3);
    assert.equal(report.requiredDocsTotal, 3);
    assert.equal(report.requiredSourcesFound, 4);
    assert.equal(report.requiredSourcesTotal, 4);
    assert.equal(report.irrelevantFilesIncluded, 0);
    assert.equal(report.irrelevantFilesTotal, 8);
    assert.ok(report.codument.estimatedTokens < report.naive.estimatedTokens);
    assert.ok(report.reductionPercent > 30);
    assert.deepStrictEqual(report.codument.files, [
      "docs/.registry.json",
      "docs/concepts/date-utils.md",
      "docs/concepts/timezone-utils.md",
      "docs/features/meal-plans.md",
      "src/features/meal-plans/plans.ts",
      "src/features/meal-plans/schedule.ts",
      "src/lib/date-utils.ts",
      "src/lib/timezone-utils.ts",
    ]);
  });

  it("fails when the context fixture task references missing files", async () => {
    const tmpFixture = await mkdtemp(join(tmpdir(), "codument-context-missing-"));
    try {
      await mkdir(join(tmpFixture, "project", "docs"), { recursive: true });
      await writeFile(
        join(tmpFixture, "task.json"),
        JSON.stringify(
          {
            fixture: "missing",
            task: {
              id: "missing-file",
              title: "Missing file",
              featureKeys: [],
              requiredDocs: ["docs/missing.md"],
              requiredSources: [],
              irrelevantFiles: ["src/missing.ts"],
            },
          },
          null,
          2,
        ),
      );
      await writeFile(
        join(tmpFixture, "project", "docs", ".registry.json"),
        JSON.stringify({ features: {} }, null, 2),
      );

      await assert.rejects(
        () => runContextBenchmark(tmpFixture),
        /references missing files: docs\/missing.md, src\/missing.ts/,
      );
    } finally {
      await rm(tmpFixture, { recursive: true, force: true });
    }
  });

  it("fails when registry entries point at missing files", async () => {
    const tmpFixture = await copyContextFixture();
    try {
      const registryPath = join(tmpFixture, "project", "docs", ".registry.json");
      const registry = JSON.parse(await readFile(registryPath, "utf-8"));
      registry.features["date-utils"].primary_sources = ["src/lib/deleted-date-utils.ts"];
      await writeFile(registryPath, JSON.stringify(registry, null, 2));

      await assert.rejects(
        () => runContextBenchmark(tmpFixture),
        /ENOENT.*deleted-date-utils\.ts/,
      );
    } finally {
      await rm(tmpFixture, { recursive: true, force: true });
    }
  });

  it("fails when Codument context misses a transitive dependency", async () => {
    const tmpFixture = await copyContextFixture();
    try {
      const registryPath = join(tmpFixture, "project", "docs", ".registry.json");
      const registry = JSON.parse(await readFile(registryPath, "utf-8"));
      registry.features["date-utils"].depends_on = [];
      await writeFile(registryPath, JSON.stringify(registry, null, 2));

      await assert.rejects(
        () => runContextBenchmark(tmpFixture),
        /missing required files: docs\/concepts\/timezone-utils.md, src\/lib\/timezone-utils.ts/,
      );
    } finally {
      await rm(tmpFixture, { recursive: true, force: true });
    }
  });

  it("fails when Codument context includes irrelevant files", async () => {
    const tmpFixture = await copyContextFixture();
    try {
      const registryPath = join(tmpFixture, "project", "docs", ".registry.json");
      const registry = JSON.parse(await readFile(registryPath, "utf-8"));
      registry.features["meal-plans"].depends_on.push("billing");
      await writeFile(registryPath, JSON.stringify(registry, null, 2));

      await assert.rejects(
        () => runContextBenchmark(tmpFixture),
        /includes irrelevant files: docs\/features\/billing.md, src\/features\/billing\/invoices.ts/,
      );
    } finally {
      await rm(tmpFixture, { recursive: true, force: true });
    }
  });

  it("handles cyclic registry dependencies without looping", async () => {
    const tmpFixture = await copyContextFixture();
    try {
      const registryPath = join(tmpFixture, "project", "docs", ".registry.json");
      const registry = JSON.parse(await readFile(registryPath, "utf-8"));
      registry.features["timezone-utils"].depends_on = ["meal-plans"];
      await writeFile(registryPath, JSON.stringify(registry, null, 2));

      const report = await runContextBenchmark(tmpFixture);
      assert.equal(report.requiredDocsFound, 3);
      assert.equal(report.requiredSourcesFound, 4);
      assert.equal(report.irrelevantFilesIncluded, 0);
    } finally {
      await rm(tmpFixture, { recursive: true, force: true });
    }
  });
});

async function copyContextFixture(): Promise<string> {
  const tmpFixture = await mkdtemp(join(tmpdir(), "codument-context-fixture-"));
  await cp(CONTEXT_FIXTURE, tmpFixture, { recursive: true });
  return tmpFixture;
}

async function writePassingQualitySolution(target: string): Promise<void> {
  await writeFile(
    join(target, "src", "plans", "weekly-plan.js"),
    `import { MEAL_SLOTS, getMealSlot, normalizeMealName } from "../domain/menu.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function createWeeklyPlan({ startDate, days = 7, mealsByDay = {} }) {
  assertIsoDate(startDate);

  return {
    startDate,
    days: Array.from({ length: days }, (_, index) => {
      const isoDate = addDays(startDate, index);
      const overrides = mealsByDay[isoDate] ?? {};

      return {
        isoDate,
        meals: MEAL_SLOTS.map((slot) => ({
          slot: slot.id,
          label: slot.label,
          name: normalizeMealName(overrides[slot.id] ?? slot.defaultMeal),
        })),
      };
    }),
  };
}

export function skipDay(plan, isoDate, reason) {
  assertIsoDate(isoDate);

  return {
    ...plan,
    days: plan.days.map((day) => {
      if (day.isoDate !== isoDate) return day;

      return {
        ...day,
        skipped: true,
        skipReason: String(reason).trim(),
        meals: [],
      };
    }),
  };
}

export function summarizePlan(plan) {
  return {
    days: plan.days.length,
    meals: plan.days.reduce((total, day) => total + day.meals.length, 0),
    skippedDays: plan.days.filter((day) => day.skipped === true).length,
  };
}

export function updateMeal(plan, isoDate, slotId, name) {
  assertIsoDate(isoDate);
  getMealSlot(slotId);

  return {
    ...plan,
    days: plan.days.map((day) => {
      if (day.isoDate !== isoDate) return day;
      if (day.skipped) {
        throw new Error(\`Cannot update meals for skipped day: \${isoDate}\`);
      }

      return {
        ...day,
        meals: day.meals.map((meal) =>
          meal.slot === slotId
            ? { ...meal, name: normalizeMealName(name) }
            : meal,
        ),
      };
    }),
  };
}

function addDays(startDate, offset) {
  const date = new Date(\`\${startDate}T00:00:00.000Z\`);
  date.setTime(date.getTime() + offset * DAY_MS);
  return date.toISOString().slice(0, 10);
}

function assertIsoDate(value) {
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) {
    throw new Error(\`Expected ISO date, received: \${value}\`);
  }
}
`,
  );

  await writeFile(
    join(target, "test", "weekly-plan.test.js"),
    `import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createWeeklyPlan,
  skipDay,
  summarizePlan,
  updateMeal,
} from "../src/plans/weekly-plan.js";

describe("weekly plans", () => {
  it("creates a seven-day plan with default meals", () => {
    const plan = createWeeklyPlan({ startDate: "2026-06-01" });

    assert.equal(plan.days.length, 7);
    assert.deepEqual(plan.days[0], {
      isoDate: "2026-06-01",
      meals: [
        { slot: "breakfast", label: "Breakfast", name: "overnight oats" },
        { slot: "lunch", label: "Lunch", name: "grain bowl" },
        { slot: "dinner", label: "Dinner", name: "vegetable curry" },
      ],
    });
  });

  it("summarizes skippedDays and removes meals for skipped dates", () => {
    const plan = createWeeklyPlan({ startDate: "2026-06-01", days: 2 });
    const skipped = skipDay(plan, "2026-06-02", "  Eating out ");

    assert.deepEqual(skipped.days[1], {
      isoDate: "2026-06-02",
      skipped: true,
      skipReason: "Eating out",
      meals: [],
    });
    assert.deepEqual(summarizePlan(skipped), {
      days: 2,
      meals: 3,
      skippedDays: 1,
    });
  });

  it("rejects meal edits for skipped days", () => {
    const plan = createWeeklyPlan({ startDate: "2026-06-01", days: 2 });
    const skipped = skipDay(plan, "2026-06-02", "away");

    assert.throws(() => updateMeal(skipped, "2026-06-02", "dinner", "pizza"));
  });
});
`,
  );

  await writeFile(
    join(target, "docs", "features", "weekly-plans.md"),
    `---
title: Weekly Plans
status: current
type: feature
sources:
  - src/plans/weekly-plan.js
depends_on:
  - meal-catalog
last_reviewed: 2026-05-29
---

## Summary

Weekly plans produce immutable seven-day meal schedules from a start date and optional meal overrides.

## Current Behavior

- \`createWeeklyPlan\` accepts an ISO start date, an optional day count, and optional per-date meal overrides.
- \`skipDay\` marks an existing day as skipped, stores the trimmed reason in \`skipReason\`, and removes meals for that date.
- \`summarizePlan\` returns total day and meal counts plus \`skippedDays\`.
- \`updateMeal\` returns a new plan with one meal changed and rejects edits for skipped days.

## Boundaries

Meal slot labels, defaults, and name normalization belong to the meal catalog concept. Weekly plans should orchestrate those helpers rather than duplicating catalog rules.
`,
  );
}
