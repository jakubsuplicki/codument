import type { Session } from "../auth/session";

export type User = { id: string; email: string; passwordHash: string };

const users = new Map<string, User>();
const sessions = new Map<string, Session>();

export async function findUser(email: string): Promise<User | undefined> {
  for (const u of users.values()) {
    if (u.email === email) return u;
  }
  return undefined;
}

export function verifyPassword(user: User, password: string): boolean {
  return hash(password) === user.passwordHash;
}

export async function loadSession(token: string): Promise<Session | undefined> {
  return sessions.get(token);
}

function hash(s: string): string {
  return Buffer.from(s).toString("base64");
}
