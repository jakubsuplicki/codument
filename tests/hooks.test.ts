import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Registry } from "../src/lib/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, "..", "dist", "hooks", "check-docs.js");

async function createProject(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "codument-test-"));
  await mkdir(join(tmp, "docs"), { recursive: true });
  await mkdir(join(tmp, "src"), { recursive: true });
  await writeFile(join(tmp, "src", "feature.ts"), "export const x = 1;\n");
  return tmp;
}

function runHook(root: string, filePath: string): string {
  return execFileSync("node", [HOOK], {
    cwd: root,
    encoding: "utf-8",
    env: {
      ...process.env,
      CLAUDE_TOOL_INPUT: JSON.stringify({ file_path: filePath }),
    },
    timeout: 10000,
  });
}

// Current Claude Code contract: the payload arrives as JSON on stdin
// ({ tool_input: { file_path } }) with NO CLAUDE_TOOL_INPUT env var.
function runHookViaStdin(cwd: string, filePath: string): string {
  const env = { ...process.env };
  delete env.CLAUDE_TOOL_INPUT;
  return execFileSync("node", [HOOK], {
    cwd,
    input: JSON.stringify({ tool_input: { file_path: filePath } }),
    encoding: "utf-8",
    env,
    timeout: 10000,
  });
}

// Legacy env contract but run from an unrelated cwd, to prove the hook resolves
// the registry from the edited file's path rather than process.cwd().
function runHookFromCwd(cwd: string, filePath: string): string {
  return execFileSync("node", [HOOK], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      CLAUDE_TOOL_INPUT: JSON.stringify({ file_path: filePath }),
    },
    timeout: 10000,
  });
}

