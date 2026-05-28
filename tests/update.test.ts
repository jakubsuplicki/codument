import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MARKER_START, MARKER_END } from "../src/lib/markers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "dist", "cli.js");
const PKG_VERSION = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
).version;

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

function codumentHookEntries(settings: {
  hooks?: { PostToolUse?: Array<Record<string, unknown>> };
}): Array<Record<string, unknown>> {
  return (settings.hooks?.PostToolUse ?? []).filter(hasCodumentHook);
}

function hasCodumentHook(entry: Record<string, unknown>): boolean {
  if (
    typeof entry.command === "string" &&
    entry.command.includes("check-docs")
  ) {
    return true;
  }
  return Array.isArray(entry.hooks) && entry.hooks.some((hook) => {
    return (
      typeof hook === "object" &&
      hook !== null &&
      "command" in hook &&
      typeof hook.command === "string" &&
      hook.command.includes("check-docs")
    );
  });
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
    const skillPath = join(tmp, ".agents", "skills", "tdd", "SKILL.md");
    const existed = existsSync(skillPath);
    assert.ok(existed);
    unlinkSync(skillPath);

    const result = runCli("update", "--dry-run");
    assert.ok(result.stdout.includes("dry run"));

    // File should still be missing (dry run)
    assert.ok(!existsSync(skillPath));

    // Meta version should not be updated
    const meta = JSON.parse(
      await readFile(join(tmp, ".codument-meta.json"), "utf-8"),
    );
    assert.equal(meta.version, PKG_VERSION);
  });

  it("creates missing managed files", async () => {
    await setupInitializedProject();

    const skillPath = join(tmp, ".agents", "skills", "work-step", "SKILL.md");
    assert.ok(existsSync(skillPath));
    unlinkSync(skillPath);

    runCli("update");

    // File should be recreated
    assert.ok(existsSync(skillPath));
    const content = await readFile(skillPath, "utf-8");
    assert.ok(content.length > 0);
  });

  it("creates missing AGENTS.md", async () => {
    await setupInitializedProject();
    unlinkSync(join(tmp, "AGENTS.md"));

    runCli("update");

    assert.ok(existsSync(join(tmp, "AGENTS.md")));
    const content = await readFile(join(tmp, "AGENTS.md"), "utf-8");
    assert.ok(content.includes(MARKER_START));
    assert.ok(content.includes("Codument Delivery Workflow"));
    assert.ok(content.includes("Intent routing"));
    assert.ok(content.includes("use `grill-with-docs` first"));
    assert.ok(content.includes("use `review-work` before any commit"));
  });

  it("creates missing Claude settings when Claude profile is stored", async () => {
    await setupInitializedProject();
    runCli("update", "--agents", "claude");
    unlinkSync(join(tmp, ".claude", "settings.json"));

    runCli("update");

    const settingsPath = join(tmp, ".claude", "settings.json");
    assert.ok(existsSync(settingsPath));
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    assert.ok(
      codumentHookEntries(settings).some(
        (h) => h.matcher === "Write|Edit|MultiEdit",
      ),
    );
  });

  it("adds missing hook to existing Claude settings", async () => {
    await setupInitializedProject();
    runCli("update", "--agents", "claude");

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
    assert.ok(hasCodumentHook(settings.hooks.PostToolUse[0]));
    assert.equal(settings.hooks.PostToolUse[0].matcher, "Write|Edit|MultiEdit");
  });

  it("updates an existing Claude hook matcher", async () => {
    await setupInitializedProject();
    runCli("update", "--agents", "claude");

    await writeFile(
      join(tmp, ".claude", "settings.json"),
      JSON.stringify(
        {
          hooks: {
            PostToolUse: [
              {
                matcher: "Write|Edit",
                command: "node node_modules/codument/dist/hooks/check-docs.js",
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
    );

    runCli("update");

    const settings = JSON.parse(
      await readFile(join(tmp, ".claude", "settings.json"), "utf-8"),
    );
    assert.equal(settings.hooks.PostToolUse.length, 1);
    assert.equal(settings.hooks.PostToolUse[0].matcher, "Write|Edit|MultiEdit");
  });

  it("updates an existing nested Claude hook matcher without duplication", async () => {
    await setupInitializedProject();
    runCli("update", "--agents", "claude");

    await writeFile(
      join(tmp, ".claude", "settings.json"),
      JSON.stringify(
        {
          hooks: {
            PostToolUse: [
              {
                matcher: "Write|Edit",
                hooks: [
                  {
                    type: "command",
                    command: "node node_modules/codument/dist/hooks/check-docs.js",
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
    );

    runCli("update");

    const settings = JSON.parse(
      await readFile(join(tmp, ".claude", "settings.json"), "utf-8"),
    );
    const hooks = codumentHookEntries(settings);
    assert.equal(settings.hooks.PostToolUse.length, 1);
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].matcher, "Write|Edit|MultiEdit");
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
    unlinkSync(join(tmp, ".agents", "skills", "review-work", "SKILL.md"));
    unlinkSync(join(tmp, ".agents", "skills", "commit-work", "SKILL.md"));

    const result = runCli("update", "--dry-run");
    assert.ok(result.stdout.includes("dry run"));
    assert.ok(result.stdout.includes("review-work"));
    assert.ok(result.stdout.includes("commit-work"));

    // Files should still be missing
    assert.ok(!existsSync(join(tmp, ".agents", "skills", "review-work", "SKILL.md")));
    assert.ok(!existsSync(join(tmp, ".agents", "skills", "commit-work", "SKILL.md")));
  });

  it("preserves user-modified files when upstream unchanged", async () => {
    await setupInitializedProject();

    // First update records file hashes in meta
    runCli("update");

    // Now simulate: user modifies a file, but upstream hasn't changed
    const skillPath = join(tmp, ".agents", "skills", "tdd", "SKILL.md");
    await writeFile(skillPath, "# My custom tdd skill\nUser modifications here.");

    // Second update should skip (only local modifications, upstream unchanged)
    runCli("update");

    // File should be preserved (user changed, upstream didn't)
    const content = await readFile(skillPath, "utf-8");
    assert.ok(content.includes("User modifications here."));
  });

  it("uses stored agent profiles on update", async () => {
    await setupInitializedProject();
    runCli("update", "--agents", "codex,claude");

    const meta = JSON.parse(
      await readFile(join(tmp, ".codument-meta.json"), "utf-8"),
    );
    assert.deepStrictEqual(meta.agents, ["codex", "claude"]);

    unlinkSync(join(tmp, ".claude", "agents", "doc-writer.md"));
    runCli("update");

    assert.ok(existsSync(join(tmp, ".claude", "agents", "doc-writer.md")));
  });
});
