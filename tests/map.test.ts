import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFeatureMap } from "../src/lib/feature-map.js";
import { mapCheck, mapMaterialize, materializeFile, materializeFileTo, shapeWarnings } from "../src/commands/map.js";
import { readRegistrySync, ExcludedSourceError } from "../src/lib/registry.js";

const MAP_MD = `
\`\`\`feature-map
src/fairness.ts | fairness  | feature | provably-fair engine
src/board.ts    | board     | feature | canvas render
src/main.ts     | app-shell | feature | DOM wiring  [secondary: board]
\`\`\`
`;

const rows = parseFeatureMap(MAP_MD).rows;
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

function captureMaterialize(options: Parameters<typeof mapMaterialize>[0]): { output: string; code: number | undefined } {
  const lines: string[] = [];
  const original = console.log;
  const exitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    console.log = (line: string) => lines.push(line);
    mapMaterialize(options);
    return { output: lines.join("\n"), code: process.exitCode };
  } finally {
    console.log = original;
    process.exitCode = exitCode;
  }
}

describe("batched map materialization", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-map-batch-"));
    await mkdir(join(root, "docs", "features"), { recursive: true });
    await writeFile(join(root, "docs", ".registry.json"), JSON.stringify({ features: {} }, null, 2));
    await writeFile(join(root, "plan.md"), MAP_MD);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("materializes every normalized unique input and makes repeated batches idempotent", async () => {
    const options = { root, plan: "plan.md", files: ["./src/fairness.ts", join(root, "src", "board.ts"), "src/fairness.ts"] };
    const first = captureMaterialize(options);
    assert.equal(first.code, undefined, first.output);
    assert.equal(first.output.split("\n").filter(line => line.includes("created")).length, 2);
    const registry = await readFile(join(root, "docs", ".registry.json"), "utf8");
    assert.deepEqual(Object.keys(JSON.parse(registry).features).sort(), ["board", "fairness"]);
    assert.equal(existsSync(join(root, "docs", "features", "board.md")), true);
    const again = captureMaterialize(options);
    assert.equal(again.code, undefined, again.output);
    assert.equal(await readFile(join(root, "docs", ".registry.json"), "utf8"), registry);
    assert.doesNotMatch(again.output, /created|added to/);
  });

  for (const invalid of ["src/unknown.ts", "src/widget.test.ts"]) {
    it(`refuses an entire mixed batch before writing when ${invalid} cannot be materialized`, async () => {
      if (invalid.endsWith(".test.ts")) await writeFile(join(root, "plan.md"), "```feature-map\nsrc/fairness.ts | fairness | feature | engine\nsrc/widget.test.ts | widget | feature | widget\n```\n");
      const before = await readFile(join(root, "docs", ".registry.json"), "utf8");
      const result = captureMaterialize({ root, plan: "plan.md", files: ["src/fairness.ts", invalid] });
      assert.equal(result.code, 1);
      assert.match(result.output, invalid.endsWith(".test.ts") ? /built-in exclusion/ : /not in the Feature Map/);
      assert.match(result.output, /no files were materialized/);
      assert.equal(await readFile(join(root, "docs", ".registry.json"), "utf8"), before);
      assert.equal(existsSync(join(root, "docs", "features", "fairness.md")), false);
    });
  }

  it("refuses tied routes and malformed map rows before any otherwise valid source is written", async () => {
    const before = await readFile(join(root, "docs", ".registry.json"), "utf8");
    await writeFile(join(root, "plan.md"), "```feature-map\nsrc/fairness.ts | fairness | feature | engine\nsrc/*.ts | one | feature | one\nsrc/*.ts | two | feature | two\n```\n");
    const tied = captureMaterialize({ root, plan: "plan.md", files: ["src/fairness.ts", "src/tied.ts"] });
    assert.equal(tied.code, 1);
    assert.match(tied.output, /ambiguously/);
    await writeFile(join(root, "plan.md"), "```feature-map\nsrc/fairness.ts | fairness | feature | engine\nsrc/bad.ts | Bad_Slug | feature | bad\n```\n");
    const malformed = captureMaterialize({ root, plan: "plan.md", files: ["src/fairness.ts"] });
    assert.equal(malformed.code, 1);
    assert.match(malformed.output, /kebab-case slug/);
    assert.equal(await readFile(join(root, "docs", ".registry.json"), "utf8"), before);
    assert.equal(existsSync(join(root, "docs", "features", "fairness.md")), false);
  });

  it("registers secondaries whose primary owner occurs later in the batch without inventing unknown owners", async () => {
    await writeFile(join(root, "plan.md"), "```feature-map\nsrc/main.ts | app-shell | feature | DOM wiring [secondary: board, missing]\nsrc/board.ts | board | feature | canvas render\n```\n");
    const result = captureMaterialize({ root, plan: "plan.md", files: ["src/main.ts", "src/board.ts"] });
    assert.equal(result.code, undefined, result.output);
    const registry = readRegistrySync(join(root, "docs", ".registry.json"));
    assert.deepEqual(registry.features.board.related_sources, ["src/main.ts"]);
    assert.equal(registry.features.missing, undefined);
    assert.match(result.output, /secondary board/);
  });

  it("validates secondary source exclusions before any primary mutation", async () => {
    await writeFile(join(root, "docs", ".registry.json"), JSON.stringify({ features: {
      legacy: { doc: "docs/features/legacy.md", primary_sources: ["src/legacy.test.ts"] },
    } }));
    await writeFile(join(root, "plan.md"), "```feature-map\nsrc/board.ts | board | feature | canvas render\nsrc/legacy.test.ts | legacy | feature | legacy [secondary: board]\n```\n");
    const before = await readFile(join(root, "docs", ".registry.json"), "utf8");
    const result = captureMaterialize({ root, plan: "plan.md", files: ["src/board.ts", "src/legacy.test.ts"] });
    assert.equal(result.code, 1);
    assert.match(result.output, /related_sources/);
    assert.equal(await readFile(join(root, "docs", ".registry.json"), "utf8"), before);
    assert.equal(existsSync(join(root, "docs", "features", "board.md")), false);
  });

  it("preserves options.file and batches the named existing-feature route", async () => {
    const single = captureMaterialize({ root, plan: "plan.md", file: "src/fairness.ts" });
    assert.equal(single.code, undefined, single.output);
    const batch = captureMaterialize({ root, feature: "fairness", files: ["src/extra.ts", "src/extra.ts", "src/last.ts"] });
    assert.equal(batch.code, undefined, batch.output);
    assert.deepEqual(readRegistrySync(join(root, "docs", ".registry.json")).features.fairness.primary_sources, ["src/extra.ts", "src/fairness.ts", "src/last.ts"]);
    const before = await readFile(join(root, "docs", ".registry.json"), "utf8");
    const unknown = captureMaterialize({ root, feature: "unknown", files: ["src/a.ts", "src/b.ts"] });
    assert.equal(unknown.code, 1);
    assert.match(unknown.output, /no registry entry named "unknown"/);
    assert.equal(await readFile(join(root, "docs", ".registry.json"), "utf8"), before);
  });

  it("reports partial I/O progress and retries the missing scaffold without duplicating ownership or replacing docs", async () => {
    await writeFile(join(root, "plan.md"), "```feature-map\nsrc/fairness.ts | fairness | feature | engine\nsrc/blocked.ts | blocked | concept | blocked contract\nsrc/board.ts | board | feature | board\n```\n");
    await writeFile(join(root, "docs", "concepts"), "directory blocker");
    const options = { root, plan: "plan.md", files: ["src/fairness.ts", "src/blocked.ts", "src/board.ts"] };
    const failure = captureMaterialize(options);
    assert.equal(failure.code, 1);
    assert.match(failure.output, /Completed primary registration: src\/fairness.ts/);
    assert.match(failure.output, /src\/blocked.ts failed during primary materialization/);
    assert.match(failure.output, /writes may already remain/);
    assert.match(failure.output, /Unattempted primary materialization: src\/board.ts/);
    assert.doesNotMatch(failure.output, /src\/blocked.ts created/);
    assert.deepEqual(Object.keys(readRegistrySync(join(root, "docs", ".registry.json")).features).sort(), ["blocked", "fairness"]);
    const durableDoc = "Existing content must survive a retry.\n";
    await writeFile(join(root, "docs", "features", "fairness.md"), durableDoc);
    await rm(join(root, "docs", "concepts"));
    const retry = captureMaterialize(options);
    assert.equal(retry.code, undefined, retry.output);
    assert.equal(await readFile(join(root, "docs", "features", "fairness.md"), "utf8"), durableDoc);
    assert.match(await readFile(join(root, "docs", "concepts", "blocked.md"), "utf8"), /blocked contract/);
    assert.deepEqual(readRegistrySync(join(root, "docs", ".registry.json")).features.blocked.primary_sources, ["src/blocked.ts"]);
  });

  it("refuses traversal, absolute outside sources and empty paths before any batch mutation", async () => {
    const before = await readFile(join(root, "docs", ".registry.json"), "utf8");
    for (const invalid of ["../outside.ts", join(dirname(root), "outside.ts"), " "]) {
      const result = captureMaterialize({ root, plan: "plan.md", files: ["src/fairness.ts", invalid] });
      assert.equal(result.code, 1, invalid);
      assert.match(result.output, /leaves project root|must name a file/);
      assert.equal(await readFile(join(root, "docs", ".registry.json"), "utf8"), before);
      assert.equal(existsSync(join(root, "docs", "features", "fairness.md")), false);
    }
  });

  it("refuses a registered doc that leaves the project on both writer routes", async () => {
    await writeFile(join(root, "docs", ".registry.json"), JSON.stringify({ features: {
      fairness: { doc: "docs/../../outside.md", primary_sources: [] },
    } }));
    const before = await readFile(join(root, "docs", ".registry.json"), "utf8");
    for (const options of [{ root, feature: "fairness", files: ["src/a.ts"] }, { root, plan: "plan.md", files: ["src/fairness.ts", "src/board.ts"] }]) {
      const result = captureMaterialize(options);
      assert.equal(result.code, 1);
      assert.match(result.output, /doc path leaves project root/);
      assert.equal(await readFile(join(root, "docs", ".registry.json"), "utf8"), before);
    }
    assert.throws(() => materializeFile(root, rows, "src/fairness.ts"), /doc path leaves project root/);
    assert.throws(() => materializeFileTo(root, "src/a.ts", "fairness"), /doc path leaves project root/);
  });

  it("refuses existing and prospective sources through an outside link and detects a dangling ancestor", async () => {
    const outside = await mkdtemp(join(tmpdir(), "codument-map-outside-"));
    const before = await readFile(join(root, "docs", ".registry.json"), "utf8");
    try {
      await writeFile(join(outside, "existing.ts"), "outside source\n");
      await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
      for (const invalid of ["linked/existing.ts", "linked/missing/child.ts"]) {
        const result = captureMaterialize({ root, plan: "plan.md", files: ["src/fairness.ts", invalid] });
        assert.equal(result.code, 1);
        assert.match(result.output, /source path resolves outside project root/);
        assert.equal(await readFile(join(root, "docs", ".registry.json"), "utf8"), before);
      }
      await rm(outside, { recursive: true, force: true });
      const dangling = captureMaterialize({ root, plan: "plan.md", files: ["src/fairness.ts", "linked/new.ts"] });
      assert.equal(dangling.code, 1);
      assert.match(dangling.output, /dangling link/);
      assert.equal(await readFile(join(root, "docs", ".registry.json"), "utf8"), before);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it("refuses scaffold destinations and registry ancestors that resolve outside the project", async () => {
    const outside = await mkdtemp(join(tmpdir(), "codument-map-outside-docs-"));
    const before = await readFile(join(root, "docs", ".registry.json"), "utf8");
    try {
      await rm(join(root, "docs", "features"), { recursive: true });
      await symlink(outside, join(root, "docs", "features"), process.platform === "win32" ? "junction" : "dir");
      const doc = captureMaterialize({ root, plan: "plan.md", files: ["src/fairness.ts", "src/board.ts"] });
      assert.equal(doc.code, 1);
      assert.match(doc.output, /doc path resolves outside project root/);
      assert.equal(await readFile(join(root, "docs", ".registry.json"), "utf8"), before);
      assert.equal(existsSync(join(outside, "fairness.md")), false);
      await rm(join(root, "docs", "features"));
      await rm(join(root, "docs"), { recursive: true });
      await writeFile(join(outside, ".registry.json"), before);
      await symlink(outside, join(root, "docs"), process.platform === "win32" ? "junction" : "dir");
      const registry = captureMaterialize({ root, plan: "plan.md", files: ["src/fairness.ts"] });
      assert.equal(registry.code, 1);
      assert.match(registry.output, /registry path resolves outside project root/);
      assert.equal(await readFile(join(outside, ".registry.json"), "utf8"), before);
      await rm(join(root, "docs"));
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it("accepts contained links and missing sources while keeping governing trees authoritative", async () => {
    await mkdir(join(root, "actual"));
    await symlink(join(root, "actual"), join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(join(root, "docs", ".registry.json"), JSON.stringify({ features: {
      tree: { doc: "docs/concepts/tree.md", type: "concept", primary_sources: ["locales/**"] },
    } }));
    await writeFile(join(root, "plan.md"), "```feature-map\nlinked/new/child.ts | child | feature | child\nlocales/** | other | feature | translations\n```\n");
    const result = captureMaterialize({ root, plan: "plan.md", files: ["linked/new/child.ts", "locales/strings.test.ts"] });
    assert.equal(result.code, undefined, result.output);
    assert.match(result.output, /already governed by.*tree/);
    const registry = readRegistrySync(join(root, "docs", ".registry.json"));
    assert.deepEqual(registry.features.tree.primary_sources, ["locales/**"]);
    assert.equal(registry.features.other, undefined);
    assert.deepEqual(registry.features.child.primary_sources, ["linked/new/child.ts"]);
  });

  it("repairs a missing registered scaffold at its custom destination through the legacy single-file writer", async () => {
    await writeFile(join(root, "docs", ".registry.json"), JSON.stringify({ features: {
      fairness: { doc: "docs/features/custom.md", primary_sources: ["src/fairness.ts"] },
    } }));
    const result = materializeFile(root, rows, "src/fairness.ts");
    assert.equal(result.status, "noop");
    assert.equal(result.docPath, "docs/features/custom.md");
    assert.match(await readFile(join(root, "docs", "features", "custom.md"), "utf8"), /provably-fair engine/);
    assert.equal(existsSync(join(root, "docs", "features", "fairness.md")), false);
  });

  it("rejects a doc destination directory before any batch or single-file writer mutates ownership", async () => {
    await mkdir(join(root, "docs", "features", "board.md"));
    const before = await readFile(join(root, "docs", ".registry.json"), "utf8");
    const result = captureMaterialize({ root, plan: "plan.md", files: ["src/fairness.ts", "src/board.ts"] });
    assert.equal(result.code, 1);
    assert.match(result.output, /doc path must resolve to a regular file/);
    assert.equal(await readFile(join(root, "docs", ".registry.json"), "utf8"), before);
    assert.equal(existsSync(join(root, "docs", "features", "fairness.md")), false);
    assert.throws(() => materializeFile(root, rows, "src/board.ts"), /doc path must resolve to a regular file/);
    assert.equal(await readFile(join(root, "docs", ".registry.json"), "utf8"), before);
  });

  it("rejects an existing directory as a concrete source while accepting a planned missing file", async () => {
    await mkdir(join(root, "src", "board.ts"), { recursive: true });
    const before = await readFile(join(root, "docs", ".registry.json"), "utf8");
    const result = captureMaterialize({ root, plan: "plan.md", files: ["src/fairness.ts", "src/board.ts"] });
    assert.equal(result.code, 1);
    assert.match(result.output, /source path must resolve to a regular file/);
    assert.equal(await readFile(join(root, "docs", ".registry.json"), "utf8"), before);
    assert.throws(() => materializeFile(root, rows, "src/board.ts"), /source path must resolve to a regular file/);
    assert.equal(materializeFile(root, rows, "src/fairness.ts").status, "created");
    assert.throws(() => materializeFileTo(root, "src/board.ts", "fairness"), /source path must resolve to a regular file/);
  });

  it("accepts variadic and single-file CLI calls and refuses a mixed invalid CLI batch without writes", async () => {
    const run = (...files: string[]) => execFileSync(process.execPath, [CLI, "map", "materialize", ...files, "--plan", "plan.md"], {
      cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" },
    });
    const batch = run("src/main.ts", "src/board.ts");
    assert.match(batch, /src\/main.ts created/);
    assert.match(batch, /src\/board.ts created/);
    assert.deepEqual(readRegistrySync(join(root, "docs", ".registry.json")).features.board.related_sources, ["src/main.ts"]);
    assert.match(run("src/main.ts"), /already in/);
    const before = await readFile(join(root, "docs", ".registry.json"), "utf8");
    assert.throws(() => run("src/fairness.ts", "src/unknown.ts"), (error: unknown) => {
      const result = error as { status?: number; stdout?: string };
      return result.status === 1 && /not in the Feature Map/.test(result.stdout ?? "");
    });
    assert.equal(await readFile(join(root, "docs", ".registry.json"), "utf8"), before);
    assert.equal(existsSync(join(root, "docs", "features", "fairness.md")), false);
  });
});

describe("map check source exclusions", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "codument-map-check-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  for (const path of ["src/widget.test.ts", "src/**/*.test.ts", "__tests__/*.ts", "generated/widget.ts"]) {
    it(`rejects ${path} before materialization`, async () => {
      await writeFile(join(root, "plan.md"), `\`\`\`feature-map\n${path} | widget | feature | Widget behavior\n\`\`\`\n`);
      await writeFile(join(root, ".codument-meta.json"), JSON.stringify({ exclude: { dirs: ["generated"] } }));
      const lines: string[] = [];
      const original = console.log;
      const exitCode = process.exitCode;
      try {
        console.log = (line: string) => lines.push(line);
        mapCheck({root, plan: "plan.md", json: true});
        const result = JSON.parse(lines.join("\n"));
        assert.equal(result.ok, false);
        assert.equal(process.exitCode, 1);
        assert.match(result.errors[0].message, /exclude|exclusion|out-of-scope/);
        assert.equal(result.errors[0].path, path);
      } finally { console.log = original; process.exitCode = exitCode; }
    });
  }

  it("accepts a mixed source glob without treating its excluded descendants as sources", async () => {
    await writeFile(join(root, "plan.md"), "```feature-map\nsrc/**/*.ts | widget | feature | Widget behavior\n```\n");
    await writeFile(join(root, ".codument-meta.json"), JSON.stringify({exclude: {globs: ["src/*/*.ts"]}}));
    const original = console.log;
    const exitCode = process.exitCode;
    try {
      let result: {ok?: boolean} = {};
      console.log = (line: string) => { result = JSON.parse(line); };
      mapCheck({root, plan: "plan.md", json: true});
      assert.equal(result.ok, true);
    } finally { console.log = original; process.exitCode = exitCode; }
  });

  it("accepts recursive patterns that can cross a test-like segment into real source", async () => {
    await writeFile(join(root, "plan.md"), "```feature-map\nsrc/**/test_**.py | widget | feature | Widget behavior\n```\n");
    const original = console.log;
    const exitCode = process.exitCode;
    try {
      let result: {ok?: boolean} = {};
      console.log = (line: string) => { result = JSON.parse(line); };
      mapCheck({root, plan: "plan.md", json: true});
      assert.equal(result.ok, true);
      const map = parseFeatureMap(await readFile(join(root, "plan.md"), "utf8"));
      await mkdir(join(root, "docs"), {recursive: true});
      assert.equal(materializeFile(root, map.rows, "src/app/test_helpers/format.py").status, "created");
    } finally { console.log = original; process.exitCode = exitCode; }
  });
});

describe("materializeFile", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-map-"));
    await mkdir(join(root, "docs", "features"), { recursive: true });
    await writeFile(join(root, "docs", ".registry.json"), JSON.stringify({ features: {} }, null, 2));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates a new feature entry + a scaffold doc seeded from the responsibility", async () => {
    const r = materializeFile(root, rows, "src/fairness.ts");
    assert.equal(r.status, "created");
    assert.equal(r.feature, "fairness");

    const reg = readRegistrySync(join(root, "docs", ".registry.json"));
    assert.ok(reg.features.fairness, "entry created");
    assert.deepEqual(reg.features.fairness.primary_sources, ["src/fairness.ts"]);
    assert.equal(reg.features.fairness.status, "needs-review");
    assert.equal(reg.features.fairness.type, "feature");

    const doc = await readFile(join(root, "docs", "features", "fairness.md"), "utf-8");
    assert.match(doc, /provably-fair engine/, "In plain terms seeded from responsibility");
    assert.match(doc, /status: needs-review/);
  });

  it("is idempotent — a second run on the same file is a noop", () => {
    materializeFile(root, rows, "src/fairness.ts");
    const again = materializeFile(root, rows, "src/fairness.ts");
    assert.equal(again.status, "noop");
    const reg = readRegistrySync(join(root, "docs", ".registry.json"));
    assert.deepEqual(reg.features.fairness.primary_sources, ["src/fairness.ts"]);
  });

  it("appends a second owned file to an existing feature", () => {
    // Two files mapped to the same feature would need a glob row; simulate by
    // re-routing board.ts then a hand-added second primary via the same key.
    materializeFile(root, rows, "src/board.ts");
    const twoFileRows = parseFeatureMap(
      "```feature-map\nsrc/board.ts | board | feature | r\nsrc/board-extra.ts | board | feature | r\n```\n",
    ).rows;
    const r = materializeFile(root, twoFileRows, "src/board-extra.ts");
    assert.equal(r.status, "updated");
    const reg = readRegistrySync(join(root, "docs", ".registry.json"));
    assert.deepEqual(reg.features.board.primary_sources.sort(), ["src/board-extra.ts", "src/board.ts"]);
  });

  it("routes a secondary feature into the secondary's related_sources (when it exists)", () => {
    materializeFile(root, rows, "src/board.ts"); // board now exists
    const r = materializeFile(root, rows, "src/main.ts");
    assert.equal(r.feature, "app-shell");
    assert.deepEqual(r.secondaryUpdated, ["board"]);
    const reg = readRegistrySync(join(root, "docs", ".registry.json"));
    assert.ok(reg.features.board.related_sources.includes("src/main.ts"));
  });

  it("does not write an unmapped file", () => {
    const r = materializeFile(root, rows, "src/unknown.ts");
    assert.equal(r.status, "unmapped");
    assert.equal(r.feature, null);
    const reg = readRegistrySync(join(root, "docs", ".registry.json"));
    assert.deepEqual(Object.keys(reg.features), []);
    assert.equal(existsSync(join(root, "docs", "features", "unknown.md")), false);
  });

  // ADVERSARIAL REVIEW FINDING (confirmed): registry.ts's new authoring guard
  // (Step 2) can now make `updateRegistryEntry` throw for a brand-new feature
  // key. `materializeFile`'s "create" branch writes the doc scaffold to disk
  // BEFORE calling `updateRegistryEntry` and has no rollback, so a refused
  // first-time file leaves an orphaned, unregistered doc scaffold behind — a
  // new-feature doc with no registry entry, and no clean way to detect it was
  // never actually adopted. This is a genuine sibling-caller regression: the
  // guard change in registry.ts fixed the write seam but exposed an unguarded
  // ordering bug in this existing (unchanged) caller.
  it("does not leave an orphaned doc scaffold when materializing a brand-new feature's excluded first file", () => {
    const excludedRows = parseFeatureMap(
      "```feature-map\nsrc/thing.test.js | thing | feature | r\n```\n",
    ).rows;

    assert.throws(() => materializeFile(root, excludedRows, "src/thing.test.js"));

    // Refused entries should leave no trace: no registry entry (true today)
    // AND no stray scaffold doc for a feature that doesn't exist (false today).
    const reg = readRegistrySync(join(root, "docs", ".registry.json"));
    assert.deepEqual(Object.keys(reg.features), []);
    assert.equal(existsSync(join(root, "docs", "features", "thing.md")), false);
  });
});

// Naming WHICH rule fired. A project's own declaration and a built-in heuristic
// call for different responses — "un-map it or narrow your declaration" versus
// "codument's guess may be wrong about your file" — and one generic refusal
// sends both to the same dead end.
// Plan 41: a plan's Feature Map is compacted out of its doc when the work ships
// (the standard requires it), which left every LATER file addition or rename on a
// refusal pointing at a plan that no longer carries a Map — two mandated behaviors
// disabling each other, with a hand-edited registry as the only way out.
describe("materializeFileTo (the post-ship route)", () => {
  let root: string;
  const registry = {
    features: {
      i18n: {
        doc: "docs/features/i18n.md",
        type: "feature",
        primary_sources: ["i18n/index.ts"],
        related_sources: [],
        docs: [],
        depends_on: [],
        risk: [],
        status: "current",
      },
    },
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-map2-"));
    await mkdir(join(root, "docs", "features"), { recursive: true });
    await writeFile(join(root, "docs", ".registry.json"), JSON.stringify(registry, null, 2));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("adds the file to a named existing feature, with no plan in the loop", () => {
    const r = materializeFileTo(root, "i18n/dateFormat.ts", "i18n");
    assert.equal(r.status, "updated");
    assert.equal(r.feature, "i18n");
    assert.deepEqual(readRegistrySync(join(root, "docs", ".registry.json")).features.i18n.primary_sources, [
      "i18n/dateFormat.ts",
      "i18n/index.ts",
    ]);
  });

  // Plan 36: the moment a second feature claims a file is the moment the churn is
  // created — from then on every edit wakes both docs until the registry says who
  // owns what. It used to pass in silence, so the bill only arrived later, at a red
  // gate, in front of someone who did not know a second claim had been added.
  describe("the second primary claim is where the churn starts, so it says so", () => {
    const claim = (key: string, patch: Record<string, unknown> = {}) => ({
      doc: `docs/features/${key}.md`,
      type: "feature",
      primary_sources: [],
      related_sources: [],
      docs: [],
      depends_on: [],
      risk: [],
      status: "current",
      ...patch,
    });
    const write = async (features: Record<string, unknown>): Promise<void> => {
      await writeFile(
        join(root, "docs", ".registry.json"),
        JSON.stringify({ features }, null, 2),
      );
    };

    it("warns naming every owner once a second feature claims the file", async () => {
      await write({
        cart: claim("cart", { primary_sources: ["src/shared.ts"] }),
        checkout: claim("checkout"),
      });
      const r = materializeFileTo(root, "src/shared.ts", "checkout");
      assert.equal(r.status, "updated");
      assert.deepEqual(r.sharedPrimary, ["cart", "checkout"]);
    });

    it("stays silent on the FIRST claim — one owner is the resolved state", async () => {
      await write({ cart: claim("cart"), checkout: claim("checkout") });
      assert.deepEqual(materializeFileTo(root, "src/solo.ts", "cart").sharedPrimary, []);
    });

    it("stays silent when the split is already authored", async () => {
      // A deliberate multi-owner file whose symbols are claimed is not churn — it
      // is exactly the fix the warning asks for, so warning about it would train
      // the reader to ignore the one case that matters.
      await write({
        cart: claim("cart", {
          primary_sources: ["src/shared.ts"],
          owned_symbols: { "src/shared.ts": ["priceOf()."] },
        }),
        checkout: claim("checkout"),
      });
      assert.deepEqual(materializeFileTo(root, "src/shared.ts", "checkout").sharedPrimary, []);
    });

    it("does not count a concept umbrella as a competing owner", async () => {
      // A concept co-documents at file grain and never fragments per-symbol
      // ownership, so a file owned by one feature plus any number of umbrellas
      // still resolves derived — no churn, nothing to warn about.
      await write({
        cart: claim("cart"),
        lib: { ...claim("lib"), type: "concept", primary_sources: ["src/shared.ts"] },
      });
      assert.deepEqual(materializeFileTo(root, "src/shared.ts", "cart").sharedPrimary, []);
    });
  });

  it("is idempotent — a file already owned is a noop, never a duplicate", () => {
    assert.equal(materializeFileTo(root, "i18n/index.ts", "i18n").status, "noop");
    assert.deepEqual(readRegistrySync(join(root, "docs", ".registry.json")).features.i18n.primary_sources, [
      "i18n/index.ts",
    ]);
  });

  it("refuses an unknown slug rather than inventing a feature", () => {
    // Creating one needs a responsibility line to seed its doc — exactly what a
    // Map row carries and a bare flag cannot. New features are new work, and new
    // work gets a plan.
    const r = materializeFileTo(root, "src/x.ts", "nope");
    assert.equal(r.status, "unknown-feature");
    assert.equal(r.feature, null);
    assert.deepEqual(Object.keys(readRegistrySync(join(root, "docs", ".registry.json")).features), [
      "i18n",
    ]);
  });

  it("still refuses an excluded path — the explicit route is not a way around scope", () => {
    assert.throws(
      () => materializeFileTo(root, "dist/bundle.js", "i18n"),
      ExcludedSourceError,
    );
  });
});

describe("materializeFile names the rule that refused a path", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-map-rule-"));
    await mkdir(join(root, "docs", "features"), { recursive: true });
    await writeFile(join(root, "docs", ".registry.json"), JSON.stringify({ features: {} }, null, 2));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const excludedRows = parseFeatureMap(
    "```feature-map\nsrc/thing.test.js | thing | feature | r\nout/bundle.ts | bundled | feature | r\n```\n",
  ).rows;

  it("cites the built-in rule when no project declaration covers the path", () => {
    assert.throws(
      () => materializeFile(root, excludedRows, "src/thing.test.js"),
      (err: unknown) =>
        err instanceof ExcludedSourceError &&
        err.rule === null &&
        /built-in/.test(err.message),
    );
  });

  it("cites the project's own exclude rule when its declaration is what covers the path", async () => {
    await writeFile(
      join(root, ".codument-meta.json"),
      JSON.stringify({ exclude: { dirs: ["out"] } }, null, 2),
    );

    assert.throws(
      () => materializeFile(root, excludedRows, "out/bundle.ts"),
      (err: unknown) =>
        err instanceof ExcludedSourceError &&
        err.rule === "dirs: out" &&
        /project's own/.test(err.message),
    );
  });

  // The functional half: before this, materialize passed no spec, so ONLY the
  // built-in defaults reached the authoring guard and a project's own declared
  // exclusions were silently authorable.
  it("enforces a project declaration the built-in spec would have allowed", async () => {
    const declaredRows = parseFeatureMap(
      "```feature-map\npublic-preprod/app.ts | site | feature | r\n```\n",
    ).rows;

    // Without the declaration the path is ordinary source and materializes fine.
    assert.equal(materializeFile(root, declaredRows, "public-preprod/app.ts").status, "created");

    await rm(join(root, "docs", ".registry.json"));
    await writeFile(join(root, "docs", ".registry.json"), JSON.stringify({ features: {} }, null, 2));
    await writeFile(
      join(root, ".codument-meta.json"),
      JSON.stringify({ exclude: { dirs: ["public-preprod"] } }, null, 2),
    );

    assert.throws(
      () => materializeFile(root, declaredRows, "public-preprod/app.ts"),
      (err: unknown) => err instanceof ExcludedSourceError,
    );
  });

  // ADVERSARIAL REVIEW FINDING (confirmed, Step 3): `register()` in map.ts
  // enriches a refusal by calling `declaredRuleFor(err.path, scope.configured)`
  // — but `err.path` is the RAW, as-typed source string `assertNoExcludedSource`
  // was given (registry.ts throws with `source`, not the normalized `stored`
  // path it actually tested exclusion against). `declaredRuleFor` normalizes
  // only via `toPosix` (separator swap), never `normalizeRelPath` (which also
  // strips a leading "./"), so a source whose text carries a leading "./" —
  // a plausible Feature Map authoring style, and legal input to the exported,
  // directly-tested `materializeFile` — is genuinely excluded by the project's
  // OWN declared glob (confirmed: `isExcluded` matches on the normalized form),
  // yet `declaredRuleFor`'s glob regex is anchored (`^pattern$`) and does not
  // match the unnormalized "./..." string, so it returns null and the refusal
  // is misattributed to "a built-in exclusion rule" — an actively false claim
  // that sends the user down the wrong remediation path ("codument's guess may
  // be wrong about your file" instead of "un-map it, or narrow the
  // declaration"). This is worse than naming neither rule: it names the wrong
  // one. Root cause: `register()` (map.ts) hands the unnormalized `err.path`
  // to `declaredRuleFor` instead of the normalized form the exclusion check
  // itself used.
  it("does not misattribute a project-declared glob exclusion as built-in when the source path carries a leading './'", () => {
    // Both the Map row and the materialized file carry the same leading "./"
    // (either an authoring convention in the plan doc, or a caller of the
    // exported materializeFile() that does not pre-normalize like the CLI's
    // toRepoRel() does) so exact-path routing still resolves to a real row.
    const dotSlashRows = parseFeatureMap(
      "```feature-map\n./public-preprod/app.ts | site | feature | r\n```\n",
    ).rows;

    return writeFile(
      join(root, ".codument-meta.json"),
      JSON.stringify({ exclude: { globs: ["public-preprod/**"] } }, null, 2),
    ).then(() => {
      assert.throws(
        () => materializeFile(root, dotSlashRows, "./public-preprod/app.ts"),
        (err: unknown) => {
          assert.ok(err instanceof ExcludedSourceError, `expected ExcludedSourceError, got ${err}`);
          // The project's own declared glob is genuinely what covers this path;
          // the refusal must say so, not blame a generic built-in heuristic.
          assert.equal(
            (err as ExcludedSourceError).rule,
            "globs: public-preprod/**",
            `expected attribution to the project's own declared glob, got rule=${
              (err as ExcludedSourceError).rule
            } message=${(err as ExcludedSourceError).message}`,
          );
          assert.ok(/project's own/.test((err as ExcludedSourceError).message));
          return true;
        },
      );
    });
  });
});

describe("shapeWarnings", () => {
  it("flags a single-row Feature Map", () => {
    const w = shapeWarnings(parseFeatureMap("```feature-map\nsrc/** | app | feature | the app\n```\n"));
    assert.ok(w.some((x) => /single row/.test(x.message)));
    assert.ok(w.some((x) => /umbrella glob/.test(x.message)));
  });

  it("is quiet on a well-decomposed Map", () => {
    assert.deepEqual(shapeWarnings(parseFeatureMap(MAP_MD)), []);
  });
});

// Plan 43 step 4: registering a tree is what makes the per-file line unnecessary.
// Materializing a file the tree already covers would grow those lines back one
// accidental call at a time — and the refusal is the only moment anyone learns the
// registration is doing its job.
describe("materialize refuses a file a tree already governs (plan 43)", () => {
  let root: string;
  const TREE = "i18n/locales/**/*.json";
  const FILE = "i18n/locales/fi/common.json";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-map-tree-"));
    await mkdir(join(root, "docs", "concepts"), { recursive: true });
    await writeFile(
      join(root, "docs", ".registry.json"),
      JSON.stringify(
        {
          features: {
            i18n: {
              doc: "docs/concepts/i18n.md",
              type: "concept",
              primary_sources: [TREE],
              status: "current",
            },
            other: {
              doc: "docs/concepts/other.md",
              type: "concept",
              primary_sources: ["src/other.ts"],
              status: "current",
            },
          },
        },
        null,
        2,
      ),
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const sources = (key: string): string[] =>
    readRegistrySync(join(root, "docs", ".registry.json")).features[key].primary_sources;

  it("names the governing entry and writes nothing, on the explicit route", () => {
    const r = materializeFileTo(root, FILE, "other");
    assert.equal(r.status, "governed");
    assert.deepEqual(r.governedBy, { feature: "i18n", pattern: TREE });
    assert.deepEqual(sources("other"), ["src/other.ts"], "no second claim was written");
    assert.deepEqual(sources("i18n"), [TREE], "and the tree did not grow a path");
  });

  it("refuses the tree's OWN entry too — the line would only restate the pattern", () => {
    const r = materializeFileTo(root, FILE, "i18n");
    assert.equal(r.status, "governed");
    assert.deepEqual(sources("i18n"), [TREE]);
  });

  it("refuses on the Map route as well, before any write", () => {
    const mapRows = parseFeatureMap(
      "```feature-map\ni18n/locales/** | i18n | concept | translations\n```",
    ).rows;
    const r = materializeFile(root, mapRows, FILE);
    assert.equal(r.status, "governed");
    assert.deepEqual(r.governedBy, { feature: "i18n", pattern: TREE });
    assert.deepEqual(sources("i18n"), [TREE]);
  });

  it("a file OUTSIDE the tree materializes normally", () => {
    const r = materializeFileTo(root, "src/elsewhere.ts", "other");
    assert.equal(r.status, "updated");
    assert.deepEqual(sources("other").sort(), ["src/elsewhere.ts", "src/other.ts"]);
  });
});
