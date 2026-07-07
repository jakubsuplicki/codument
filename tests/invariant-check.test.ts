import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseInvariants } from "../src/lib/invariant-check.js";

describe("parseInvariants — pointer parsing over a doc's invariants section", () => {
  const DOC = [
    "# Feature X",
    "",
    "## In plain terms",
    "- this bullet is NOT in the invariants section and must be ignored *(test: ignore.test.ts)*",
    "",
    "## Invariants & boundaries",
    "",
    "- **A is enforced.** The claim holds. *(test: a.test.ts — the happy path)*",
    "- **B spans files.** *(tests: `b1.test.ts` one case; b2.test.ts#namedCase another)*",
    "- **C is unenforced.** *(untested)*",
    "- **D is a boundary.** *(honest ceiling — undecidable in general)*",
    "- **E cites nothing parseable.** *(test: see the suite somewhere)*",
    "- **F has no marker at all.** Just prose.",
    "",
    "## Decisions",
    "- some decision *(test: decisions-are-not-invariants.test.ts)*",
  ].join("\n");

  const invs = parseInvariants(DOC);

  it("reads only the invariants section (not other sections)", () => {
    assert.equal(invs.length, 6, "A..F, and neither In-plain-terms nor Decisions bullets");
    assert.ok(invs.every((i) => !/ignore|decisions-are-not/.test(JSON.stringify(i.annotation))));
  });

  it("parses a single pinned pointer", () => {
    const a = invs[0];
    assert.equal(a.summary, "A is enforced.");
    assert.deepStrictEqual(a.annotation, { kind: "pinned", pointers: [{ file: "a.test.ts" }] });
  });

  it("parses multiple files and a #name in one marker (back-ticks stripped)", () => {
    const b = invs[1].annotation;
    assert.equal(b.kind, "pinned");
    assert.deepStrictEqual(b.kind === "pinned" && b.pointers, [
      { file: "b1.test.ts" },
      { file: "b2.test.ts", name: "namedCase" },
    ]);
  });

  it("classifies untested and honest markers", () => {
    assert.deepStrictEqual(invs[2].annotation, { kind: "untested" });
    assert.equal(invs[3].annotation.kind, "honest");
  });

  it("surfaces a malformed test marker (names no test file) rather than skipping it", () => {
    assert.equal(invs[4].annotation.kind, "malformed");
  });

  it("marks an unannotated invariant as none", () => {
    assert.equal(invs[5].annotation.kind, "none");
    assert.equal(invs[5].summary, "F has no marker at all.");
  });

  it("reports the doc line of each invariant bullet", () => {
    // "A is enforced" is on line 8 (1-based) of DOC.
    assert.equal(invs[0].line, 8);
  });
});

describe("parseInvariants — edge cases", () => {
  it("returns [] for a doc with no invariants section", () => {
    assert.deepStrictEqual(parseInvariants("# X\n\n## Design approach\n- nothing here\n"), []);
  });

  it("matches the heading case-insensitively and stops at the next level-2 heading", () => {
    const doc = "## invariants & boundaries\n- **only this.** *(untested)*\n## Key files\n- a.ts\n";
    const invs = parseInvariants(doc);
    assert.equal(invs.length, 1);
    assert.equal(invs[0].annotation.kind, "untested");
  });

  it("keeps a multi-line bullet's trailing marker attached to it", () => {
    const doc = [
      "## Invariants & boundaries",
      "- **wrapped claim** that keeps going",
      "  onto a second line and only then",
      "  cites its test *(test: wrapped.test.ts)*",
      "- **next one** *(untested)*",
    ].join("\n");
    const invs = parseInvariants(doc);
    assert.equal(invs.length, 2);
    assert.deepStrictEqual(invs[0].annotation, {
      kind: "pinned",
      pointers: [{ file: "wrapped.test.ts" }],
    });
  });

  it("takes the LAST parenthetical as the annotation (an earlier aside is not it)", () => {
    const doc =
      "## Invariants & boundaries\n- **claim** with an *(aside)* mid-sentence *(test: real.test.ts)*\n";
    const invs = parseInvariants(doc);
    assert.deepStrictEqual(invs[0].annotation, {
      kind: "pinned",
      pointers: [{ file: "real.test.ts" }],
    });
  });
});
