---
title: Db
type: concept
status: current
last_updated: 2026-06-10
---

## In plain terms

`db` is the tiny in-memory data layer everything else reads and writes through: users, sessions, and tasks.

## How it works

- `findUser`, `verifyPassword`, `loadSession` in `src/lib/db.ts`.
- Both `auth` and `tasks` depend on `db`, so a change here should make `review` flag those dependents for re-review.

## Decisions

- Carries a `risk: ["data-loss"]` hint because it owns persistence; changes here are higher-stakes.
