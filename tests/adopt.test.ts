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
  it("normalizes the registry (dropping stray legacy keys) and installs selected profiles", async () => {
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
          features: {
            "cook-mode": {
              doc: "docs/features/cook-mode.md",
              type: "feature",
              primary_sources: ["app/cook/[recipeId].tsx"],
              related_sources: [],
              docs: [],
              depends_on: [],
              risk: [],
              status: "current",
            },
          },
          // a stray legacy key the normal read path ignores; adopt drops it on write
          mappings: {
            "app/cook/[recipeId].tsx": ["features/cook-mode.md"],
          },
        },
        null,
        2,
      ) + "\n",
    );

    const output = runAdopt("--agents", "codex,claude");

    assert.ok(output.includes("normalized"));
    assert.ok(existsSync(join(tmp, "docs", ".registry.backup.json")));
    assert.ok(existsSync(join(tmp, ".agents", "skills", "work-step", "SKILL.md")));
    assert.ok(existsSync(join(tmp, ".claude", "skills", "review-work", "SKILL.md")));

    const registry = JSON.parse(
      await readFile(join(tmp, "docs", ".registry.json"), "utf-8"),
    );
    assert.deepStrictEqual(registry.features["cook-mode"].primary_sources, [
      "app/cook/[recipeId].tsx",
    ]);
    // the stray legacy mappings key is dropped, not migrated into ownership
    assert.ok(!registry.mappings);

    const meta = JSON.parse(
      await readFile(join(tmp, ".codument-meta.json"), "utf-8"),
    );
    assert.deepStrictEqual(meta.agents, ["codex", "claude"]);
    assert.equal(meta.project.language, "typescript");
    assert.deepStrictEqual(meta.project.sourceGlobs, ["./**/*.ts", "./**/*.tsx", "./**/*.mts", "./**/*.cts"]);

    const settings = JSON.parse(
      await readFile(join(tmp, ".claude", "settings.json"), "utf-8"),
    );
    assert.equal(settings.hooks.PostToolUse[0].matcher, "Write|Edit|MultiEdit");
  });

  it("preserves accumulated meta across adopt", async () => {
    await writeFile(
      join(tmp, ".codument-meta.json"),
      JSON.stringify({
        version: "0.1.0",
        initialized: "2026-04-20",
        project: {
          language: "javascript",
          srcDir: ".",
          sourceGlobs: ["./**/*.js"],
          framework: null,
        },
        fileHashes: { "src/x.ts": "cafef00d" },
        lastScan: { at: "2026-04-21" },
        charter: { seriousness: "serious" },
      }),
    );
    await writeFile(
      join(tmp, "docs", ".registry.json"),
      JSON.stringify({ features: {} }, null, 2) + "\n",
    );

    runAdopt("--agents", "codex");

    const meta = JSON.parse(
      await readFile(join(tmp, ".codument-meta.json"), "utf-8"),
    );
    // adopt refreshes version/agents/project and update augments fileHashes with
    // the managed files it installs, but the pre-existing accumulated fields survive.
    assert.equal(meta.fileHashes["src/x.ts"], "cafef00d", "seeded fileHash preserved");
    assert.deepEqual(meta.lastScan, { at: "2026-04-21" });
    assert.deepEqual(meta.charter, { seriousness: "serious" });
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

describe("adopt carries the project's own metadata forward", () => {
  // adopt used to rebuild the file from a literal, so anything not on its
  // keep-list vanished with no message. A hand-authored exclusion survived
  // exactly until the next `codument adopt` — which is why "just edit the file"
  // was never a workable answer to an unguessable build directory.
  const writeExisting = async (extra: Record<string, unknown>): Promise<void> => {
    await writeFile(
      join(tmp, ".codument-meta.json"),
      JSON.stringify({
        version: "0.8.0",
        initialized: "2026-04-20",
        agents: ["claude"],
        project: { language: "typescript", srcDir: "src" },
        ...extra,
      }),
      "utf-8",
    );
  };

  const readMetaFile = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(join(tmp, ".codument-meta.json"), "utf-8"));

  it("round-trips a declared exclusion block", async () => {
    await writeExisting({ exclude: { dirs: ["out"], globs: ["**/*.gen.ts"] } });
    runAdopt("--agents", "claude");
    assert.deepEqual((await readMetaFile()).exclude, {
      dirs: ["out"],
      globs: ["**/*.gen.ts"],
    });
  });

  // The root fix, not the symptom: the next key added to the metadata must
  // survive adopt without anyone remembering to extend a keep-list.
  it("round-trips a key it has never heard of", async () => {
    await writeExisting({ somethingFuture: { nested: [1, 2, 3] } });
    runAdopt("--agents", "claude");
    assert.deepEqual((await readMetaFile()).somethingFuture, { nested: [1, 2, 3] });
  });

  it("still overwrites the keys adopt owns", async () => {
    const pkgVersion = JSON.parse(
      await readFile(join(__dirname, "..", "package.json"), "utf-8"),
    ).version;
    await writeExisting({ exclude: { dirs: ["out"] } });
    runAdopt("--agents", "claude");
    const meta = await readMetaFile();
    assert.equal(meta.version, pkgVersion, "version is adopt's to set");
    assert.equal(meta.initialized, "2026-04-20", "the original date is preserved");
    assert.deepEqual(meta.agents, ["claude"]);
  });

  it("preserves the same keys through `update`", async () => {
    await writeExisting({ exclude: { dirs: ["out"] }, somethingFuture: 42 });
    execFileSync("node", [CLI, "update", "--agents", "claude"], {
      cwd: tmp,
      encoding: "utf-8",
      timeout: 10000,
    });
    const meta = await readMetaFile();
    assert.deepEqual(meta.exclude, { dirs: ["out"] });
    assert.equal(meta.somethingFuture, 42);
  });
});
