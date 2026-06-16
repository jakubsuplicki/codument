import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderCoverageBadge } from "../src/lib/badge.js";

describe("renderCoverageBadge", () => {
  it("renders the percent and a green color at high coverage", () => {
    const svg = renderCoverageBadge(92);
    assert.match(svg, /<svg /);
    assert.match(svg, />92%</);
    assert.match(svg, /docs coverage: 92%/);
    assert.match(svg, /#4c1/); // green
  });

  it("renders N/A (not 0%) when no ratio is applicable", () => {
    const svg = renderCoverageBadge(null);
    assert.match(svg, />N\/A</);
    assert.doesNotMatch(svg, />0%</);
    assert.match(svg, /#9f9f9f/); // grey
  });

  it("picks color by threshold", () => {
    assert.match(renderCoverageBadge(40), /#e05d44/); // red
    assert.match(renderCoverageBadge(60), /#dfb317/); // yellow
    assert.match(renderCoverageBadge(78), /#97ca00/); // yellowgreen
  });

  it("is deterministic for a given percent", () => {
    assert.equal(renderCoverageBadge(78), renderCoverageBadge(78));
  });
});
