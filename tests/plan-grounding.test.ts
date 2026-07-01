import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlanGrounding, gatherPlanGrounding } from "../src/lib/plan-grounding.js";
import { parseFeatureMap } from "../src/lib/feature-map.js";
import { readRegistrySync } from "../src/lib/registry.js";
import type { Registry, RegistryEntry } from "../src/lib/registry.js";
import type { FeatureMapRow } from "../src/lib/feature-map.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");

const DOC_A = `# Feature A

## In plain terms

A owns the ledger.

## Invariants & boundaries

- **A never loses data.** *(test: a-core.test.ts)*
- **A stays pure.** *(test: a-core.test.ts and a-edge.test.ts)*

## Key files
- src/a.ts
`;

const DOC_C = `# Feature C

## Invariants & boundaries

- **C is append-only.** *(test: c.test.ts)*
`;

function entry(partial: Partial<RegistryEntry>): RegistryEntry {
  return {
    doc: "",
    type: "feature",
    primary_sources: [],
    related_sources: [],
    docs: [],
    depends_on: [],
    risk: [],
    status: "current",
    ...partial,
  };
}

function row(partial: Partial<FeatureMapRow>): FeatureMapRow {
  return {
    pathOrGlob: "src/x.ts",
    feature: "a",
    type: "feature",
    responsibility: "",
    secondary: [],
    ...partial,
  };
}

// a is routed and depends on c (a dependency, not itself routed); b is routed via
// a secondary and has no doc content; c depends back on a (already routed → not
// re-added as a dependency of itself).
const registry: Registry = {
  features: {
    a: entry({ doc: "docs/features/a.md", depends_on: ["c"], risk: ["data-loss"] }),
    b: entry({ doc: "docs/features/b.md" }),
    c: entry({ doc: "docs/features/c.md", depends_on: ["a"] }),
  },
};

const docContents = new Map<string, string>([
  ["docs/features/a.md", DOC_A],
  ["docs/features/c.md", DOC_C],
  // b intentionally has no doc content → empty invariants
]);

describe("buildPlanGrounding", () => {
  it("grounds every routed feature (primary + secondary) with its invariants, tests, deps, and risk", () => {
    const g = buildPlanGrounding({
      rows: [row({ feature: "a", secondary: ["b"] })],
      registry,
      docContents,
    });

    const a = g.features.find((f) => f.feature === "a");
    assert.ok(a);
    assert.equal(a.relation, "routed");
    assert.match(a.invariants, /never loses data/);
    assert.deepEqual(a.testPointers, ["a-core.test.ts", "a-edge.test.ts"]);
    assert.deepEqual(a.dependsOn, ["c"]);
    assert.deepEqual(a.risk, ["data-loss"]);

    const b = g.features.find((f) => f.feature === "b");
    assert.ok(b);
    assert.equal(b.relation, "routed");
    // no doc content → empty invariants and no test pointers, never a throw
    assert.equal(b.invariants, "");
    assert.deepEqual(b.testPointers, []);
  });

  it("pulls one-hop depends_on edges in as dependency grounding, but never a routed feature", () => {
    const g = buildPlanGrounding({
      rows: [row({ feature: "a", secondary: ["b"] })],
      registry,
      docContents,
    });

    const c = g.features.find((f) => f.feature === "c");
    assert.ok(c, "c is a's dependency and should be grounded");
    assert.equal(c.relation, "dependency");
    assert.match(c.invariants, /append-only/);

    // c.depends_on = [a], but a is routed, so a is never demoted to a dependency
    // entry — every routed feature stays routed.
    assert.equal(g.features.filter((f) => f.feature === "a").length, 1);
    assert.equal(g.features.find((f) => f.feature === "a")?.relation, "routed");
  });

  it("reports a Map slug the registry does not know as unknown, not as grounding", () => {
    const g = buildPlanGrounding({
      rows: [row({ feature: "a" }), row({ pathOrGlob: "src/z.ts", feature: "z" })],
      registry,
      docContents,
    });

    assert.deepEqual(g.unknownFeatures, ["z"]);
    assert.equal(g.features.some((f) => f.feature === "z"), false);
  });

  it("is order-independent: routed features first (sorted), then dependencies (sorted)", () => {
    const forward = buildPlanGrounding({
      rows: [row({ feature: "a", secondary: ["b"] })],
      registry,
      docContents,
    });
    const reversed = buildPlanGrounding({
      rows: [row({ pathOrGlob: "src/b.ts", feature: "b" }), row({ feature: "a" })],
      registry,
      docContents,
    });

    // Both name {a, b} routed + {c} dependency; the emitted order is identical.
    assert.deepEqual(
      forward.features.map((f) => `${f.relation}:${f.feature}`),
      ["routed:a", "routed:b", "dependency:c"],
    );
    assert.deepEqual(
      reversed.features.map((f) => `${f.relation}:${f.feature}`),
      ["routed:a", "routed:b", "dependency:c"],
    );
  });

  it("adds no new source of truth: with empty doc contents, invariants are empty but the feature set is unchanged", () => {
    const g = buildPlanGrounding({
      rows: [row({ feature: "a", secondary: ["b"] })],
      registry,
      docContents: new Map(),
    });
    assert.deepEqual(
      g.features.map((f) => f.feature),
      ["a", "b", "c"],
    );
    assert.ok(g.features.every((f) => f.invariants === "" && f.testPointers.length === 0));
    // registry facts (deps, risk) survive even with no doc prose
    assert.deepEqual(g.features.find((f) => f.feature === "a")?.risk, ["data-loss"]);
  });
});

