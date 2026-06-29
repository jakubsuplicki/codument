// Authorize a request for a previously issued session.
export function authorize(session, nowMs) {
  if (!session) {
    return { ok: false, error: "no_session" };
  }
  return { ok: true, userId: session.userId };
}
