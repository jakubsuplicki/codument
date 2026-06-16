import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateRegistryCommand } from "../src/commands/migrate.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-migrate-"));
  await mkdir(join(tmp, "docs"), { recursive: true });
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeRegistryFile(data: unknown): Promise<void> {
  await writeFile(
    join(tmp, "docs", ".registry.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

async function readRegistryFile(): Promise<any> {
  return JSON.parse(await readFile(join(tmp, "docs", ".registry.json"), "utf-8"));
}

describe("migrate-registry command", () => {
  it("converts a legacy flat registry to v2 and writes a backup", async () => {
    await writeRegistryFile({
      features: {
        auth: {
          doc: "docs/features/auth.md",
          type: "feature",
          sources: ["src/auth/login.ts"],
          depends_on: [],
          last_updated: "2026-01-01",
          status: "current",
        },
      },
    });

    await migrateRegistryCommand({ root: tmp });

    const migrated = await readRegistryFile();
    assert.deepStrictEqual(migrated.features.auth.primary_sources, [
      "src/auth/login.ts",
    ]);
    assert.deepStrictEqual(migrated.features.auth.related_sources, []);
    assert.ok(!("sources" in migrated.features.auth));

    const backups = (await readdir(join(tmp, "docs"))).filter((f) =>
      f.startsWith(".registry.backup"),
    );
    assert.ok(backups.length >= 1, "a backup was written");
  });

  it("is idempotent: a v2 registry is left untouched", async () => {
    const v2 = {
      features: {
        auth: {
          doc: "docs/features/auth.md",
          type: "feature",
          primary_sources: ["src/auth/login.ts"],
          related_sources: [],
          docs: [],
          depends_on: [],
          risk: [],
          last_updated: "2026-01-01",
          status: "current",
        },
      },
    };
    await writeRegistryFile(v2);
    const before = await readFile(join(tmp, "docs", ".registry.json"), "utf-8");

    await migrateRegistryCommand({ root: tmp });

    const after = await readFile(join(tmp, "docs", ".registry.json"), "utf-8");
    assert.equal(after, before);
    assert.equal(existsSync(join(tmp, "docs", ".registry.backup.json")), false);
  });

  it("dry-run does not modify the file", async () => {
    await writeRegistryFile({
      features: {
        auth: {
          doc: "docs/features/auth.md",
          type: "feature",
          sources: ["src/auth/login.ts"],
          depends_on: [],
          status: "current",
        },
      },
    });
    const before = await readFile(join(tmp, "docs", ".registry.json"), "utf-8");

    await migrateRegistryCommand({ root: tmp, dryRun: true });

    const after = await readFile(join(tmp, "docs", ".registry.json"), "utf-8");
    assert.equal(after, before);
  });
});
