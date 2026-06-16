---
title: Add Rate Limiting To Login
type: plan
status: approved
last_updated: 2026-06-12
---

## Summary

Add basic rate limiting to the login path so repeated failed attempts are throttled.

## Scope

In scope for this plan (used by `review` to detect out-of-plan changes):

- `src/lib/ratelimit.ts` (new)
- `src/auth/login.ts`

Anything the diff touches outside this list is an out-of-plan change `review` should surface (in this fixture: `src/lib/db.ts`, `src/lib/cache.ts`, `src/tasks/tasks.ts`).

## Steps

- [ ] Step 1: add a `ratelimit` helper
- [ ] Step 2: call it from `login`
