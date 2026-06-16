---
title: Tasks
type: feature
status: current
last_updated: 2026-06-13
---

## In plain terms

Tasks lets a signed-in user create, list, and complete to-do items. Every task belongs to a user, so the feature checks the session before touching anything.

## How it works

- `createTask`, `listTasks`, `completeTask` in `src/tasks/tasks.ts`.
- Each call resolves the caller via the auth session.
- Tasks persist through the `db` concept.

## Decisions

- Per-user scoping is enforced on every call via `authorize`.

(Delivery log compacted in this change; durable decisions retained. This doc was
updated alongside the `tasks.ts` change — the clean control case for `review`.)
