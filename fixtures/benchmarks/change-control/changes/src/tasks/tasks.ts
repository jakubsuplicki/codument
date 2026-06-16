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

// changed: added completeTask. Out-of-plan, BUT tasks.md is updated in the same
// diff -> clean control: review should NOT flag this doc as stale.
export async function completeTask(token: string, id: string, nowMs: number) {
  const auth = await authorize(token, nowMs);
  if (!auth.ok) return auth;
  const task = tasks.find((t) => t.id === id && t.userId === auth.userId);
  if (!task) return { ok: false as const, error: "not_found" };
  task.done = true;
  return { ok: true as const, task };
}
