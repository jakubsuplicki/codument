const SESSION_TTL_MS = 1000 * 60 * 60; // 1 hour

export function createSession(userId, nowMs) {
  return {
    token: `${userId}:${nowMs}`,
    userId,
    expiresAt: nowMs + SESSION_TTL_MS,
  };
}

export function isSessionExpired(session, nowMs) {
  return nowMs > session.expiresAt;
}
