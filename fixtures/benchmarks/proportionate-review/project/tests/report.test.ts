import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCount } from "../src/count.js";

test("the parser accepts a count in range", () => {
  assert.equal(parseCount("3"), 3);
});
