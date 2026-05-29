import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  hasLegacyMappings,
  normalizeRegistry,
  readRegistry,
  readRegistrySync,
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

  it("normalizes legacy mappings into feature entries", async () => {
    const path = join(tmp, "registry.json");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(
      path,
      JSON.stringify({
        features: {},
        mappings: {
          "app/cook/[recipeId].tsx": [
            "features/cook-mode.md",
            "features/cook-mode-voice-control.md",
          ],
          "services/subscription/subscriptionService.ts": [
            "features/subscription-and-paywall.md",
          ],
        },
      }),
    );

    const reg = await readRegistry(path);

    assert.deepStrictEqual(reg.features["cook-mode"].sources, [
      "app/cook/[recipeId].tsx",
    ]);
    assert.equal(reg.features["cook-mode"].doc, "docs/features/cook-mode.md");
    assert.equal(reg.features["cook-mode"].type, "feature");
    assert.deepStrictEqual(
      reg.features["cook-mode-voice-control"].sources,
      ["app/cook/[recipeId].tsx"],
    );
    assert.deepStrictEqual(
      reg.features["subscription-and-paywall"].sources,
      ["services/subscription/subscriptionService.ts"],
    );
  });

  it("sync read also normalizes legacy mappings", async () => {
    const path = join(tmp, "registry.json");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(
      path,
      JSON.stringify({
        mappings: {
          "src/lib/registry.ts": ["concepts/lib.md"],
        },
      }),
    );

    const reg = readRegistrySync(path);

    assert.equal(reg.features.lib.doc, "docs/concepts/lib.md");
    assert.deepStrictEqual(reg.features.lib.sources, ["src/lib/registry.ts"]);
  });
});

describe("normalizeRegistry", () => {
  it("preserves canonical entries and merges legacy mappings", () => {
    const reg = normalizeRegistry(
      {
        features: {
          lib: {
            doc: "docs/concepts/lib.md",
            type: "concept",
            sources: ["src/lib/codemod.ts"],
            depends_on: [],
            last_updated: "2026-01-01",
            status: "current",
          },
        },
        mappings: {
          "src/lib/registry.ts": ["concepts/lib.md"],
        },
      },
      "2026-05-29",
    );

    assert.deepStrictEqual(reg.features.lib.sources, [
      "src/lib/codemod.ts",
      "src/lib/registry.ts",
    ]);
    assert.equal(reg.features.lib.last_updated, "2026-01-01");
  });

  it("detects legacy mappings", () => {
    assert.equal(hasLegacyMappings({ mappings: {} }), true);
    assert.equal(hasLegacyMappings({ features: {} }), false);
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
