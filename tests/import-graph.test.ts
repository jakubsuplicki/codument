import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { harvestImports, importedFiles, resolveSpecifier } from "../src/lib/import-graph.js";

describe("resolveSpecifier", () => {
  it("maps a relative .js specifier back to its .ts source, normalizing ..", () => {
    assert.equal(
      resolveSpecifier("src/commands/review.ts", "../lib/registry.js"),
      "src/lib/registry.ts",
    );
    assert.equal(resolveSpecifier("src/lib/change-state.ts", "./analyze.js"), "src/lib/analyze.ts");
  });

  it("maps each compiled extension to its source extension", () => {
    assert.equal(resolveSpecifier("a/b.ts", "./c.jsx"), "a/c.tsx");
    assert.equal(resolveSpecifier("a/b.ts", "./c.mjs"), "a/c.mts");
    assert.equal(resolveSpecifier("a/b.ts", "./c.cjs"), "a/c.cts");
  });

  it("treats an extensionless relative specifier as best-effort .ts", () => {
    assert.equal(resolveSpecifier("src/a.ts", "./util"), "src/util.ts");
  });

  it("returns null for bare, node:, and package specifiers (external)", () => {
    assert.equal(resolveSpecifier("src/a.ts", "typescript"), null);
    assert.equal(resolveSpecifier("src/a.ts", "node:path"), null);
    assert.equal(resolveSpecifier("src/a.ts", "@scope/pkg"), null);
  });
});

describe("harvestImports", () => {
  it("captures named, default, namespace, and aliased bindings with resolution", () => {
    const bindings = harvestImports(
      "src/commands/review.ts",
      [
        'import { readRegistry, type Registry } from "../lib/registry.js";',
        'import def from "../lib/git.js";',
        'import * as ns from "./helpers.js";',
        'import { a as b } from "../lib/two-ref.js";',
        'import ts from "typescript";',
        'import "./side-effect.js";',
      ].join("\n"),
    );
    const byLocal = Object.fromEntries(bindings.map((b) => [b.local, b.resolved]));
    assert.equal(byLocal.readRegistry, "src/lib/registry.ts");
    assert.equal(byLocal.Registry, "src/lib/registry.ts"); // type-only still a binding
    assert.equal(byLocal.def, "src/lib/git.ts");
    assert.equal(byLocal.ns, "src/commands/helpers.ts");
    assert.equal(byLocal.b, "src/lib/two-ref.ts"); // aliased: local name is `b`
    assert.equal(byLocal.ts, null); // external package
    // side-effect import introduces no local binding
    assert.equal(Object.hasOwn(byLocal, "side-effect"), false);
  });
});

describe("importedFiles", () => {
  it("returns deduped, sorted first-party edges including side-effect imports", () => {
    const files = importedFiles(
      "src/lib/a.ts",
      [
        'import { x } from "./b.js";',
        'import { y } from "./b.js";', // same file twice -> deduped
        'import "./c.js";', // side-effect edge counts
        'import pkg from "lodash";', // external -> dropped
      ].join("\n"),
    );
    assert.deepStrictEqual(files, ["src/lib/b.ts", "src/lib/c.ts"]);
  });
});
