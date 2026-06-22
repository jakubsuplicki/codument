import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFeatureMap } from "../src/lib/feature-map.js";
import { materializeFile, shapeWarnings } from "../src/commands/map.js";
import { readRegistrySync } from "../src/lib/registry.js";

const MAP_MD = `
\`\`\`feature-map
src/fairness.ts | fairness  | feature | provably-fair engine
src/board.ts    | board     | feature | canvas render
src/main.ts     | app-shell | feature | DOM wiring  [secondary: board]
\`\`\`
`;

const rows = parseFeatureMap(MAP_MD).rows;

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
