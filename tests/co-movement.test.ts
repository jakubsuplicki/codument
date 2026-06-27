import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyComovement,
  normalizeProse,
  symbolMentionLines,
} from "../src/lib/co-movement.js";

describe("normalizeProse", () => {
  it("strips a leading frontmatter block (so a date bump never counts)", () => {
    const md = "---\ntitle: X\nlast_updated: 2026-06-27\n---\n\nReal prose about foo.\n";
    assert.deepStrictEqual(normalizeProse(md), ["Real prose about foo."]);
  });
  it("keeps link text but drops the churny URL", () => {
    assert.deepStrictEqual(
      normalizeProse("See [the foo helper](https://example.com/a/b#c)."),
      ["See the foo helper."],
    );
  });
});

describe("symbolMentionLines — whole-identifier match", () => {
  it("matches the symbol but not a larger identifier containing it", () => {
    const lines = ["calls foo() here", "unrelated foobar line", "`foo` in a code span"];
    assert.deepStrictEqual([...symbolMentionLines(lines, "foo")], [
      "calls foo() here",
      "`foo` in a code span",
    ]);
  });
});

// `D(...)` builds a tiny doc; `S` is the symbol. change defaults to "changed".
function status(
  baseDoc: string | null,
  headDoc: string | null,
  symbol = "foo",
  change: "added" | "changed" | "removed" = "changed",
  module = false,
) {
  return classifyComovement(baseDoc, headDoc, symbol, change, { module });
}

describe("classifyComovement — anti-gaming fixtures (telemetry signal)", () => {
  const baseDoc = "# Feature\n\nThe foo() helper validates input.\n\nUnrelated paragraph.\n";

  it("a genuine reconciliation of the symbol's line co-moves", () => {
    const head = "# Feature\n\nThe foo() helper now validates AND normalizes input.\n\nUnrelated paragraph.\n";
    assert.equal(status(baseDoc, head), "co-moved");
  });

  it("a date-bump-only edit (frontmatter) does not co-move", () => {
    const base = "---\nlast_updated: 2026-01-01\n---\n" + baseDoc;
    const head = "---\nlast_updated: 2026-06-27\n---\n" + baseDoc;
    assert.equal(status(base, head), "prose-unchanged");
  });

  it("editing an unrelated paragraph does not co-move", () => {
    const head = "# Feature\n\nThe foo() helper validates input.\n\nCompletely different now.\n";
    assert.equal(status(baseDoc, head), "prose-unchanged");
  });

  it("a doc that never mentions the symbol is not-referenced", () => {
    const base = "# Feature\n\nGeneral prose, no symbol named.\n";
    const head = "# Feature\n\nGeneral prose, reworded entirely.\n";
    assert.equal(status(base, head), "not-referenced");
  });

  it("changing only a link URL on the symbol line does not co-move", () => {
    const base = "The [foo()](https://old/x) helper.\n";
    const head = "The [foo()](https://new/y) helper.\n";
    assert.equal(status(base, head), "prose-unchanged");
  });

  it("changing the link TEXT on the symbol line co-moves", () => {
    const base = "The [foo()](https://x) helper validates.\n";
    const head = "The [foo()](https://x) helper validates and normalizes.\n";
    assert.equal(status(base, head), "co-moved");
  });
});

describe("classifyComovement — added / removed / module / no-doc", () => {
  it("an added symbol newly documented co-moves", () => {
    assert.equal(status("# F\n\nold.\n", "# F\n\nThe new foo() does X.\n", "foo", "added"), "co-moved");
  });
  it("an added symbol left undocumented is not-referenced", () => {
    assert.equal(status("# F\n\nold.\n", "# F\n\nstill nothing.\n", "foo", "added"), "not-referenced");
  });
  it("a removed symbol whose mention is dropped co-moves", () => {
    assert.equal(status("The foo() helper.\n", "Gone now.\n", "foo", "removed"), "co-moved");
  });
  it("a removed symbol with a lingering identical mention is prose-unchanged (stale ref)", () => {
    assert.equal(status("The foo() helper.\n", "The foo() helper.\n", "foo", "removed"), "prose-unchanged");
  });
  it("the <module> backstop co-moves on any prose movement", () => {
    assert.equal(status("# F\n\nalpha.\n", "# F\n\nbeta.\n", "<module>", "changed", true), "co-moved");
  });
  it("the <module> backstop with no prose change is prose-unchanged", () => {
    assert.equal(status("# F\n\nsame.\n", "# F\n\nsame.\n", "<module>", "changed", true), "prose-unchanged");
  });
  it("a changed symbol with no doc at head is no-doc", () => {
    assert.equal(status("The foo() helper.\n", null, "foo", "changed"), "no-doc");
  });
});
