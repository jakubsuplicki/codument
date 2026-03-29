import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { writeRegistry, readRegistry } from "../src/lib/registry.js";

// We test scan() through its exported function, which accepts options.root
import { scan } from "../src/commands/scan.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-test-"));
  process.exitCode = undefined;
});

afterEach(async () => {
  process.exitCode = undefined;
  await rm(tmp, { recursive: true, force: true });
});

async function setupProject(
  files: Record<string, string>,
  registry = true,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(tmp, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }
  if (registry) {
    const regPath = join(tmp, "docs", ".registry.json");
    await mkdir(join(regPath, ".."), { recursive: true });
    await writeRegistry(regPath, { features: {} });
  }
}

describe("scan command", () => {
  it("exits with error when registry does not exist", async () => {
    await mkdir(join(tmp, "src"), { recursive: true });

    await scan({ root: tmp });
    assert.equal(process.exitCode, 1);
    process.exitCode = undefined;
  });

  it("scans source files and creates scaffold docs", async () => {
    await setupProject({
      "src/commands/init.ts": "export function init() {}",
      "src/commands/scan.ts": "export function scan() {}",
      "src/lib/registry.ts": "export function read() {}",
    });

    await scan({ root: tmp });

    // Should have created docs for commands and lib
    const reg = await readRegistry(join(tmp, "docs", ".registry.json"));
    assert.ok(reg.features.commands, "should have 'commands' feature");
    assert.ok(reg.features.lib, "should have 'lib' feature");

    // commands is a feature, lib is a concept
    assert.equal(reg.features.commands.type, "feature");
    assert.equal(reg.features.lib.type, "concept");

    // Doc files should exist
    assert.ok(existsSync(join(tmp, reg.features.commands.doc)));
    assert.ok(existsSync(join(tmp, reg.features.lib.doc)));
  });

  it("creates scaffold docs with correct frontmatter", async () => {
    await setupProject({
      "src/auth/login.ts": "export function login() {}",
    });

    await scan({ root: tmp });

    const docPath = join(tmp, "docs", "features", "auth.md");
    assert.ok(existsSync(docPath));
    const content = await readFile(docPath, "utf-8");

    assert.ok(content.includes("title: auth"));
    assert.ok(content.includes("type: feature"));
    assert.ok(content.includes("src/auth/login.ts"));
    assert.ok(content.includes("## Summary"));
    assert.ok(content.includes("## How it works"));
    assert.ok(content.includes("## Key files"));
  });

  it("classifies concept directories correctly", async () => {
    await setupProject({
      "src/utils/helpers.ts": "export const x = 1;",
      "src/helpers/format.ts": "export const f = 1;",
      "src/types/index.ts": "export type X = string;",
      "src/shared/constants.ts": "export const C = 1;",
      "src/common/base.ts": "export class B {}",
    });

    await scan({ root: tmp });
    const reg = await readRegistry(join(tmp, "docs", ".registry.json"));

    for (const name of ["utils", "helpers", "types", "shared", "common"]) {
      assert.ok(reg.features[name], `should have '${name}'`);
      assert.equal(reg.features[name].type, "concept", `${name} should be concept`);
    }
  });

  it("skips already-documented features", async () => {
    // Pre-create a doc and registry entry
    await setupProject({
      "src/auth/login.ts": "export function login() {}",
    });
    const regPath = join(tmp, "docs", ".registry.json");
    const docPath = join(tmp, "docs", "features", "auth.md");
    await mkdir(join(docPath, ".."), { recursive: true });
    await writeFile(docPath, "# Auth\nExisting doc");
    await writeRegistry(regPath, {
      features: {
        auth: {
          doc: "docs/features/auth.md",
          type: "feature",
          sources: ["src/auth/login.ts"],
          depends_on: [],
          last_updated: "2025-01-01",
          status: "current",
        },
      },
    });

    await scan({ root: tmp });

    // Doc should be unchanged
    const content = await readFile(docPath, "utf-8");
    assert.equal(content, "# Auth\nExisting doc");
  });

  it("skips root-level index files", async () => {
    await setupProject({
      "src/index.ts": "export * from './lib';",
    });

    await scan({ root: tmp });
    const reg = await readRegistry(join(tmp, "docs", ".registry.json"));

    // _root group is skipped, so no features created
    assert.deepStrictEqual(Object.keys(reg.features), []);
  });

  it("ignores node_modules, dist, .git, .claude directories", async () => {
    await setupProject({
      "src/app.ts": "export const app = 1;",
      "src/node_modules/dep/index.ts": "export default 1;",
    });
    // These dirs shouldn't be scanned but the file structure creates them
    await mkdir(join(tmp, "src", "dist"), { recursive: true });
    await writeFile(join(tmp, "src", "dist", "bundle.js"), "");
    await mkdir(join(tmp, "src", ".git"), { recursive: true });
    await writeFile(join(tmp, "src", ".git", "hooks.js"), "");

    await scan({ root: tmp });
    const reg = await readRegistry(join(tmp, "docs", ".registry.json"));

    // Should only have 'app' from the single root-level file
    // Actually app is a single file in src root → name "app" (not "index" so not _root)
    // but it's a single file in srcParts.length === 1, groupName = "app"
    assert.ok(!reg.features["node_modules"]);
    assert.ok(!reg.features["dist"]);
    assert.ok(!reg.features[".git"]);
  });

  it("excludes .d.ts files", async () => {
    await setupProject({
      "src/types/index.d.ts": "declare module 'x' {}",
      "src/types/helpers.ts": "export type X = string;",
    });

    await scan({ root: tmp });
    const reg = await readRegistry(join(tmp, "docs", ".registry.json"));

    // types should exist but only with helpers.ts
    if (reg.features.types) {
      const sources = reg.features.types.sources;
      assert.ok(!sources.some((s: string) => s.endsWith(".d.ts")));
    }
  });

  it("updates .codument-meta.json with scan results", async () => {
    await setupProject({
      "src/commands/run.ts": "export function run() {}",
      "src/lib/utils.ts": "export const u = 1;",
    });

    await scan({ root: tmp });

    const metaPath = join(tmp, ".codument-meta.json");
    assert.ok(existsSync(metaPath));
    const meta = JSON.parse(await readFile(metaPath, "utf-8"));
    assert.ok(meta.lastScan);
    assert.equal(meta.lastScan.featuresFound, 2);
    assert.equal(meta.lastScan.docsCreated, 2);
  });

  it("handles project without src/ directory", async () => {
    // No src dir — uses root
    const regPath = join(tmp, "docs", ".registry.json");
    await mkdir(join(regPath, ".."), { recursive: true });
    await writeRegistry(regPath, { features: {} });
    await mkdir(join(tmp, "api"), { recursive: true });
    await writeFile(join(tmp, "api", "routes.ts"), "export const r = 1;");

    await scan({ root: tmp });
    const reg = await readRegistry(join(tmp, "docs", ".registry.json"));
    assert.ok(reg.features.api);
  });

  it("sets status to needs-review on new entries", async () => {
    await setupProject({
      "src/auth/login.ts": "export function login() {}",
    });

    await scan({ root: tmp });
    const reg = await readRegistry(join(tmp, "docs", ".registry.json"));
    assert.equal(reg.features.auth.status, "needs-review");
  });
});
