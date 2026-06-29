import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const target = process.env.CODUMENT_TARGET;
const load = (rel) => import(pathToFileURL(join(target, rel)).href);

// Bug: silent-parse-default. A fix must throw on invalid input instead of
// silently returning 0, while still parsing valid numbers.
test("invalid amounts throw instead of defaulting to 0", async () => {
  const { parseAmount } = await load("src/util/parse-amount.js");

  assert.equal(parseAmount("12.5"), 12.5, "a valid amount must still parse");

  assert.throws(() => parseAmount("abc"), "garbage input must throw");
  assert.throws(() => parseAmount(""), "empty input must throw");
});
