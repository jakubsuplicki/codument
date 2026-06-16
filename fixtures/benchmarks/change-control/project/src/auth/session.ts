export type Session = { token: string; userId: string; expiresAt: number };

const SESSION_TTL_MS = 1000 * 60 * 60; // 1 hour

export function createSession(userId: string, nowMs: number): Session {
  return {
    token: Math.random().toString(36).slice(2),
    userId,
    expiresAt: nowMs + SESSION_TTL_MS,
  };
}

export function isSessionExpired(session: Session, nowMs: number): boolean {
  return nowMs > session.expiresAt;
}
