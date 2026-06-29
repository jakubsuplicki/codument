import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const target = process.env.CODUMENT_TARGET;
const load = (rel) => import(pathToFileURL(join(target, rel)).href);

// Bug: negative-amount-accepted. A fix must reject non-positive amounts on both
// deposit and withdraw, while still applying valid positive amounts.
test("non-positive amounts are rejected", async () => {
  const { createAccount, deposit, withdraw } = await load(
    "src/wallet/account.js",
  );

  const account = createAccount(100);

  assert.equal(deposit(account, 50).balance, 150, "valid deposit must apply");
  assert.equal(withdraw(account, 40).balance, 60, "valid withdraw must apply");

  assert.throws(
    () => deposit(account, -50),
    "a negative deposit must be rejected",
  );
  assert.throws(
    () => withdraw(account, -50),
    "a negative withdraw must be rejected",
  );
});
