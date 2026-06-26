import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveOwner, splitAnchorId } from "../src/lib/ownership.js";
import { normalizeRegistry } from "../src/lib/registry.js";

function reg(features: Record<string, unknown>) {
  return normalizeRegistry({ features });
}

describe("splitAnchorId", () => {
  it("splits on the first ::, leaving the descriptor intact", () => {
    assert.deepStrictEqual(splitAnchorId("src/cli.ts::reviewCommand()."), {
      path: "src/cli.ts",
      descriptor: "reviewCommand().",
    });
  });
  it("treats an id with no :: as a bare path", () => {
    assert.deepStrictEqual(splitAnchorId("src/x.ts"), {
      path: "src/x.ts",
      descriptor: "",
    });
  });
});

describe("resolveOwner — derived-first", () => {
  it("a single-owner file: every symbol is owned by that feature (zero authoring)", () => {
    const r = reg({
      alpha: { doc: "docs/features/alpha.md", primary_sources: ["src/a.ts"] },
    });
    assert.deepStrictEqual(resolveOwner(r, "src/a.ts::foo()."), {
      kind: "owned",
      feature: "alpha",
    });
    // including the residual <module> backstop
    assert.deepStrictEqual(resolveOwner(r, "src/a.ts::<module>"), {
      kind: "owned",
      feature: "alpha",
    });
  });

  it("a file in no feature's primary_sources is unowned", () => {
    const r = reg({
      alpha: { doc: "docs/features/alpha.md", primary_sources: ["src/a.ts"] },
    });
    assert.deepStrictEqual(resolveOwner(r, "src/orphan.ts::foo()."), {
      kind: "unowned",
    });
  });

  it("related_sources membership does NOT confer ownership", () => {
    const r = reg({
      alpha: {
        doc: "docs/features/alpha.md",
        primary_sources: ["src/a.ts"],
        related_sources: ["src/shared.ts"],
      },
    });
    assert.deepStrictEqual(resolveOwner(r, "src/shared.ts::foo()."), {
      kind: "unowned",
    });
  });

  it("a concept umbrella co-owner does NOT fragment ownership (still derived)", () => {
    // one feature + the `lib` concept both list the file -> the feature owns it
    // per-symbol; the concept is a file-grain umbrella handled by the wiring.
    const r = reg({
      "token-cost-tracking": {
        doc: "docs/features/token-cost-tracking.md",
        type: "feature",
        primary_sources: ["src/lib/token-cost.ts"],
      },
      lib: {
        doc: "docs/concepts/lib.md",
        type: "concept",
        primary_sources: ["src/lib/token-cost.ts"],
      },
    });
    assert.deepStrictEqual(resolveOwner(r, "src/lib/token-cost.ts::costOf()."), {
      kind: "owned",
      feature: "token-cost-tracking",
    });
  });

  it("a file owned ONLY by a concept is unowned per-symbol (umbrella handles it)", () => {
    const r = reg({
      lib: {
        doc: "docs/concepts/lib.md",
        type: "concept",
        primary_sources: ["src/lib/markers.ts"],
      },
    });
    assert.deepStrictEqual(resolveOwner(r, "src/lib/markers.ts::foo()."), {
      kind: "unowned",
    });
  });
});

describe("resolveOwner — shared file, per-symbol owner map", () => {
  const shared = {
    alpha: {
      doc: "docs/features/alpha.md",
      primary_sources: ["src/cli.ts"],
      owned_symbols: { "src/cli.ts": ["alphaCmd()."] },
    },
    beta: {
      doc: "docs/features/beta.md",
      primary_sources: ["src/cli.ts"],
      owned_symbols: { "src/cli.ts": ["betaCmd()."] },
    },
  };

  it("routes a claimed symbol to exactly its owner (cascade dissolved)", () => {
    const r = reg(shared);
    assert.deepStrictEqual(resolveOwner(r, "src/cli.ts::alphaCmd()."), {
      kind: "owned",
      feature: "alpha",
    });
    assert.deepStrictEqual(resolveOwner(r, "src/cli.ts::betaCmd()."), {
      kind: "owned",
      feature: "beta",
    });
  });

  it("a symbol no co-owner claims is unassigned (fail-loud, never wakes all)", () => {
    const r = reg(shared);
    assert.deepStrictEqual(resolveOwner(r, "src/cli.ts::orphanCmd()."), {
      kind: "unassigned",
      candidates: ["alpha", "beta"],
    });
    // the residual backstop of a shared file is unassigned until claimed
    assert.deepStrictEqual(resolveOwner(r, "src/cli.ts::<module>"), {
      kind: "unassigned",
      candidates: ["alpha", "beta"],
    });
  });

  it("a symbol two co-owners both claim is ambiguous (lint)", () => {
    const r = reg({
      alpha: {
        doc: "docs/features/alpha.md",
        primary_sources: ["src/cli.ts"],
        owned_symbols: { "src/cli.ts": ["dupe()."] },
      },
      beta: {
        doc: "docs/features/beta.md",
        primary_sources: ["src/cli.ts"],
        owned_symbols: { "src/cli.ts": ["dupe()."] },
      },
    });
    assert.deepStrictEqual(resolveOwner(r, "src/cli.ts::dupe()."), {
      kind: "ambiguous",
      owners: ["alpha", "beta"],
    });
  });
});

describe("registry owned_symbols normalization", () => {
  it("parses, sorts, and drops empties; single-owner entries carry no field", () => {
    const r = reg({
      alpha: {
        doc: "docs/features/alpha.md",
        primary_sources: ["src/cli.ts"],
        owned_symbols: {
          "src/cli.ts": ["b().", "a().", "b()."],
          "src/empty.ts": [],
          "src/bad.ts": "nope",
        },
      },
      plain: { doc: "docs/features/plain.md", primary_sources: ["src/p.ts"] },
    });
    assert.deepStrictEqual(r.features.alpha.owned_symbols, {
      "src/cli.ts": ["a().", "b()."],
    });
    assert.equal(r.features.plain.owned_symbols, undefined);
  });
});
