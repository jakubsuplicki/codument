import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  allSources,
  hasLegacyMappings,
  isLegacyEntry,
  isMatureEntry,
  migrateRegistry,
  normalizeRegistry,
  readRegistry,
  readRegistrySync,
  registryNeedsMigration,
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

function v2Entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    doc: "docs/features/auth.md",
    type: "feature",
    primary_sources: [],
    related_sources: [],
    docs: [],
    depends_on: [],
    risk: [],
    last_updated: "2026-01-01",
    status: "current",
    ...overrides,
  };
}

describe("readRegistry", () => {
  it("returns empty registry when file does not exist", async () => {
    const reg = await readRegistry(join(tmp, "missing.json"));
    assert.deepStrictEqual(reg, { features: {} });
  });

  it("reads an existing v2 registry file verbatim", async () => {
    const data: Registry = {
      features: {
        auth: v2Entry({
          doc: "docs/features/auth.md",
          primary_sources: ["src/auth/login.ts"],
          related_sources: ["src/lib/db.ts"],
          docs: [],
          depends_on: ["db"],
          risk: ["auth", "security"],
        }),
      },
    };
    const path = join(tmp, "registry.json");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(path, JSON.stringify(data));

    const reg = await readRegistry(path);
    assert.deepStrictEqual(reg, data);
  });

  it("does NOT fold a legacy flat `sources` array on the normal v2 read path", async () => {
    const path = join(tmp, "registry.json");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(
      path,
      JSON.stringify({
        features: {
          auth: {
            doc: "docs/features/auth.md",
            type: "feature",
            sources: ["src/auth/login.ts", "src/auth/session.ts"],
            depends_on: [],
            last_updated: "2026-01-01",
            status: "current",
          },
        },
      }),
    );

    // v2-only read: legacy `sources` is ignored (migration is the only legacy reader)
    const reg = await readRegistry(path);
    assert.deepStrictEqual(reg.features.auth.primary_sources, []);
  });

  it("preserves an unknown status verbatim instead of flattening to current", async () => {
    const path = join(tmp, "registry.json");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(
      path,
      JSON.stringify({
        features: {
          "proof-benchmarks": {
            doc: "docs/features/proof-benchmarks.md",
            type: "feature",
            sources: ["src/lib/benchmark-quality.ts"],
            depends_on: [],
            last_updated: "2026-06-16",
            status: "in-progress",
          },
        },
      }),
    );

    const reg = await readRegistry(path);
    assert.equal(reg.features["proof-benchmarks"].status, "in-progress");
  });

  it("reads a v2 registry synchronously", async () => {
    const path = join(tmp, "registry.json");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(
      path,
      JSON.stringify({
        features: {
          lib: v2Entry({
            doc: "docs/concepts/lib.md",
            type: "concept",
            primary_sources: ["src/lib/registry.ts"],
          }),
        },
      }),
    );

    const reg = readRegistrySync(path);
    assert.equal(reg.features.lib.doc, "docs/concepts/lib.md");
    assert.deepStrictEqual(reg.features.lib.primary_sources, [
      "src/lib/registry.ts",
    ]);
  });
});

describe("migrateRegistry", () => {
  it("folds a legacy flat `sources` array into primary_sources", () => {
    const { registry, changed } = migrateRegistry({
      features: {
        auth: {
          doc: "docs/features/auth.md",
          type: "feature",
          sources: ["src/auth/login.ts", "src/auth/session.ts"],
          depends_on: [],
          last_updated: "2026-01-01",
          status: "current",
        },
      },
    });
    assert.equal(changed, true);
    assert.deepStrictEqual(registry.features.auth.primary_sources, [
      "src/auth/login.ts",
      "src/auth/session.ts",
    ]);
    assert.deepStrictEqual(registry.features.auth.related_sources, []);
  });

  it("folds legacy mappings into primary_sources, one entry per doc", () => {
    const { registry, changed } = migrateRegistry({
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
    });

    assert.equal(changed, true);
    assert.deepStrictEqual(registry.features["cook-mode"].primary_sources, [
      "app/cook/[recipeId].tsx",
    ]);
    assert.equal(registry.features["cook-mode"].doc, "docs/features/cook-mode.md");
    assert.deepStrictEqual(
      registry.features["subscription-and-paywall"].primary_sources,
      ["services/subscription/subscriptionService.ts"],
    );
  });

  it("preserves status during migration and reports unchanged for v2 input", () => {
    const v2 = {
      features: { auth: v2Entry({ primary_sources: ["src/auth.ts"], status: "in-progress" }) },
    };
    const { registry, changed } = migrateRegistry(v2);
    assert.equal(changed, false);
    assert.equal(registry.features.auth.status, "in-progress");
  });
});

describe("registryNeedsMigration", () => {
  it("is true for legacy flat entries and legacy mappings", () => {
    assert.equal(
      registryNeedsMigration({ features: { a: { doc: "docs/features/a.md", sources: [] } } }),
      true,
    );
    assert.equal(registryNeedsMigration({ mappings: {} }), true);
  });
  it("is false for a v2 registry", () => {
    assert.equal(
      registryNeedsMigration({ features: { a: v2Entry({ primary_sources: ["src/a.ts"] }) } }),
      false,
    );
  });
});

