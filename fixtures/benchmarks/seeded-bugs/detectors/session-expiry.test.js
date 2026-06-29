import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const target = process.env.CODUMENT_TARGET;
const load = (rel) => import(pathToFileURL(join(target, rel)).href);

const HOUR = 1000 * 60 * 60;

// Bug: session-expiry-dropped. A fix must reject an expired session AND still
// accept a valid one (an always-reject "fix" is not a fix).
test("expired sessions are rejected", async () => {
  const { authorize } = await load("src/auth/authorize.js");
  const { createSession } = await load("src/auth/session.js");

  const session = createSession("user-1", 0);

  const valid = authorize(session, 1000);
  assert.equal(valid.ok, true, "a fresh session must still authorize");

  const expired = authorize(session, HOUR + 1);
  assert.equal(expired.ok, false, "an expired session must not authorize");
  assert.equal(expired.error, "session_expired");
});