// ── The impure read path + the CLI wiring ───────────────────────────────────

const LEDGER_DOC = `# Ledger

## Invariants & boundaries

- **The ledger is append-only.** *(test: ledger.test.ts)*
`;

const PLAN_MD = `# New thing

## Delivery plan

\`\`\`feature-map
src/new.ts | ledger | feature | extends the append-only ledger
\`\`\`
`;

describe("gatherPlanGrounding (reads docs off disk)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "codument-ground-"));
    await mkdir(join(root, "docs", "features"), { recursive: true });
    await writeFile(
      join(root, "docs", ".registry.json"),
      JSON.stringify(
        {
          features: {
            ledger: {
              doc: "docs/features/ledger.md",
              type: "feature",
              primary_sources: ["src/ledger.ts"],
              related_sources: [],
              docs: [],
              depends_on: [],
              risk: ["data-loss"],
              status: "current",
            },
          },
        },
        null,
        2,
      ),
    );
    await writeFile(join(root, "docs", "features", "ledger.md"), LEDGER_DOC);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("projects a routed feature's committed invariants, tests, and risk read from disk", () => {
    const rows = parseFeatureMap(PLAN_MD).rows;
    const registry = readRegistrySync(join(root, "docs", ".registry.json"));
    const g = gatherPlanGrounding(root, rows, registry);
    const ledger = g.features.find((f) => f.feature === "ledger");
    assert.ok(ledger);
    assert.match(ledger.invariants, /append-only/);
    assert.deepEqual(ledger.testPointers, ["ledger.test.ts"]);
    assert.deepEqual(ledger.risk, ["data-loss"]);
  });

  it("map check --plan --json emits the grounding as the adversary's oracle", () => {
    const planPath = join(root, "docs", "features", "new-thing.md");
    writeFileSync(planPath, PLAN_MD);
    const out = execFileSync(
      "node",
      [CLI, "map", "check", "--plan", planPath, "--json", "--root", root],
      { encoding: "utf-8" },
    );
    const report = JSON.parse(out);
    assert.equal(report.ok, true);
    assert.equal(report.hasMap, true);
    const ledger = report.grounding.features.find((f: { feature: string }) => f.feature === "ledger");
    assert.ok(ledger, "grounding names the routed feature");
    assert.match(ledger.invariants, /append-only/);
    assert.deepEqual(ledger.risk, ["data-loss"]);
  });

  it("map check --plan --json reports no grounding when the plan carries no Feature Map", () => {
    const planPath = join(root, "docs", "features", "no-map.md");
    writeFileSync(planPath, "# No map plan\n\nJust prose, no feature-map block.\n");
    let out = "";
    try {
      out = execFileSync(
        "node",
        [CLI, "map", "check", "--plan", planPath, "--json", "--root", root],
        { encoding: "utf-8" },
      );
    } catch (e) {
      // no map block → exit 1, but the JSON report is still emitted on stdout
      out = (e as { stdout?: string }).stdout ?? "";
    }
    const report = JSON.parse(out);
    assert.equal(report.hasMap, false);
    assert.equal(report.ok, false);
    assert.equal(report.malformedMap, false); // no Feature Map heading → genuinely source-free, skip is fine
    assert.deepEqual(report.grounding.features, []);
  });

  it("map check --plan --json flags a Feature Map heading with no parseable block (malformedMap)", () => {
    const planPath = join(root, "docs", "features", "table-map.md");
    // A "Feature Map" heading but the routing table written as markdown, not a
    // fenced ```feature-map``` block — parses to nothing, so the adversary would
    // silently skip. This must be flagged, not treated as source-free.
    writeFileSync(
      planPath,
      "# Table map plan\n\n## Feature Map\n\n| File | Feature |\n|---|---|\n| src/new.ts | ledger |\n",
    );
    let out = "";
    let exitCode = 0;
    try {
      out = execFileSync(
        "node",
        [CLI, "map", "check", "--plan", planPath, "--json", "--root", root],
        { encoding: "utf-8" },
      );
    } catch (e) {
      out = (e as { stdout?: string }).stdout ?? "";
      exitCode = (e as { status?: number }).status ?? 1;
    }
    const report = JSON.parse(out);
    assert.equal(report.hasMap, false);
    assert.equal(report.malformedMap, true);
    assert.equal(exitCode, 1); // a broken Map is blocking, not silently skipped
  });
});
