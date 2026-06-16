---
title: Notifications
type: feature
status: current
last_updated: 2026-06-10
---

## In plain terms

Notifications sends transactional email — for now, a welcome message on signup.

## How it works

- `sendEmail` in `src/notify/email.ts` is the single entry point.
- `src/generated/api-types.ts` is generated output that was (incorrectly) listed as a primary source — a planted generated-leakage scenario for `doctor`.

## Decisions

- `depends_on` is intentionally empty here, which `doctor` should flag as a missing-dependency lint for a mature feature.