describe("normalizeRegistry", () => {
  it("preserves canonical v2 entries and ignores legacy mappings (v2-only read)", () => {
    const reg = normalizeRegistry(
      {
        features: {
          lib: v2Entry({
            doc: "docs/concepts/lib.md",
            type: "concept",
            primary_sources: ["src/lib/codemod.ts"],
          }),
        },
        mappings: {
          "src/lib/registry.ts": ["concepts/lib.md"],
        },
      },
      "2026-05-29",
    );

    // normalizeRegistry is v2-only: the legacy mapping is NOT merged in
    assert.deepStrictEqual(reg.features.lib.primary_sources, [
      "src/lib/codemod.ts",
    ]);
    assert.equal(reg.features.lib.last_updated, "2026-01-01");
  });

  it("dedupes and sorts source arrays", () => {
    const reg = normalizeRegistry({
      features: {
        auth: {
          doc: "docs/features/auth.md",
          type: "feature",
          primary_sources: ["src/b.ts", "src/a.ts", "src/b.ts"],
          related_sources: ["src/z.ts"],
          status: "current",
        },
      },
    });
    assert.deepStrictEqual(reg.features.auth.primary_sources, [
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("detects legacy mappings", () => {
    assert.equal(hasLegacyMappings({ mappings: {} }), true);
    assert.equal(hasLegacyMappings({ features: {} }), false);
  });
});

describe("isLegacyEntry", () => {
  it("flags a flat entry with sources and no v2 fields", () => {
    assert.equal(
      isLegacyEntry({ doc: "docs/features/a.md", sources: ["src/a.ts"] }),
      true,
    );
  });
  it("does not flag a v2 entry", () => {
    assert.equal(
      isLegacyEntry({ doc: "docs/features/a.md", primary_sources: ["src/a.ts"] }),
      false,
    );
  });
});

describe("allSources / isMatureEntry", () => {
  it("unions primary and related sources, deduped and sorted", () => {
    const entry = v2Entry({
      primary_sources: ["src/b.ts", "src/a.ts"],
      related_sources: ["src/a.ts", "src/c.ts"],
    });
    assert.deepStrictEqual(allSources(entry), [
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
  });

  it("treats an entry that owns a source with a built status as mature", () => {
    assert.equal(isMatureEntry(v2Entry({ primary_sources: ["src/a.ts"] })), true);
  });

  it("treats a draft entry or an entry with no owned source as not mature", () => {
    assert.equal(
      isMatureEntry(v2Entry({ primary_sources: ["src/a.ts"], status: "draft" })),
      false,
    );
    assert.equal(isMatureEntry(v2Entry({ primary_sources: [] })), false);
  });
});

describe("writeRegistry", () => {
  it("writes registry as formatted JSON with trailing newline", async () => {
    const path = join(tmp, "registry.json");
    const data: Registry = {
      features: {
        lib: v2Entry({
          doc: "docs/concepts/lib.md",
          type: "concept",
          primary_sources: ["src/lib/utils.ts"],
          depends_on: ["auth"],
          last_updated: "2026-03-01",
          status: "stale",
        }),
      },
    };

    await writeRegistry(path, data);
    const raw = await readFile(path, "utf-8");

    assert.ok(raw.endsWith("\n"), "should end with newline");
    assert.deepStrictEqual(JSON.parse(raw), data);
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
      primary_sources: ["src/auth.ts"],
      depends_on: [],
      status: "current",
    });

    assert.ok(result.features.auth);
    assert.equal(result.features.auth.doc, "docs/features/auth.md");
    assert.equal(result.features.auth.type, "feature");
    assert.deepStrictEqual(result.features.auth.primary_sources, ["src/auth.ts"]);
    // missing v2 fields default to empty arrays
    assert.deepStrictEqual(result.features.auth.related_sources, []);
    assert.deepStrictEqual(result.features.auth.risk, []);
    const today = new Date().toISOString().split("T")[0];
    assert.equal(result.features.auth.last_updated, today);
  });

  it("merges with existing entry", async () => {
    const path = join(tmp, "registry.json");
    const initial: Registry = {
      features: {
        auth: v2Entry({
          doc: "docs/features/auth.md",
          primary_sources: ["src/auth.ts"],
          last_updated: "2025-01-01",
        }),
      },
    };
    await writeRegistry(path, initial);

    const result = updateRegistryEntry(path, "auth", {
      status: "stale",
      primary_sources: ["src/auth.ts", "src/auth-utils.ts"],
    });

    assert.equal(result.features.auth.status, "stale");
    assert.deepStrictEqual(result.features.auth.primary_sources, [
      "src/auth.ts",
      "src/auth-utils.ts",
    ]);
    assert.equal(result.features.auth.doc, "docs/features/auth.md");
    assert.equal(result.features.auth.type, "feature");
    const today = new Date().toISOString().split("T")[0];
    assert.equal(result.features.auth.last_updated, today);
  });

  it("persists changes to disk", async () => {
    const path = join(tmp, "registry.json");
    await writeRegistry(path, { features: {} });

    updateRegistryEntry(path, "scan", {
      doc: "docs/features/scan.md",
      type: "feature",
      primary_sources: ["src/commands/scan.ts"],
      depends_on: [],
      status: "needs-review",
    });

    const onDisk = JSON.parse(await readFile(path, "utf-8"));
    assert.ok(onDisk.features.scan);
    assert.equal(onDisk.features.scan.status, "needs-review");
  });
});