describe("check-docs hook", () => {
  it("prints all docs mapped to a changed source file", async () => {
    const tmp = await createProject();
    try {
      const registry: Registry = {
        features: {
          feature: {
            doc: "docs/features/feature.md",
            type: "feature",
            primary_sources: ["src/feature.ts"],
            depends_on: [],
            last_updated: "2026-05-29",
            status: "current",
          },
          "feature-voice": {
            doc: "docs/features/feature-voice.md",
            type: "feature",
            primary_sources: ["src/feature.ts"],
            depends_on: [],
            last_updated: "2026-05-29",
            status: "current",
          },
        },
      };
      await writeFile(
        join(tmp, "docs", ".registry.json"),
        JSON.stringify(registry, null, 2) + "\n",
      );

      const output = runHook(tmp, join(tmp, "src", "feature.ts"));

      assert.ok(output.includes('"feature" (docs/features/feature.md)'));
      assert.ok(output.includes('"feature-voice" (docs/features/feature-voice.md)'));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("nudges for module-flavored sources and stays silent for declaration artifacts", async () => {
    const tmp = await createProject();
    try {
      const registry: Registry = {
        features: {
          config: {
            doc: "docs/features/config.md",
            type: "feature",
            primary_sources: ["next.config.mjs", "types/api.d.ts"],
            depends_on: [],
            last_updated: "2026-07-12",
            status: "current",
          },
        },
      };
      await writeFile(
        join(tmp, "docs", ".registry.json"),
        JSON.stringify(registry, null, 2) + "\n",
      );
      await writeFile(join(tmp, "next.config.mjs"), "export default {};\n");
      await mkdir(join(tmp, "types"), { recursive: true });
      await writeFile(join(tmp, "types", "api.d.ts"), "export type A = 1;\n");

      // A governed module-flavored file nudges like any source…
      const nudge = runHook(tmp, join(tmp, "next.config.mjs"));
      assert.ok(nudge.includes('"config" (docs/features/config.md)'));
      // …a declaration artifact the gate excludes produces no nudge (the shared
      // spec, not a hook-local extension list, decides).
      const silent = runHook(tmp, join(tmp, "types", "api.d.ts"));
      assert.equal(silent.trim(), "");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("nudges for a governed python source and stays silent for its test files", async () => {
    const tmp = await createProject();
    try {
      const registry: Registry = {
        features: {
          settings: {
            doc: "docs/features/settings.md",
            type: "feature",
            primary_sources: ["app/settings.py", "app/test_settings.py"],
            depends_on: [],
            last_updated: "2026-07-12",
            status: "current",
          },
        },
      };
      await writeFile(
        join(tmp, "docs", ".registry.json"),
        JSON.stringify(registry, null, 2) + "\n",
      );
      await mkdir(join(tmp, "app"), { recursive: true });
      await writeFile(join(tmp, "app", "settings.py"), "DEBUG = True\n");
      await writeFile(join(tmp, "app", "test_settings.py"), "def test_debug():\n    pass\n");

      const nudge = runHook(tmp, join(tmp, "app", "settings.py"));
      assert.ok(nudge.includes('"settings" (docs/features/settings.md)'));
      // pytest-convention files are outside the shared spec — no nudge, even
      // when someone registers them.
      const silent = runHook(tmp, join(tmp, "app", "test_settings.py"));
      assert.equal(silent.trim(), "");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("does not match an un-migrated legacy registry (v2-only read)", async () => {
    const tmp = await createProject();
    try {
      // Legacy `mappings` are no longer read on the hook path — the registry
      // must be migrated to v2 first. So an un-migrated registry yields no match.
      await writeFile(
        join(tmp, "docs", ".registry.json"),
        JSON.stringify({
          mappings: {
            "src/feature.ts": ["features/feature.md"],
          },
        }),
      );

      const output = runHook(tmp, join(tmp, "src", "feature.ts"));

      assert.equal(output.trim(), "");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("no-ops silently on an unreadable registry (never crashes the edit)", async () => {
    const tmp = await createProject();
    try {
      // Valid intent, invalid JSON (trailing comma). runHook uses execFileSync,
      // which throws on a non-zero exit — so a clean return here proves the hook
      // exited 0, and the empty output proves it stayed silent-on-doubt.
      await writeFile(
        join(tmp, "docs", ".registry.json"),
        '{ "features": { "feature": { "doc": "x", } } }',
      );

      const output = runHook(tmp, join(tmp, "src", "feature.ts"));

      assert.equal(output.trim(), "");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("reads the payload from stdin when no CLAUDE_TOOL_INPUT env is set", async () => {
    const tmp = await createProject();
    try {
      const registry: Registry = {
        features: {
          feature: {
            doc: "docs/features/feature.md",
            type: "feature",
            primary_sources: ["src/feature.ts"],
            depends_on: [],
            last_updated: "2026-05-29",
            status: "current",
          },
        },
      };
      await writeFile(
        join(tmp, "docs", ".registry.json"),
        JSON.stringify(registry, null, 2) + "\n",
      );

      const output = runHookViaStdin(tmp, join(tmp, "src", "feature.ts"));

      assert.ok(output.includes('"feature" (docs/features/feature.md)'));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("resolves the registry from the edited file's path regardless of cwd", async () => {
    const tmp = await createProject();
    const otherCwd = await mkdtemp(join(tmpdir(), "codument-cwd-"));
    try {
      const registry: Registry = {
        features: {
          feature: {
            doc: "docs/features/feature.md",
            type: "feature",
            primary_sources: ["src/feature.ts"],
            depends_on: [],
            last_updated: "2026-05-29",
            status: "current",
          },
        },
      };
      await writeFile(
        join(tmp, "docs", ".registry.json"),
        JSON.stringify(registry, null, 2) + "\n",
      );

      // Run from an unrelated directory; file_path is absolute inside tmp.
      const output = runHookFromCwd(otherCwd, join(tmp, "src", "feature.ts"));

      assert.ok(output.includes('"feature" (docs/features/feature.md)'));
    } finally {
      await rm(tmp, { recursive: true, force: true });
      await rm(otherCwd, { recursive: true, force: true });
    }
  });
});

describe("the installed hook COMMAND is guarded (a nudge must never break the editor loop)", () => {
  it("exits 0 with no output when codument is not in local node_modules", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-hookcmd-"));
    try {
      const { CLAUDE_DOCS_HOOK_COMMAND } = await import("../src/lib/claude-settings.js");
      // Run exactly what Claude Code would run: the command through a shell,
      // from a project with no node_modules — the npx-cache-only/global case
      // that used to stack MODULE_NOT_FOUND + exit 1 on every Write/Edit.
      const out = execFileSync("sh", ["-c", CLAUDE_DOCS_HOOK_COMMAND], {
        cwd: tmp,
        encoding: "utf-8",
        input: JSON.stringify({ tool_input: { file_path: join(tmp, "src", "x.ts") } }),
        timeout: 10000,
      });
      assert.equal(out, "", "dormant means silent");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("runs the target with stdin intact when the local install exists", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "codument-hookcmd-"));
    try {
      const { CLAUDE_DOCS_HOOK_COMMAND, CLAUDE_DOCS_HOOK_TARGET } = await import(
        "../src/lib/claude-settings.js"
      );
      const target = join(tmp, CLAUDE_DOCS_HOOK_TARGET);
      await mkdir(dirname(target), { recursive: true });
      // A stub target proving both halves: the guard imports it, and stdin
      // reaches it (the payload contract the real hook reads).
      await writeFile(
        target,
        'process.stdout.write("HOOK-RAN:" + require("fs").readFileSync(0, "utf-8"));\n',
      );
      const out = execFileSync("sh", ["-c", CLAUDE_DOCS_HOOK_COMMAND], {
        cwd: tmp,
        encoding: "utf-8",
        input: '{"tool_input":{"file_path":"src/x.ts"}}',
        timeout: 10000,
      });
      assert.match(out, /^HOOK-RAN:/);
      assert.match(out, /src\/x\.ts/, "stdin payload reached the hook");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
