import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "dist", "cli.js");

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-test-"));
  await writeFile(
    join(tmp, "package.json"),
    JSON.stringify({
      name: "test-project",
      dependencies: { react: "^19.0.0" },
    }),
  );
  await writeFile(join(tmp, "tsconfig.json"), "{}");
  await mkdir(join(tmp, "docs"), { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function runAdopt(...args: string[]): string {
  return execFileSync("node", [CLI, "adopt", ...args], {
    cwd: tmp,
    encoding: "utf-8",
    timeout: 10000,
  });
}

describe("adopt command", () => {
  it("migrates legacy mappings and installs selected profiles", async () => {
    await writeFile(
      join(tmp, ".codument-meta.json"),
      JSON.stringify({
        version: "0.1.0",
        initialized: "2026-04-20",
        project: {
          language: "javascript",
          srcDir: ".",
          sourceGlobs: ["./**/*.js", "./**/*.jsx"],
          framework: null,
        },
      }),
    );
    await writeFile(
      join(tmp, "docs", ".registry.json"),
      JSON.stringify(
        {
          features: {},
          mappings: {
            "app/cook/[recipeId].tsx": [
              "features/cook-mode.md",
              "features/cook-mode-voice-control.md",
            ],
            "services/subscription/subscriptionService.ts": [
              "features/subscription-and-paywall.md",
            ],
          },
        },
        null,
        2,
      ) + "\n",
    );

    const output = runAdopt("--agents", "codex,claude");

    assert.ok(output.includes("migrated from legacy mappings"));
    assert.ok(existsSync(join(tmp, "docs", ".registry.backup.json")));
    assert.ok(existsSync(join(tmp, ".agents", "skills", "work-step", "SKILL.md")));
    assert.ok(existsSync(join(tmp, ".claude", "skills", "review-work", "SKILL.md")));

    const registry = JSON.parse(
      await readFile(join(tmp, "docs", ".registry.json"), "utf-8"),
    );
    assert.deepStrictEqual(registry.features["cook-mode"].sources, [
      "app/cook/[recipeId].tsx",
    ]);
    assert.deepStrictEqual(
      registry.features["cook-mode-voice-control"].sources,
      ["app/cook/[recipeId].tsx"],
    );
    assert.ok(!registry.mappings);

    const meta = JSON.parse(
      await readFile(join(tmp, ".codument-meta.json"), "utf-8"),
    );
    assert.deepStrictEqual(meta.agents, ["codex", "claude"]);
    assert.equal(meta.project.language, "typescript");
    assert.deepStrictEqual(meta.project.sourceGlobs, ["./**/*.ts", "./**/*.tsx"]);

    const settings = JSON.parse(
      await readFile(join(tmp, ".claude", "settings.json"), "utf-8"),
    );
    assert.equal(settings.hooks.PostToolUse[0].matcher, "Write|Edit|MultiEdit");
  });

  it("dry run does not rewrite legacy registry", async () => {
    const registryPath = join(tmp, "docs", ".registry.json");
    const legacyRegistry = JSON.stringify(
      {
        mappings: {
          "src/lib/registry.ts": ["concepts/lib.md"],
        },
      },
      null,
      2,
    ) + "\n";
    await writeFile(registryPath, legacyRegistry);

    const output = runAdopt("--dry-run", "--agents", "codex");

    assert.ok(output.includes("dry run"));
    assert.equal(await readFile(registryPath, "utf-8"), legacyRegistry);
    assert.ok(!existsSync(join(tmp, ".agents")));
  });
});
