import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hashContent } from "../src/lib/codemod.js";
import { MARKER_START, MARKER_END } from "../src/lib/markers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "dist", "cli.js");

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-test-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function runCli(...args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [CLI, ...args], {
      cwd: tmp,
      encoding: "utf-8",
      timeout: 10000,
    });
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", exitCode: e.status ?? 1 };
  }
}

/** Run init first to set up a fully initialized project */
async function setupInitializedProject(): Promise<void> {
  await writeFile(
    join(tmp, "package.json"),
    JSON.stringify({ name: "test-project", dependencies: {} }),
  );
  await writeFile(join(tmp, "tsconfig.json"), "{}");
  await mkdir(join(tmp, "src"));

  runCli("init");
}

describe("update command", () => {
  it("fails without .codument-meta.json", () => {
    const result = runCli("update");
    assert.equal(result.exitCode, 1);
    assert.ok(result.stdout.includes("codument-meta.json"));
  });

  it("skips files when nothing changed", async () => {
    await setupInitializedProject();
    const result = runCli("update");

    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("skipped"));
  });

  it("--dry-run does not modify files", async () => {
    await setupInitializedProject();

    // Delete a managed file to trigger "create" action
    const rulesPath = join(tmp, ".claude", "rules", "documentation.md");
    const existed = existsSync(rulesPath);
    assert.ok(existed);
    unlinkSync(rulesPath);

    const result = runCli("update", "--dry-run");
    assert.ok(result.stdout.includes("dry run"));

    // File should still be missing (dry run)
    assert.ok(!existsSync(rulesPath));

    // Meta version should not be updated
    const meta = JSON.parse(
      await readFile(join(tmp, ".codument-meta.json"), "utf-8"),
    );
    assert.equal(meta.version, "0.1.0");
  });

  it("creates missing managed files", async () => {
    await setupInitializedProject();

    const agentPath = join(tmp, ".claude", "agents", "doc-writer.md");
    assert.ok(existsSync(agentPath));
    unlinkSync(agentPath);

    runCli("update");

    // File should be recreated
    assert.ok(existsSync(agentPath));
    const content = await readFile(agentPath, "utf-8");
    assert.ok(content.length > 0);
  });

  it("creates missing CLAUDE.md", async () => {
    await setupInitializedProject();
    unlinkSync(join(tmp, "CLAUDE.md"));

    runCli("update");

    assert.ok(existsSync(join(tmp, "CLAUDE.md")));
    const content = await readFile(join(tmp, "CLAUDE.md"), "utf-8");
    assert.ok(content.includes(MARKER_START));
    assert.ok(content.includes("Documentation Maintenance"));
  });

  it("creates missing .claude/settings.json", async () => {
    await setupInitializedProject();
    unlinkSync(join(tmp, ".claude", "settings.json"));

    runCli("update");

    const settingsPath = join(tmp, ".claude", "settings.json");
    assert.ok(existsSync(settingsPath));
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    assert.ok(
      settings.hooks.PostToolUse.some(
        (h: { command: string }) => h.command.includes("check-docs"),
      ),
    );
  });

  it("adds missing hook to existing settings.json", async () => {
    await setupInitializedProject();

    // Replace settings with one that lacks the hook
    await writeFile(
      join(tmp, ".claude", "settings.json"),
      JSON.stringify({ hooks: {} }, null, 2) + "\n",
    );

    runCli("update");

    const settings = JSON.parse(
      await readFile(join(tmp, ".claude", "settings.json"), "utf-8"),
    );
    assert.equal(settings.hooks.PostToolUse.length, 1);
    assert.ok(settings.hooks.PostToolUse[0].command.includes("check-docs"));
  });

  it("updates meta version after update", async () => {
    await setupInitializedProject();

    // Set old version in meta
    const metaPath = join(tmp, ".codument-meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf-8"));
    meta.version = "0.0.1";
    await writeFile(metaPath, JSON.stringify(meta, null, 2) + "\n");

    runCli("update");

    const updatedMeta = JSON.parse(await readFile(metaPath, "utf-8"));
    assert.notEqual(updatedMeta.version, "0.0.1");
  });

  it("dry run reports what would happen without modifying", async () => {
    await setupInitializedProject();

    // Delete multiple files
    unlinkSync(join(tmp, ".claude", "agents", "doc-writer.md"));
    unlinkSync(join(tmp, ".claude", "agents", "doc-scanner.md"));

    const result = runCli("update", "--dry-run");
    assert.ok(result.stdout.includes("dry run"));
    assert.ok(result.stdout.includes("doc-writer.md"));
    assert.ok(result.stdout.includes("doc-scanner.md"));

    // Files should still be missing
    assert.ok(!existsSync(join(tmp, ".claude", "agents", "doc-writer.md")));
    assert.ok(!existsSync(join(tmp, ".claude", "agents", "doc-scanner.md")));
  });

  it("preserves user-modified files when upstream unchanged", async () => {
    await setupInitializedProject();

    // First update records file hashes in meta
    runCli("update");

    // Now simulate: user modifies a file, but upstream hasn't changed
    const rulesPath = join(tmp, ".claude", "rules", "documentation.md");
    await writeFile(rulesPath, "# My custom docs rule\nUser modifications here.");

    // Second update should skip (only local modifications, upstream unchanged)
    runCli("update");

    // File should be preserved (user changed, upstream didn't)
    const content = await readFile(rulesPath, "utf-8");
    assert.ok(content.includes("User modifications here."));
  });
});
