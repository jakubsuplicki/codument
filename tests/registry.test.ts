import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWriteFileSync } from "../src/lib/events.js";
import {
  allSources,
  isMatureEntry,
  normalizeRegistry,
  readRegistry,
  readRegistrySync,
  writeRegistry,
  updateRegistryEntry,
  RegistryError,
} from "../src/lib/registry.js";
import type { Registry, RegistryEntry } from "../src/lib/registry.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "codument-test-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    doc: "docs/features/auth.md",
    type: "feature",
    primary_sources: [],
    related_sources: [],
    docs: [],
    depends_on: [],
    risk: [],
    status: "current",
    ...overrides,
  };
}

describe("readRegistry", () => {
  it("returns empty registry when file does not exist", async () => {
    const reg = await readRegistry(join(tmp, "missing.json"));
    assert.deepStrictEqual(reg, { features: {} });
  });

  it("reads an existing registry file verbatim", async () => {
    const data: Registry = {
      features: {
        auth: entry({
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

  it("ignores an unknown flat `sources` array (only primary_sources is owned)", async () => {
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
            status: "current",
          },
        },
      }),
    );

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
            primary_sources: ["src/lib/benchmark-quality.ts"],
            depends_on: [],
            status: "in-progress",
          },
        },
      }),
    );

    const reg = await readRegistry(path);
    assert.equal(reg.features["proof-benchmarks"].status, "in-progress");
  });

  it("reads a registry synchronously", async () => {
    const path = join(tmp, "registry.json");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(
      path,
      JSON.stringify({
        features: {
          lib: entry({
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

describe("normalizeRegistry", () => {
  it("preserves canonical entries and reads only the features map", () => {
    const reg = normalizeRegistry({
      features: {
        lib: entry({
          doc: "docs/concepts/lib.md",
          type: "concept",
          primary_sources: ["src/lib/codemod.ts"],
        }),
      },
    });

    assert.deepStrictEqual(reg.features.lib.primary_sources, [
      "src/lib/codemod.ts",
    ]);
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
});

describe("allSources / isMatureEntry", () => {
  it("unions primary and related sources, deduped and sorted", () => {
    const e = entry({
      primary_sources: ["src/b.ts", "src/a.ts"],
      related_sources: ["src/a.ts", "src/c.ts"],
    });
    assert.deepStrictEqual(allSources(e), [
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
  });

  it("treats an entry that owns a source with a built status as mature", () => {
    assert.equal(isMatureEntry(entry({ primary_sources: ["src/a.ts"] })), true);
  });

  it("treats a draft entry or an entry with no owned source as not mature", () => {
    assert.equal(
      isMatureEntry(entry({ primary_sources: ["src/a.ts"], status: "draft" })),
      false,
    );
    assert.equal(isMatureEntry(entry({ primary_sources: [] })), false);
  });
});

describe("writeRegistry", () => {
  it("writes registry as formatted JSON with trailing newline", async () => {
    const path = join(tmp, "registry.json");
    const data: Registry = {
      features: {
        lib: entry({
          doc: "docs/concepts/lib.md",
          type: "concept",
          primary_sources: ["src/lib/utils.ts"],
          depends_on: ["auth"],
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
    // missing fields default to empty arrays
    assert.deepStrictEqual(result.features.auth.related_sources, []);
    assert.deepStrictEqual(result.features.auth.risk, []);
  });

  it("merges with existing entry", async () => {
    const path = join(tmp, "registry.json");
    const initial: Registry = {
      features: {
        auth: entry({
          doc: "docs/features/auth.md",
          primary_sources: ["src/auth.ts"],
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

describe("fail-loud on a corrupt registry", () => {
  // A registry with a real feature plus a trailing comma: valid intent, invalid
  // JSON. The old behavior read this as empty, then the next write destroyed it.
  const CORRUPT = `{
  "features": {
    "auth": {
      "doc": "docs/features/auth.md",
      "type": "feature",
      "primary_sources": ["src/auth.ts"],
    }
  }
}`;

  it("readRegistrySync throws RegistryError, never an empty default", async () => {
    const path = join(tmp, "registry.json");
    await writeFile(path, CORRUPT);
    assert.throws(() => readRegistrySync(path), (err) => {
      assert.ok(err instanceof RegistryError);
      assert.equal(err.path, path);
      return true;
    });
  });

  it("readRegistry (async) rejects with RegistryError", async () => {
    const path = join(tmp, "registry.json");
    await writeFile(path, CORRUPT);
    await assert.rejects(readRegistry(path), (err) => err instanceof RegistryError);
  });

  it("updateRegistryEntry refuses to write and leaves the file byte-identical", async () => {
    const path = join(tmp, "registry.json");
    await writeFile(path, CORRUPT);
    assert.throws(
      () => updateRegistryEntry(path, "scan", { primary_sources: ["src/scan.ts"] }),
      (err) => err instanceof RegistryError,
    );
    // The real (if malformed) registry is untouched — no partial rewrite.
    assert.equal(await readFile(path, "utf-8"), CORRUPT);
  });

  it("still treats a missing file as an empty registry, not an error", async () => {
    const reg = readRegistrySync(join(tmp, "does-not-exist.json"));
    assert.deepStrictEqual(reg, { features: {} });
  });
});

describe("atomic state writes", () => {
  it("replaces content via tmp + rename and leaves no temp residue", async () => {
    const path = join(tmp, "state.json");
    atomicWriteFileSync(path, "first\n");
    atomicWriteFileSync(path, "second\n");
    assert.equal(await readFile(path, "utf-8"), "second\n");
    const siblings = await readdir(tmp);
    assert.ok(!siblings.some((f) => f.includes(".tmp-")), "no temp file left behind");
  });

  it("routes registry writes through the atomic path (no torn or temp file)", async () => {
    const path = join(tmp, "registry.json");
    await writeRegistry(path, { features: {} });
    updateRegistryEntry(path, "auth", { primary_sources: ["src/auth.ts"] });
    assert.deepEqual(
      readRegistrySync(path).features.auth.primary_sources,
      ["src/auth.ts"],
    );
    const siblings = await readdir(tmp);
    assert.ok(!siblings.some((f) => f.includes(".tmp-")), "no temp file left behind");
  });
});
