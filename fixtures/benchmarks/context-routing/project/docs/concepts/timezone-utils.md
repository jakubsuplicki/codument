---
title: Timezone Utils
status: current
type: concept
sources:
  - src/lib/timezone-utils.ts
depends_on: []
last_reviewed: 2026-05-29
---

## Summary

Timezone utilities normalize user-provided timezone labels before date helpers perform week arithmetic. Meal planning depends on date utilities, and date utilities depend on this concept for stable fixture coverage of transitive registry dependencies.

## How it works

The helper accepts IANA timezone names and falls back to `UTC` for empty values. The fixture keeps the implementation intentionally small because the benchmark only needs a real transitive dependency to include in context.

## Key files

- `src/lib/timezone-utils.ts`
