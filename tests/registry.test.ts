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
  ExcludedSourceError,
  isSourcePattern,
  sourceNames,
  patternPrefix,
} from "../src/lib/registry.js";
import type { Registry, RegistryEntry } from "../src/lib/registry.js";
import { DEFAULT_EXCLUSION_SPEC } from "../src/lib/exclusion-spec.js";
import type { ExclusionSpec } from "../src/lib/exclusion-spec.js";

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

// The authoring guard. The exclusion spec governs every read path but no write
// path, so the loop could author an entry its own lint rejects. Authoring is
// strict; reading stays tolerant, or `doctor` could never report the entry it
// exists to report.
describe("updateRegistryEntry refuses an excluded source", () => {
  it("refuses a test file newly added to primary_sources", async () => {
    const path = join(tmp, "registry.json");
    await writeRegistry(path, { features: {} });

    assert.throws(
      () =>
        updateRegistryEntry(path, "money", {
          doc: "docs/features/money.md",
          type: "feature",
          primary_sources: ["src/money.ts", "src/money.test.js"],
        }),
      (err: unknown) => err instanceof ExcludedSourceError && err.path === "src/money.test.js",
    );
  });

  it("refuses a test file newly added to related_sources", async () => {
    const path = join(tmp, "registry.json");
    await writeRegistry(path, { features: {} });

    assert.throws(
      () => updateRegistryEntry(path, "money", { related_sources: ["tests/money.test.ts"] }),
      (err: unknown) => err instanceof ExcludedSourceError,
    );
  });

  it("refuses a path only the project's declared spec covers", async () => {
    const path = join(tmp, "registry.json");
    await writeRegistry(path, { features: {} });
    const declared: ExclusionSpec = {
      ...DEFAULT_EXCLUSION_SPEC,
      dirs: [...DEFAULT_EXCLUSION_SPEC.dirs, "public-preprod"],
    };

    assert.throws(
      () =>
        updateRegistryEntry(path, "site", { primary_sources: ["public-preprod/app.ts"] }, declared),
      (err: unknown) => err instanceof ExcludedSourceError,
    );
    // ...and the same path is fine under the built-in spec, so the refusal
    // really came from the project's own declaration.
    assert.ok(updateRegistryEntry(path, "site", { primary_sources: ["public-preprod/app.ts"] }));
  });

  it("accepts an ordinary source", async () => {
    const path = join(tmp, "registry.json");
    await writeRegistry(path, { features: {} });

    const result = updateRegistryEntry(path, "auth", { primary_sources: ["src/auth.ts"] });
    assert.deepStrictEqual(result.features.auth.primary_sources, ["src/auth.ts"]);
  });

  // The read-modify-write trap: `map materialize` passes the merged array, so a
  // blanket check would make a legacy-bad entry impossible to extend or repair.
  // Only a NEWLY introduced excluded path is refused.
  it("still lets a legacy entry that already names a test file be extended", async () => {
    const path = join(tmp, "registry.json");
    await writeRegistry(path, {
      features: {
        money: entry({
          doc: "docs/features/money.md",
          primary_sources: ["src/money.ts", "src/money.test.js"],
        }),
      },
    });

    const result = updateRegistryEntry(path, "money", {
      primary_sources: ["src/money.ts", "src/money.test.js", "src/rounding.ts"],
    });
    assert.ok(result.features.money.primary_sources.includes("src/rounding.ts"));
  });

  it("lets a legacy entry be repaired by dropping the test file", async () => {
    const path = join(tmp, "registry.json");
    await writeRegistry(path, {
      features: {
        money: entry({ primary_sources: ["src/money.ts", "src/money.test.js"] }),
      },
    });

    const result = updateRegistryEntry(path, "money", { primary_sources: ["src/money.ts"] });
    assert.deepStrictEqual(result.features.money.primary_sources, ["src/money.ts"]);
  });

  // Both halves of the plan's decision: authoring refuses, reading tolerates.
  it("still loads an existing registry that names a test file, so doctor can lint it", async () => {
    const path = join(tmp, "registry.json");
    await writeRegistry(path, {
      features: { money: entry({ primary_sources: ["src/money.ts", "src/money.test.js"] }) },
    });

    const loaded = await readRegistry(path);
    assert.ok(loaded.features.money.primary_sources.includes("src/money.test.js"));
  });

  it("leaves writeRegistry tolerant, so adopt can canonicalize a legacy registry", async () => {
    const path = join(tmp, "registry.json");
    await writeRegistry(path, {
      features: { money: entry({ primary_sources: ["src/money.test.js"] }) },
    });

    const onDisk = JSON.parse(await readFile(path, "utf-8"));
    assert.deepStrictEqual(onDisk.features.money.primary_sources, ["src/money.test.js"]);
  });

  // ADVERSARIAL REVIEW FINDING (confirmed): the guard's own comparisons run
  // `toPosix`, which only splits on the OS-native `path.sep`. On a POSIX host
  // (mac/Linux — the common dev/CI environment) that makes `toPosix` a no-op
  // for backslash-separated strings, so a `dirs`-excluded path spelled with
  // backslashes slips past `isExcluded`'s segment check entirely, even though
  // the semantically identical forward-slash path is correctly refused. This
  // is exactly the case Step 2 exists to close ("no legitimate case ... and no
  // guard against writing one") and it stays open for this spelling.
  it("refuses a dirs-excluded path even when spelled with backslash separators", async () => {
    const path = join(tmp, "registry.json");
    await writeRegistry(path, { features: {} });

    assert.throws(
      () =>
        updateRegistryEntry(path, "vendor", {
          primary_sources: ["node_modules\\evil-package\\index.ts"],
        }),
      (err: unknown) => err instanceof ExcludedSourceError,
    );
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

// Plan 43 / the 2026-08-09 field report, finding 4. Six new language packs — 120
// files, ~5,400 user-visible strings — landed reporting as `60 other` and exit 0,
// because registering them meant typing 380 paths into the registry by hand. A source
// entry can now name a set.
describe("a source entry can name a tree (plan 43)", () => {
  it("recognises a glob and a trailing-slash directory as patterns, a path as a path", () => {
    assert.equal(isSourcePattern("i18n/locales/**/*.json"), true);
    assert.equal(isSourcePattern("i18n/locales/"), true);
    assert.equal(isSourcePattern("i18n/locales/en/common.json"), false);
    assert.equal(isSourcePattern("src/a.ts"), false);
  });

  it("the two sides of a source match normalize by different rules", () => {
    // The stored side is repo data and is normalized unconditionally; the input
    // side follows the running platform. What is safe on BOTH sides everywhere is
    // a `./` or a leading slash, which names the same relative path on every
    // system — and a caller who tab-completed one must not be told nothing owns it.
    assert.equal(sourceNames("./src/gate.ts", "src/gate.ts"), true, "stored ./ is normalized");
    assert.equal(sourceNames("src/gate.ts", "./src/gate.ts"), true, "input ./ is normalized");
    assert.equal(sourceNames("src/gate.ts", "/src/gate.ts"), true, "input leading slash too");
    assert.equal(sourceNames("./i18n/locales/", "i18n/locales/en/x.json"), true, "patterns too");
    assert.equal(sourceNames("src/gate.ts", "src/other.ts"), false, "still an exact question");
  });

  it("matches through the same globber the exclusion spec uses", () => {
    const p = "i18n/locales/**/*.json";
    assert.equal(sourceNames(p, "i18n/locales/en/common.json"), true);
    assert.equal(sourceNames(p, "i18n/locales/fi/deep/nested.json"), true);
    assert.equal(sourceNames(p, "i18n/locales/en/common.ts"), false, "extension still bites");
    assert.equal(sourceNames(p, "i18n/config.json"), false, "outside the tree");
  });

  it("treats a trailing-slash directory as sugar for its whole tree", () => {
    assert.equal(sourceNames("i18n/locales/", "i18n/locales/en/common.json"), true);
    assert.equal(sourceNames("i18n/locales/", "i18n/locales/en/deep/x.json"), true);
    assert.equal(sourceNames("i18n/locales/", "i18n/localesX/en.json"), false);
  });

  it("still matches a literal path exactly, and normalizes the way storage does", () => {
    assert.equal(sourceNames("src/a.ts", "src/a.ts"), true);
    assert.equal(sourceNames("./src/a.ts", "src/a.ts"), true);
    assert.equal(sourceNames(String.raw`src\a.ts`, "src/a.ts"), true, "a Windows separator");
    assert.equal(sourceNames("src/a.ts", "src/ab.ts"), false);
  });

  it("reduces a pattern to the literal tree it is aimed at", () => {
    assert.equal(patternPrefix("dist/**"), "dist");
    assert.equal(patternPrefix("i18n/locales/**/*.json"), "i18n/locales");
    assert.equal(patternPrefix("src/foo*.ts"), "src");
    assert.equal(patternPrefix("i18n/locales/"), "i18n/locales");
    assert.equal(patternPrefix("**/*.json"), "");
  });
});

describe("the authoring guard refuses a pattern aimed where the spec already looks", () => {
  let dir: string;
  let registryPath: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "codument-pattern-"));
    registryPath = join(dir, "registry.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (sources: string[]) =>
    updateRegistryEntry(registryPath, "i18n", {
      doc: "docs/concepts/i18n.md",
      type: "concept",
      primary_sources: sources,
    });

  it("accepts a pattern over a governable tree", () => {
    const r = write(["i18n/locales/**/*.json"]);
    assert.deepEqual(r.features.i18n.primary_sources, ["i18n/locales/**/*.json"]);
  });

  it("refuses one aimed into an excluded tree", () => {
    assert.throws(() => write(["dist/**/*.json"]), /cannot be listed in primary_sources/);
    assert.throws(() => write(["node_modules/**"]), /cannot be listed in primary_sources/);
  });

  it("refuses one that just restates a rule the spec already owns", () => {
    assert.throws(() => write(["**/*.test.*"]), /cannot be listed in primary_sources/);
  });

  it("refuses a pattern in related_sources, where nothing would resolve it", () => {
    assert.throws(
      () =>
        updateRegistryEntry(registryPath, "i18n", {
          doc: "docs/concepts/i18n.md",
          type: "concept",
          primary_sources: ["src/a.ts"],
          related_sources: ["i18n/locales/**/*.json"],
        }),
      /only primary_sources resolves one/,
    );
  });

  it("still refuses a literal excluded path, and still accepts a literal source", () => {
    assert.throws(() => write(["src/a.test.ts"]), /built-in exclusion rule/);
    assert.deepEqual(write(["src/a.ts"]).features.i18n.primary_sources, ["src/a.ts"]);
  });
});
