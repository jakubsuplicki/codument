import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const target = process.env.CODUMENT_TARGET;
const load = (rel) => import(pathToFileURL(join(target, rel)).href);

// Bug: off-by-one-pagination. Pages are 1-indexed; page 1 must be the first
// window, not the second.
test("page 1 returns the first window", async () => {
  const { paginate } = await load("src/util/pagination.js");

  const items = ["a", "b", "c", "d", "e"];

  assert.deepEqual(paginate(items, 1, 2), ["a", "b"]);
  assert.deepEqual(paginate(items, 2, 2), ["c", "d"]);
  assert.deepEqual(paginate(items, 3, 2), ["e"]);
});
