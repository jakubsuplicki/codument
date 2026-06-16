import { authorize } from "../auth/login";

export type Task = { id: string; userId: string; title: string; done: boolean };

const tasks: Task[] = [];

export async function createTask(token: string, title: string, nowMs: number) {
  const auth = await authorize(token, nowMs);
  if (!auth.ok) return auth;
  const task: Task = { id: String(tasks.length + 1), userId: auth.userId, title, done: false };
  tasks.push(task);
  return { ok: true as const, task };
}

export async function listTasks(token: string, nowMs: number) {
  const auth = await authorize(token, nowMs);
  if (!auth.ok) return auth;
  return { ok: true as const, tasks: tasks.filter((t) => t.userId === auth.userId) };
}
