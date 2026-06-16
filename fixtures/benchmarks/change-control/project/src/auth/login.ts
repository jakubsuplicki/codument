import { createSession, isSessionExpired } from "./session";
import { findUser, verifyPassword, loadSession } from "../lib/db";

export async function login(email: string, password: string, nowMs: number) {
  const user = await findUser(email);
  if (!user || !verifyPassword(user, password)) {
    return { ok: false as const, error: "invalid_credentials" };
  }
  return { ok: true as const, session: createSession(user.id, nowMs) };
}

export async function authorize(token: string, nowMs: number) {
  const session = await loadSession(token);
  if (!session) return { ok: false as const, error: "no_session" };
  // Expiry is enforced on every authorize call.
  if (isSessionExpired(session, nowMs)) {
    return { ok: false as const, error: "session_expired" };
  }
  return { ok: true as const, userId: session.userId };
}
