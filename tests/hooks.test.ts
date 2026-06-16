import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Registry } from "../src/lib/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, "..", "dist", "hooks", "check-docs.js");

async function createProject(): Promise<string> {
  const tmp = await mkdtemp("/private/tmp/codument-test-");
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
});
