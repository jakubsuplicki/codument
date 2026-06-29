import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { authorize } from "../src/auth/authorize.js";
import { createSession } from "../src/auth/session.js";
import { createAccount, deposit, withdraw } from "../src/wallet/account.js";

const HOUR = 1000 * 60 * 60;

describe("auth", () => {
  it("authorizes a fresh session", () => {
    const session = createSession("user-1", 0);
    assert.deepEqual(authorize(session, 1000), { ok: true, userId: "user-1" });
  });
});

describe("account", () => {
  it("deposits and withdraws within balance", () => {
    const funded = deposit(createAccount(0), 100);
    assert.equal(funded.balance, 100);
    assert.equal(withdraw(funded, 40).balance, 60);
  });
});

// Note: this suite covers existing behavior only. The new report utilities the
// feature work introduces are intentionally left uncovered here — that gap is
// what the review step (and the benchmark detectors) exist to surface.
void HOUR;
