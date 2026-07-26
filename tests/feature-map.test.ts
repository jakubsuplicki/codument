import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseFeatureMap,
  routeFile,
  hasFeatureMapHeading,
  type FeatureMapRow,
} from "../src/lib/feature-map.js";

const PLINKO = `
Some prose above the block.

\`\`\`feature-map
src/fairness.ts | fairness    | feature | provably-fair seed/HMAC engine; isolated seam
src/board.ts    | board       | feature | canvas peg/slot render + ball animation
src/game.ts     | game        | feature | balance / bet / payout transaction loop
src/payouts.ts  | payouts     | concept | static multiplier tables keyed by (rows, risk)
src/store.ts    | persistence | concept | Store interface + LocalStorageStore seam
src/main.ts     | app-shell   | feature | DOM bootstrap + control wiring  [secondary: game, board]
\`\`\`

Prose below.
`;

function rowsByFeature(rows: FeatureMapRow[]): Record<string, FeatureMapRow> {
  return Object.fromEntries(rows.map((r) => [r.feature, r]));
}

describe("parseFeatureMap", () => {
  it("parses a well-formed block into rows with no errors", () => {
    const map = parseFeatureMap(PLINKO);
    assert.equal(map.errors.length, 0, JSON.stringify(map.errors));
    assert.equal(map.rows.length, 6);
    const by = rowsByFeature(map.rows);
    assert.equal(by.fairness.pathOrGlob, "src/fairness.ts");
    assert.equal(by.fairness.type, "feature");
    assert.equal(by.payouts.type, "concept");
    assert.match(by.fairness.responsibility, /provably-fair/);
  });

  it("extracts secondary features and strips them from the responsibility text", () => {
    const map = parseFeatureMap(PLINKO);
    const shell = rowsByFeature(map.rows)["app-shell"];
    assert.deepEqual(shell.secondary, ["game", "board"]);
    assert.equal(shell.responsibility, "DOM bootstrap + control wiring");
  });

  it("returns no rows and no errors when there is no feature-map block", () => {
    const map = parseFeatureMap("# Just a doc\n\nNo block here.\n");
    assert.deepEqual(map.rows, []);
    assert.deepEqual(map.errors, []);
  });

  it("flags a row without exactly four fields", () => {
    const map = parseFeatureMap("```feature-map\nsrc/x.ts | onlytwo\n```\n");
    assert.equal(map.rows.length, 0);
    assert.equal(map.errors.length, 1);
    assert.match(map.errors[0].message, /four fields|fields/i);
  });

  it("flags an invalid type and an invalid feature slug", () => {
    const bad = "```feature-map\nsrc/x.ts | x | widget | r\nsrc/y.ts | Bad_Slug | feature | r\n```\n";
    const map = parseFeatureMap(bad);
    assert.equal(map.rows.length, 0);
    assert.equal(map.errors.length, 2);
    assert.match(map.errors[0].message, /type/i);
    assert.match(map.errors[1].message, /slug|kebab/i);
  });

  it("flags a duplicate exact-path row", () => {
    const dup = "```feature-map\nsrc/x.ts | a | feature | r\nsrc/x.ts | b | feature | r\n```\n";
    const map = parseFeatureMap(dup);
    assert.equal(map.rows.length, 1);
    assert.equal(map.errors.length, 1);
    assert.match(map.errors[0].message, /duplicate/i);
  });
});

describe("routeFile", () => {
  const rows = parseFeatureMap(PLINKO).rows;

  it("routes an exact path to its primary feature and secondaries", () => {
    const r = routeFile(rows, "src/main.ts");
    assert.equal(r.feature, "app-shell");
    assert.deepEqual(r.secondary, ["game", "board"]);
    assert.equal(r.ambiguous, false);
  });

  it("returns a null feature for an unmapped file", () => {
    const r = routeFile(rows, "src/unknown.ts");
    assert.equal(r.feature, null);
    assert.equal(r.ambiguous, false);
    assert.equal(r.row, null);
  });

  it("prefers an exact path over a matching glob", () => {
    const glob: FeatureMapRow[] = [
      { pathOrGlob: "src/**", feature: "app", type: "feature", responsibility: "", secondary: [] },
      { pathOrGlob: "src/board.ts", feature: "board", type: "feature", responsibility: "", secondary: [] },
    ];
    assert.equal(routeFile(glob, "src/board.ts").feature, "board");
  });

  it("prefers the longer literal prefix among matching globs", () => {
    const glob: FeatureMapRow[] = [
      { pathOrGlob: "src/**", feature: "app", type: "feature", responsibility: "", secondary: [] },
      { pathOrGlob: "src/board/**", feature: "board", type: "feature", responsibility: "", secondary: [] },
    ];
    assert.equal(routeFile(glob, "src/board/draw.ts").feature, "board");
  });

  it("reports ambiguity when two globs tie on specificity", () => {
    const glob: FeatureMapRow[] = [
      { pathOrGlob: "src/*.ts", feature: "a", type: "feature", responsibility: "", secondary: [] },
      { pathOrGlob: "src/*.*", feature: "b", type: "feature", responsibility: "", secondary: [] },
    ];
    const r = routeFile(glob, "src/x.ts");
    assert.equal(r.ambiguous, true);
    assert.equal(r.feature, null);
  });
});

describe("hasFeatureMapHeading", () => {
  it("is true for a Feature Map heading at any level", () => {
    assert.equal(hasFeatureMapHeading("## Feature Map\n\nx"), true);
    assert.equal(hasFeatureMapHeading("### Feature Map (required when...)\n"), true);
    assert.equal(hasFeatureMapHeading("# The Feature Map\n"), true);
  });
  it("is false for prose that merely mentions a feature map (not a heading)", () => {
    assert.equal(hasFeatureMapHeading("The feature map routes files to owners."), false);
  });
  it("is false when there is no Feature Map heading at all", () => {
    assert.equal(hasFeatureMapHeading("# Plan\n\n## Steps\n- [ ] do a thing\n"), false);
  });
});

// Same accumulation problem as the delivery-plan checklist: a doc carrying one
// Feature Map per dated plan must route against the CURRENT step's map, not a
// shipped one. Taking the first block made a genuinely-declared new file report
// as unmapped, which the routing rule treats as a hard stop.
const MULTI_MAP = `
## Delivery plan — shipped effort (2026-07-14)

\`\`\`feature-map
src/old-thing.ts | legacy | feature | shipped last month
\`\`\`

## Delivery plan — current effort (2026-07-26)

\`\`\`feature-map
src/budget.ts | timing | feature | timeout chain + wall-clock budget
\`\`\`
`;

describe("parseFeatureMap across multiple map blocks", () => {
  it("routes against the newest block, not the first", () => {
    const map = parseFeatureMap(MULTI_MAP);
    assert.deepEqual(
      map.rows.map((r: FeatureMapRow) => r.pathOrGlob),
      ["src/budget.ts"],
    );
    assert.equal(map.errors.length, 0);
  });

  it("resolves a path the newest block declares", () => {
    const map = parseFeatureMap(MULTI_MAP);
    assert.equal(routeFile(map.rows, "src/budget.ts").feature, "timing");
  });

  it("still reads a single-block doc unchanged", () => {
    assert.ok(parseFeatureMap(PLINKO).rows.length > 0);
  });

  it("reports no rows when the doc has no block at all", () => {
    assert.deepEqual(parseFeatureMap("# Just prose\n\nNo map here.").rows, []);
  });
});
