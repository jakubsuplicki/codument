import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MARKER_START, MARKER_END } from "../src/lib/markers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "dist", "cli.js");

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-test-"));
  // Create minimal project structure
  await writeFile(
    join(tmp, "package.json"),
    JSON.stringify({ name: "test-project", dependencies: {} }),
  );
  await writeFile(join(tmp, "tsconfig.json"), "{}");
  await mkdir(join(tmp, "src"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function runInit(...args: string[]): string {
  return execFileSync("node", [CLI, "init", ...args], {
    cwd: tmp,
    encoding: "utf-8",
    timeout: 10000,
  });
}

describe("init command", () => {
  it("creates docs directory structure", () => {
    runInit();

    assert.ok(existsSync(join(tmp, "docs")));
    assert.ok(existsSync(join(tmp, "docs", "features")));
    assert.ok(existsSync(join(tmp, "docs", "concepts")));
    assert.ok(existsSync(join(tmp, "docs", "architecture", "decisions")));
    assert.ok(existsSync(join(tmp, "docs", "guides")));
  });

  it("creates docs/.registry.json", async () => {
    runInit();

    const regPath = join(tmp, "docs", ".registry.json");
    assert.ok(existsSync(regPath));
    const reg = JSON.parse(await readFile(regPath, "utf-8"));
    assert.deepStrictEqual(reg, { features: {} });
  });

  it("copies doc templates", () => {
    runInit();

    assert.ok(existsSync(join(tmp, "docs", "overview.md")));
    assert.ok(existsSync(join(tmp, "docs", "getting-started.md")));
  });

  it("creates .claude directory structure", () => {
    runInit();

    assert.ok(existsSync(join(tmp, ".claude", "rules")));
    assert.ok(existsSync(join(tmp, ".claude", "skills", "update-docs")));
    assert.ok(existsSync(join(tmp, ".claude", "agents")));
  });

  it("copies rules, skills, and agents", () => {
    runInit();

    assert.ok(existsSync(join(tmp, ".claude", "rules", "documentation.md")));
    assert.ok(
      existsSync(join(tmp, ".claude", "skills", "update-docs", "SKILL.md")),
    );
    assert.ok(existsSync(join(tmp, ".claude", "agents", "doc-writer.md")));
    assert.ok(existsSync(join(tmp, ".claude", "agents", "doc-scanner.md")));
  });

  it("creates .claude/settings.json with hook", async () => {
    runInit();

    const settingsPath = join(tmp, ".claude", "settings.json");
    assert.ok(existsSync(settingsPath));
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    assert.ok(settings.hooks);
    assert.ok(settings.hooks.PostToolUse);
    assert.ok(
      settings.hooks.PostToolUse.some(
        (h: { command: string; matcher: string }) =>
          h.command.includes("check-docs") && h.matcher === "Write|Edit",
      ),
    );
  });

  it("updates CLAUDE.md with managed section", async () => {
    runInit();

    const claudeMd = join(tmp, "CLAUDE.md");
    assert.ok(existsSync(claudeMd));
    const content = await readFile(claudeMd, "utf-8");
    assert.ok(content.includes(MARKER_START));
    assert.ok(content.includes(MARKER_END));
    assert.ok(content.includes("Documentation Maintenance"));
  });

  it("appends to existing CLAUDE.md", async () => {
    await writeFile(join(tmp, "CLAUDE.md"), "# My Project\n\nExisting content.\n");
    runInit();

    const content = await readFile(join(tmp, "CLAUDE.md"), "utf-8");
    assert.ok(content.startsWith("# My Project"));
    assert.ok(content.includes("Existing content."));
    assert.ok(content.includes(MARKER_START));
  });

  it("creates .codument-meta.json", async () => {
    runInit();

    const metaPath = join(tmp, ".codument-meta.json");
    assert.ok(existsSync(metaPath));
    const meta = JSON.parse(await readFile(metaPath, "utf-8"));
    assert.equal(meta.version, "0.1.0");
    assert.ok(meta.initialized);
    assert.ok(meta.project);
    assert.equal(meta.project.language, "typescript");
  });

  it("does not overwrite existing registry without --force", async () => {
    runInit();

    // Modify registry
    const regPath = join(tmp, "docs", ".registry.json");
    await writeFile(regPath, JSON.stringify({ features: { x: {} } }));

    runInit();

    // Should not have been overwritten
    const reg = JSON.parse(await readFile(regPath, "utf-8"));
    assert.ok(reg.features.x);
  });

  it("overwrites files with --force", async () => {
    runInit();

    // Modify registry
    const regPath = join(tmp, "docs", ".registry.json");
    await writeFile(regPath, JSON.stringify({ features: { x: {} } }));

    runInit("--force");

    const reg = JSON.parse(await readFile(regPath, "utf-8"));
    assert.deepStrictEqual(reg, { features: {} });
  });

  it("preserves existing settings.json entries", async () => {
    // Pre-create settings with custom data
    await mkdir(join(tmp, ".claude"), { recursive: true });
    await writeFile(
      join(tmp, ".claude", "settings.json"),
      JSON.stringify({ customKey: "value", hooks: {} }),
    );

    runInit();

    const settings = JSON.parse(
      await readFile(join(tmp, ".claude", "settings.json"), "utf-8"),
    );
    assert.equal(settings.customKey, "value");
    assert.ok(settings.hooks.PostToolUse.length > 0);
  });

  it("does not duplicate hook on re-init", async () => {
    runInit();
    runInit();

    const settings = JSON.parse(
      await readFile(join(tmp, ".claude", "settings.json"), "utf-8"),
    );
    const hooks = settings.hooks.PostToolUse.filter(
      (h: { command: string }) => h.command.includes("check-docs"),
    );
    assert.equal(hooks.length, 1, "hook should not be duplicated");
  });

  it("detects javascript project", async () => {
    // Remove tsconfig
    unlinkSync(join(tmp, "tsconfig.json"));

    runInit();

    const meta = JSON.parse(
      await readFile(join(tmp, ".codument-meta.json"), "utf-8"),
    );
    assert.equal(meta.project.language, "javascript");
  });

  it("detects framework from package.json", async () => {
    await writeFile(
      join(tmp, "package.json"),
      JSON.stringify({ name: "test", dependencies: { express: "^4.0.0" } }),
    );

    runInit();

    const meta = JSON.parse(
      await readFile(join(tmp, ".codument-meta.json"), "utf-8"),
    );
    assert.equal(meta.project.framework, "express");
  });
});
