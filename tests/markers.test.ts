import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MARKER_START, MARKER_END } from "../src/lib/markers.js";

describe("markers", () => {
  it("exports start marker as HTML comment", () => {
    assert.equal(MARKER_START, "<!-- codument:start -->");
  });

  it("exports end marker as HTML comment", () => {
    assert.equal(MARKER_END, "<!-- codument:end -->");
  });

  it("markers are valid HTML comments", () => {
    assert.match(MARKER_START, /^<!--.*-->$/);
    assert.match(MARKER_END, /^<!--.*-->$/);
  });
});
