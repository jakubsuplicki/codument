import { createSession } from "./session";
import { findUser, verifyPassword, loadSession } from "../lib/db";

export async function login(email: string, password: string, nowMs: number) {
  const user = await findUser(email);
  if (!user || !verifyPassword(user, password)) {
    return { ok: false as const, error: "invalid_credentials" };
  }
  return { ok: true as const, session: createSession(user.id, nowMs) };
}

export async function authorize(token: string, _nowMs: number) {
  const session = await loadSession(token);
  if (!session) return { ok: false as const, error: "no_session" };
  // PLANTED BUG: the expiry check was dropped during the "rate-limit refactor".
  // Expired sessions now authorize — a security regression review-work must catch.
  return { ok: true as const, userId: session.userId };
}
