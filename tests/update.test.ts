import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, unlinkSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MARKER_START, MARKER_END } from "../src/lib/markers.js";
import { buildManagedSection, nonDirectoryAncestor } from "../src/lib/scaffold.js";
import { hashContent } from "../src/lib/codemod.js";
import { approvePlan } from "../src/lib/plan-approval.js";
import { loadPlan, planApprovalModel } from "../src/lib/plan-steps.js";

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
async function setupInitializedProject(profile = "codex"): Promise<void> {
  await writeFile(
    join(tmp, "package.json"),
    JSON.stringify({ name: "test-project", dependencies: {} }),
  );
  await writeFile(join(tmp, "tsconfig.json"), "{}");
  await mkdir(join(tmp, "src"));

  // Anchor to the codex profile explicitly: these tests exercise the
  // `.agents/skills` managed-file layout (and Claude settings added on top via
  // `update --agents claude`), independent of which profile `init` defaults to.
  runCli("init", "--agents", profile);
}

describe("update command", () => {
  for (const [profile, skillsRoot] of [["codex", ".agents"], ["claude", ".claude"]]) {
    it(`upgrades ${profile} milestone guidance while retaining authored content and legacy permission`, async () => {
      await setupInitializedProject(profile);
      const before = "# Authored project rules\n\n";
      const after = "\n\n## Authored operational rules\n";
      const instructionFiles = profile === "claude" ? ["AGENTS.md", "CLAUDE.md"] : ["AGENTS.md"];
      for (const file of instructionFiles) {
        await writeFile(join(tmp, file), `${before}${MARKER_START}\nPrior managed workflow.\n${MARKER_END}${after}`);
      }
      const names = ["plan-with-docs", "work-step", "review-work", "commit-work", "grill-with-docs", "tdd"];
      const metaPath = join(tmp, ".codument-meta.json");
      const meta = JSON.parse(await readFile(metaPath, "utf8"));
      meta.fileHashes ??= {};
      let authoredSkill = "";
      for (const name of names) {
        const path = `${skillsRoot}/skills/${name}/SKILL.md`;
        const previous = `# Previous packaged ${name} guidance\n`;
        meta.fileHashes[path] = hashContent(previous);
        const local = name === "tdd" ? previous + "\nProject-authored local extension.\n" : previous;
        await writeFile(join(tmp, path), local);
        if (name === "tdd") authoredSkill = local;
      }
      await writeFile(metaPath, JSON.stringify(meta));
      const planPath = "docs/features/existing.md";
      await writeFile(join(tmp, planPath), "# Existing work\n\n## Delivery Plan\nStatus: approved\n\n- [ ] Preserve the existing report format.\n\n### Scope\n- `src/report.ts`\n");
      approvePlan(tmp, planPath, { signer: "human" });
      const authoredPlan = await readFile(join(tmp, planPath), "utf8");
      const approval = await readFile(join(tmp, "docs/.approvals.json"), "utf8");

      const result = runCli("update");

      assert.equal(result.exitCode, 0, result.stdout);
      for (const file of instructionFiles) {
        const installed = await readFile(join(tmp, file), "utf8");
        assert.ok(installed.startsWith(before));
        assert.ok(installed.endsWith(after));
        assert.ok(installed.includes(`${buildManagedSection()}\n${MARKER_END}`));
        assert.ok(!installed.includes("Prior managed workflow."));
      }
      for (const name of names) {
        assert.equal(
          await readFile(join(tmp, skillsRoot, "skills", name, "SKILL.md"), "utf8"),
          await readFile(join(__dirname, "..", "skills", name, "SKILL.md"), "utf8"),
          `${profile} must receive the shipped ${name} contract`,
        );
      }
      assert.equal(await readFile(join(tmp, skillsRoot, "skills/tdd/SKILL.md.backup"), "utf8"), authoredSkill);
      assert.equal(await readFile(join(tmp, planPath), "utf8"), authoredPlan);
      assert.equal(await readFile(join(tmp, "docs/.approvals.json"), "utf8"), approval);
      assert.equal(planApprovalModel(authoredPlan), "legacy");
      assert.equal(loadPlan(tmp, planPath)?.approved, true);
      await writeFile(join(tmp, planPath), authoredPlan.replace("src/report.ts", "src/discovered.ts"));
      assert.equal(loadPlan(tmp, planPath)?.approved, false, "upgrades must retain legacy file-bound permission");
    });
  }

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
    assert.ok(content.includes("gets reviewed before commit"));
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

  it("refuses a corrupt Claude settings.json rather than rewriting it to just the hook", async () => {
    await setupInitializedProject();
    runCli("update", "--agents", "claude");

    const settingsPath = join(tmp, ".claude", "settings.json");
    const corrupt = '{ "permissions": { "allow": ["Bash"] }, }'; // trailing comma
    await writeFile(settingsPath, corrupt);

    const result = runCli("update");

    assert.equal(result.exitCode, 1, "update exits nonzero on corrupt settings");
    assert.match(result.stdout, /unreadable/);
    // The user's permissions survive — never rewritten down to just the hook.
    assert.equal(await readFile(settingsPath, "utf-8"), corrupt);
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

  it("skips a pointer-file skill instead of crashing the whole run (ENOTDIR)", async () => {
    await setupInitializedProject();

    // Mimic a shared-skill setup: replace a skill DIRECTORY with a pointer FILE
    // (a symlink checked out as text), exactly what crashed `update` in the wild.
    const skillDir = join(tmp, ".agents", "skills", "work-step");
    await rm(skillDir, { recursive: true, force: true });
    await writeFile(skillDir, "../../.claude/skills/work-step");

    // Delete another, real-dir skill so the run still has work to do after the blocker.
    unlinkSync(join(tmp, ".agents", "skills", "review-work", "SKILL.md"));

    const result = runCli("update");

    // The run must complete, not abort: blocker skipped with a clear reason…
    assert.equal(result.exitCode, 0);
    assert.ok(/work-step.*not a directory/s.test(result.stdout), result.stdout);
    // …and the rest of the run still applies (the deleted skill is recreated).
    assert.ok(existsSync(join(tmp, ".agents", "skills", "review-work", "SKILL.md")));
    // The pointer file is left exactly as-is, never clobbered.
    assert.equal(
      await readFile(skillDir, "utf-8"),
      "../../.claude/skills/work-step",
    );
  });
});

// 0.18 narrowed the gate, which is silent good news forward and a pile of stale
// state backward: acknowledgments banked against moves that no longer gate,
// retired `--standing` records, registry lines the project's own declarations
// contradict. None of it announces itself, and the upgrade is the one moment a
// reader is looking at codument at all.
describe("the upgrade names the cleanup it leaves behind", () => {
  const setMetaVersion = async (version: string | null): Promise<void> => {
    const path = join(tmp, ".codument-meta.json");
    const meta = JSON.parse(await readFile(path, "utf-8"));
    if (version === null) delete meta.version;
    else meta.version = version;
    await writeFile(path, JSON.stringify(meta, null, 2));
  };

  it("tells a pre-0.18 project what changed and the two commands that clear it", async () => {
    await setupInitializedProject();
    await setMetaVersion("0.16.2");

    const { stdout } = runCli("update");
    assert.match(stdout, /blocks only what it can prove/);
    assert.match(stdout, /codument ack --prune/);
    assert.match(stdout, /codument doctor --fix/);
  });

  it("names the block that got quieter, which nobody discovers on their own", async () => {
    // A loosening is the half of a release a user never finds by using it:
    // finding out later that a file quietly stopped being watched is how trust
    // in an exit code dies. So the note says it, and says where to look.
    await setupInitializedProject();
    await setMetaVersion("0.16.2");

    const { stdout } = runCli("update");
    assert.match(stdout, /no adapter can read/);
    assert.match(stdout, /risk/);
    assert.match(stdout, /codument doctor\b/);
  });

  it("never nags a project already past it", async () => {
    await setupInitializedProject();
    await setMetaVersion("0.18.0");

    const { stdout } = runCli("update");
    assert.doesNotMatch(stdout, /blocks only what it can prove/);
  });

  it("shows in a dry run too — the preview must not hide the part you act on", async () => {
    await setupInitializedProject();
    await setMetaVersion("0.16.2");

    const { stdout } = runCli("update", "--dry-run");
    assert.match(stdout, /blocks only what it can prove/);
  });

  it("shows when the prior version cannot be read at all", async () => {
    // Fail open: an unprovable "they already crossed" costs a screen of text,
    // while a wrong silence costs the cleanup entirely.
    await setupInitializedProject();
    await setMetaVersion(null);

    const { stdout } = runCli("update");
    assert.match(stdout, /blocks only what it can prove/);
  });
});

describe("nonDirectoryAncestor", () => {
  it("flags file / symlink-to-file / broken-symlink ancestors, allows real and symlinked dirs", async () => {
    // real directory ancestor → writable, not a blocker
    await mkdir(join(tmp, "realdir"), { recursive: true });
    assert.equal(nonDirectoryAncestor(join(tmp, "realdir", "SKILL.md")), null);

    // missing ancestor → created later, not a blocker
    assert.equal(nonDirectoryAncestor(join(tmp, "missing", "SKILL.md")), null);

    // plain file (pointer-file) where a directory must be → blocker
    await writeFile(join(tmp, "pointer"), "../../elsewhere");
    assert.equal(
      nonDirectoryAncestor(join(tmp, "pointer", "SKILL.md")),
      join(tmp, "pointer"),
    );

    // deep: a grandparent is a file → the grandparent is the blocker
    assert.equal(
      nonDirectoryAncestor(join(tmp, "pointer", "sub", "SKILL.md")),
      join(tmp, "pointer"),
    );

    // symlink → directory → written through, not a blocker
    symlinkSync(join(tmp, "realdir"), join(tmp, "linkdir"));
    assert.equal(nonDirectoryAncestor(join(tmp, "linkdir", "SKILL.md")), null);

    // symlink → file → blocker
    await writeFile(join(tmp, "afile"), "x");
    symlinkSync(join(tmp, "afile"), join(tmp, "linktofile"));
    assert.equal(
      nonDirectoryAncestor(join(tmp, "linktofile", "SKILL.md")),
      join(tmp, "linktofile"),
    );

    // broken / dangling symlink → blocker
    symlinkSync(join(tmp, "does-not-exist"), join(tmp, "brokenlink"));
    assert.equal(
      nonDirectoryAncestor(join(tmp, "brokenlink", "SKILL.md")),
      join(tmp, "brokenlink"),
    );
  });
});

describe("an invalid project setting is rendered, not crashed", () => {
  // The commands that read project metadata include the ones a user reaches for
  // to FIX a bad file. A raw stack trace from `update` is a dead end, so the
  // CLI boundary must own this error the way it owns a corrupt state file.
  const writeMetaRaw = async (exclude: unknown): Promise<void> => {
    await writeFile(
      join(tmp, ".codument-meta.json"),
      JSON.stringify({
        version: PKG_VERSION,
        initialized: "2026-07-21",
        project: { srcDir: "src" },
        exclude,
      }),
      "utf-8",
    );
  };

  it("names the offending value and the file, and exits non-zero", async () => {
    await writeMetaRaw({ dirs: ["build/out"] });
    const result = runCli("update", "--dry-run");
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /invalid exclude\.dirs/);
    assert.match(result.stdout, /"build\/out" is a path/);
    assert.match(result.stdout, /\.codument-meta\.json/);
    assert.match(result.stdout, /Correct the value in/);
    // The failure mode this pins: a raw Node stack reaching the user.
    assert.ok(!/\n\s+at .*:\d+:\d+/.test(result.stdout), "a stack trace leaked to the user");
    assert.ok(!/ConfigValueError:/.test(result.stdout), "the raw error name leaked");
  });

  it("does the same for an unknown key rather than ignoring it", async () => {
    await writeMetaRaw({ dir: ["out"] });
    const result = runCli("update", "--dry-run");
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /unknown key "dir"/);
  });

  it("leaves a valid exclude block alone", async () => {
    await writeMetaRaw({ dirs: ["out"], globs: ["**/*.gen.ts"] });
    const result = runCli("update", "--dry-run");
    assert.notEqual(result.exitCode, 1);
    assert.ok(!result.stdout.includes("invalid exclude"));
  });
});
