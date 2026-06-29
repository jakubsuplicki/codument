import { isSessionExpired } from "./session.js";

// Authorize a request for a previously issued session.
// Expiry is enforced on every call: an expired session must never authorize.
export function authorize(session, nowMs) {
  if (!session) {
    return { ok: false, error: "no_session" };
  }
  if (isSessionExpired(session, nowMs)) {
    return { ok: false, error: "session_expired" };
  }
  return { ok: true, userId: session.userId };
}
