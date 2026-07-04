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

  it("creates default claude agent structure", () => {
    runInit();

    assert.ok(existsSync(join(tmp, ".claude", "skills", "update-docs")));
    assert.ok(existsSync(join(tmp, ".claude", "skills", "grill-with-docs")));
    assert.ok(existsSync(join(tmp, "CLAUDE.md")));
    assert.ok(!existsSync(join(tmp, ".agents")));
  });

  it("copies core delivery skills for the default profile", async () => {
    runInit();

    assert.ok(
      existsSync(join(tmp, ".claude", "skills", "update-docs", "SKILL.md")),
    );
    assert.ok(
      existsSync(join(tmp, ".claude", "skills", "tdd", "SKILL.md")),
    );
    assert.ok(
      existsSync(
        join(tmp, ".claude", "skills", "establish-charter", "SKILL.md"),
      ),
    );
    assert.ok(
      existsSync(join(tmp, ".claude", "skills", "commit-work", "SKILL.md")),
    );
    const commitSkill = await readFile(
      join(tmp, ".claude", "skills", "commit-work", "SKILL.md"),
      "utf-8",
    );
    assert.ok(commitSkill.includes("Compact context before continuing"));
    assert.ok(commitSkill.includes("native context-compaction command"));
  });

  it("installs Claude profile when selected", async () => {
    runInit("--agents", "claude");

    assert.ok(existsSync(join(tmp, ".claude", "rules", "documentation.md")));
    assert.ok(
      existsSync(join(tmp, ".claude", "skills", "update-docs", "SKILL.md")),
    );
    assert.ok(
      existsSync(join(tmp, ".claude", "skills", "grill-with-docs", "SKILL.md")),
    );
    assert.ok(existsSync(join(tmp, ".claude", "agents", "doc-writer.md")));
    const settingsPath = join(tmp, ".claude", "settings.json");
    assert.ok(existsSync(settingsPath));
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    assert.ok(settings.hooks);
    assert.ok(settings.hooks.PostToolUse);
    assert.ok(
      codumentHookEntries(settings).some(
        (h) => h.matcher === "Write|Edit|MultiEdit",
      ),
    );
  });

  it("installs both adversary agent defs on the subagent-capable Claude profile", () => {
    runInit("--agents", "claude");
    // the implementation adversary and its plan-time twin both ship where a host
    // can spawn a fresh, independent subagent
    assert.ok(existsSync(join(tmp, ".claude", "agents", "adversarial-reviewer.md")));
    assert.ok(existsSync(join(tmp, ".claude", "agents", "adversarial-planner.md")));
  });

  it("installs no agent defs on the Codex profile (no subagents to spawn)", () => {
    runInit("--agents", "codex");
    // Codex has no agentsDir; the plan adversary degrades to a manual handoff in
    // the skill prose, never a self-critiquing subagent
    assert.ok(!existsSync(join(tmp, ".claude", "agents")));
    assert.ok(!existsSync(join(tmp, ".agents", "agents")));
  });

  it("updates AGENTS.md with managed section", async () => {
    runInit();

    const agentsMd = join(tmp, "AGENTS.md");
    assert.ok(existsSync(agentsMd));
    const content = await readFile(agentsMd, "utf-8");
    assert.ok(content.includes(MARKER_START));
    assert.ok(content.includes(MARKER_END));
    assert.ok(content.includes("Codument Delivery Workflow"));
    assert.ok(content.includes("Intent routing"));
    assert.ok(content.includes("use `grill-with-docs` first"));
    assert.ok(content.includes("use `plan-with-docs`"));
    assert.ok(content.includes("use `work-step`"));
  });

  it("appends to existing AGENTS.md", async () => {
    await writeFile(join(tmp, "AGENTS.md"), "# My Project\n\nExisting content.\n");
    runInit();

    const content = await readFile(join(tmp, "AGENTS.md"), "utf-8");
    assert.ok(content.startsWith("# My Project"));
    assert.ok(content.includes("Existing content."));
    assert.ok(content.includes(MARKER_START));
  });

  it("creates .codument-meta.json", async () => {
    runInit();

    const metaPath = join(tmp, ".codument-meta.json");
    assert.ok(existsSync(metaPath));
    const meta = JSON.parse(await readFile(metaPath, "utf-8"));
    assert.equal(meta.version, PKG_VERSION);
    assert.ok(meta.initialized);
    assert.deepStrictEqual(meta.agents, ["claude"]);
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

  it("does not reset a populated registry under --force", async () => {
    runInit();

    // Populate the registry with human-authored ownership.
    const regPath = join(tmp, "docs", ".registry.json");
    await writeFile(regPath, JSON.stringify({ features: { x: {} } }));

    runInit("--force");

    // --force overwrites codument-managed scaffolds, never the registry's
    // human-authored content. Re-scaffolding requires deleting the file.
    const reg = JSON.parse(await readFile(regPath, "utf-8"));
    assert.ok(reg.features.x, "populated registry preserved under --force");
  });

  it("preserves non-codument settings keys under --force", async () => {
    await mkdir(join(tmp, ".claude"), { recursive: true });
    await writeFile(
      join(tmp, ".claude", "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Bash(ls:*)"] },
        env: { FOO: "bar" },
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] },
          ],
        },
      }),
    );

    runInit("--force", "--agents", "claude");

    const settings = JSON.parse(
      await readFile(join(tmp, ".claude", "settings.json"), "utf-8"),
    );
    // --force must not discard the user's permissions, env, or other hooks.
    assert.deepEqual(settings.permissions, { allow: ["Bash(ls:*)"] });
    assert.deepEqual(settings.env, { FOO: "bar" });
    assert.ok(settings.hooks.PreToolUse?.length > 0, "foreign hook preserved");
    assert.ok(codumentHookEntries(settings).length > 0, "codument hook upserted");
  });

  it("preserves accumulated meta (fileHashes, lastScan) on re-init", async () => {
    runInit("--agents", "claude");
    const metaPath = join(tmp, ".codument-meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf-8"));
    meta.fileHashes = { "src/x.ts": "deadbeef" };
    meta.lastScan = { at: "2026-01-01" };
    await writeFile(metaPath, JSON.stringify(meta, null, 2));

    runInit("--agents", "claude");

    const after = JSON.parse(await readFile(metaPath, "utf-8"));
    assert.deepEqual(after.fileHashes, { "src/x.ts": "deadbeef" });
    assert.deepEqual(after.lastScan, { at: "2026-01-01" });
  });

  it("refuses a corrupt settings.json rather than overwriting it", async () => {
    await mkdir(join(tmp, ".claude"), { recursive: true });
    const settingsPath = join(tmp, ".claude", "settings.json");
    const corrupt = '{ "permissions": { "allow": ["Bash"] }, }'; // trailing comma
    await writeFile(settingsPath, corrupt);

    let status = 0;
    let output = "";
    try {
      runInit("--force", "--agents", "claude");
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      status = err.status ?? 1;
      output = err.stdout ?? "";
    }
    assert.equal(status, 1, "init exits non-zero on a corrupt settings file");
    assert.match(output, /unreadable/);
    // The user's file is left exactly as it was — never rewritten to just the hook.
    assert.equal(await readFile(settingsPath, "utf-8"), corrupt);
  });

  it("refuses a corrupt .codument-meta.json rather than dropping its fields", async () => {
    runInit("--agents", "claude");
    const metaPath = join(tmp, ".codument-meta.json");
    const corrupt = '{ "fileHashes": { "src/x.ts": "abc" }, }'; // trailing comma
    await writeFile(metaPath, corrupt);

    let status = 0;
    let output = "";
    try {
      runInit("--agents", "claude");
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      status = err.status ?? 1;
      output = err.stdout ?? "";
    }
    assert.equal(status, 1, "init exits non-zero on corrupt project metadata");
    assert.match(output, /unreadable/);
    assert.equal(await readFile(metaPath, "utf-8"), corrupt);
  });

  it("preserves existing settings.json entries", async () => {
    // Pre-create settings with custom data
    await mkdir(join(tmp, ".claude"), { recursive: true });
    await writeFile(
      join(tmp, ".claude", "settings.json"),
      JSON.stringify({ customKey: "value", hooks: {} }),
    );

    runInit("--agents", "claude");

    const settings = JSON.parse(
      await readFile(join(tmp, ".claude", "settings.json"), "utf-8"),
    );
    assert.equal(settings.customKey, "value");
    assert.ok(settings.hooks.PostToolUse.length > 0);
  });

  it("does not duplicate hook on re-init", async () => {
    runInit("--agents", "claude");
    runInit("--agents", "claude");

    const settings = JSON.parse(
      await readFile(join(tmp, ".claude", "settings.json"), "utf-8"),
    );
    const hooks = codumentHookEntries(settings);
    assert.equal(hooks.length, 1, "hook should not be duplicated");
  });

  it("updates an existing Claude hook matcher on init", async () => {
    await mkdir(join(tmp, ".claude"), { recursive: true });
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
      ),
    );

    runInit("--agents", "claude");

    const settings = JSON.parse(
      await readFile(join(tmp, ".claude", "settings.json"), "utf-8"),
    );
    const hooks = codumentHookEntries(settings);
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0].matcher, "Write|Edit|MultiEdit");
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

  it("emits exactly one domain-skill consult nudge into both instruction files", async () => {
    runInit("--agents", "codex,claude");

    const agentsMd = await readFile(join(tmp, "AGENTS.md"), "utf-8");
    const claudeMd = await readFile(join(tmp, "CLAUDE.md"), "utf-8");
    const needle = "Domain skills are advisory";
    assert.equal(agentsMd.split(needle).length - 1, 1);
    assert.equal(claudeMd.split(needle).length - 1, 1);
    assert.ok(agentsMd.includes("`senior-backend`"));
  });

  it("installs domain skills with their reference files", () => {
    runInit();

    // a Bucket-A domain skill installs as a single SKILL.md
    assert.ok(
      existsSync(join(tmp, ".claude", "skills", "senior-backend", "SKILL.md")),
    );
    // a Bucket-B skill installs SKILL.md AND its references/ (recursive copy)
    assert.ok(
      existsSync(join(tmp, ".claude", "skills", "motion-craft", "SKILL.md")),
    );
    assert.ok(
      existsSync(
        join(tmp, ".claude", "skills", "motion-craft", "references", "web.md"),
      ),
    );
    assert.ok(
      existsSync(
        join(
          tmp,
          ".claude",
          "skills",
          "senior-frontend",
          "references",
          "react-native.md",
        ),
      ),
    );
  });

  it("installs multiple selected profiles", async () => {
    runInit("--agents", "codex,claude");

    assert.ok(
      existsSync(join(tmp, ".agents", "skills", "work-step", "SKILL.md")),
    );
    assert.ok(
      existsSync(join(tmp, ".claude", "skills", "work-step", "SKILL.md")),
    );
    assert.ok(existsSync(join(tmp, "AGENTS.md")));
    assert.ok(existsSync(join(tmp, "CLAUDE.md")));

    const meta = JSON.parse(
      await readFile(join(tmp, ".codument-meta.json"), "utf-8"),
    );
    assert.deepStrictEqual(meta.agents, ["codex", "claude"]);
  });
});
