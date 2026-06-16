---
title: Tasks
type: feature
status: current
last_updated: 2026-06-10
---

## In plain terms

Tasks lets a signed-in user create, list, and complete to-do items. Every task belongs to a user, so the feature checks the session before touching anything.

## How it works

- `createTask`, `listTasks`, `completeTask` in `src/tasks/tasks.ts`.
- Each call resolves the caller via the auth session (`related_sources: src/auth/session.ts`).
- Tasks persist through the `db` concept.

## What Was Built

This section is an intentionally bloated delivery log — it should trip the `doctor` bloat lint (completed-log accumulation), and once compacted, only the durable decision above should remain.

- [x] Step 1: scaffold the tasks module
- [x] Step 2: add createTask
- [x] Step 3: add listTasks
- [x] Step 4: add completeTask
- [x] Step 5: wire tasks to the db layer
- [x] Step 6: add per-user scoping via session
- [x] Step 7: add input validation
- [x] Step 8: add pagination to listTasks
- [x] Step 9: add sorting by created date
- [x] Step 10: add filtering by completed state
- [x] Step 11: add a soft-delete path
- [x] Step 12: add restore-from-soft-delete
- [x] Step 13: add bulk complete
- [x] Step 14: add bulk delete
- [x] Step 15: add tags
- [x] Step 16: add tag filtering
- [x] Step 17: add due dates
- [x] Step 18: add overdue detection
- [x] Step 19: add a daily summary count
- [x] Step 20: add tests for all of the above

### Notes from step 7

Validation was added inline first, then extracted. The extracted validator now lives in `src/lib/validate.ts` (note: not yet mapped in the registry — this is a planted unmapped-source scenario).

### Notes from step 11

Soft delete keeps a `deletedAt` timestamp. Restore clears it. This long-form log is the kind of content the durable doc should not retain.
