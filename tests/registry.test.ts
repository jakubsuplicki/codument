import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readRegistry,
  writeRegistry,
  updateRegistryEntry,
} from "../src/lib/registry.js";
import type { Registry, RegistryEntry } from "../src/lib/registry.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-test-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("readRegistry", () => {
  it("returns empty registry when file does not exist", async () => {
    const reg = await readRegistry(join(tmp, "missing.json"));
    assert.deepStrictEqual(reg, { features: {} });
  });

  it("reads existing registry file", async () => {
    const data: Registry = {
      features: {
        auth: {
          doc: "docs/features/auth.md",
          type: "feature",
          sources: ["src/auth.ts"],
          depends_on: [],
          last_updated: "2026-01-01",
          status: "current",
        },
      },
    };
    const path = join(tmp, "registry.json");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(path, JSON.stringify(data));

    const reg = await readRegistry(path);
    assert.deepStrictEqual(reg, data);
  });
});

describe("writeRegistry", () => {
  it("writes registry as formatted JSON with trailing newline", async () => {
    const path = join(tmp, "registry.json");
    const data: Registry = {
      features: {
        lib: {
          doc: "docs/concepts/lib.md",
          type: "concept",
          sources: ["src/lib/utils.ts"],
          depends_on: ["auth"],
          last_updated: "2026-03-01",
          status: "stale",
        },
      },
    };

    await writeRegistry(path, data);
    const raw = await readFile(path, "utf-8");

    assert.ok(raw.endsWith("\n"), "should end with newline");
    assert.deepStrictEqual(JSON.parse(raw), data);
    // Check 2-space indentation
    assert.ok(raw.includes('  "features"'));
  });
});

describe("updateRegistryEntry", () => {
  it("creates new entry if key does not exist", async () => {
    const path = join(tmp, "registry.json");
    await writeRegistry(path, { features: {} });

    const result = updateRegistryEntry(path, "auth", {
      doc: "docs/features/auth.md",
      type: "feature",
      sources: ["src/auth.ts"],
      depends_on: [],
      status: "current",
    });

    assert.ok(result.features.auth);
    assert.equal(result.features.auth.doc, "docs/features/auth.md");
    assert.equal(result.features.auth.type, "feature");
    // last_updated should be today
    const today = new Date().toISOString().split("T")[0];
    assert.equal(result.features.auth.last_updated, today);
  });

  it("merges with existing entry", async () => {
    const path = join(tmp, "registry.json");
    const initial: Registry = {
      features: {
        auth: {
          doc: "docs/features/auth.md",
          type: "feature",
          sources: ["src/auth.ts"],
          depends_on: [],
          last_updated: "2025-01-01",
          status: "current",
        },
      },
    };
    await writeRegistry(path, initial);

    const result = updateRegistryEntry(path, "auth", {
      status: "stale",
      sources: ["src/auth.ts", "src/auth-utils.ts"],
    });

    // Merged fields
    assert.equal(result.features.auth.status, "stale");
    assert.deepStrictEqual(result.features.auth.sources, [
      "src/auth.ts",
      "src/auth-utils.ts",
    ]);
    // Preserved fields
    assert.equal(result.features.auth.doc, "docs/features/auth.md");
    assert.equal(result.features.auth.type, "feature");
    // last_updated auto-set
    const today = new Date().toISOString().split("T")[0];
    assert.equal(result.features.auth.last_updated, today);
  });

  it("persists changes to disk", async () => {
    const path = join(tmp, "registry.json");
    await writeRegistry(path, { features: {} });

    updateRegistryEntry(path, "scan", {
      doc: "docs/features/scan.md",
      type: "feature",
      sources: ["src/commands/scan.ts"],
      depends_on: [],
      status: "needs-review",
    });

    // Read from disk independently
    const onDisk = JSON.parse(await readFile(path, "utf-8"));
    assert.ok(onDisk.features.scan);
    assert.equal(onDisk.features.scan.status, "needs-review");
  });
});
