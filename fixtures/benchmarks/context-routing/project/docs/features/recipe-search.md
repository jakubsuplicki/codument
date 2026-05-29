---
title: Recipe Search
status: current
type: feature
sources:
  - src/features/recipe-search/search.ts
depends_on: []
last_reviewed: 2026-05-29
---

## Summary

Recipe search ranks saved recipes by exact title matches, ingredient overlap, and recent usage. It is intentionally unrelated to meal-plan scheduling.

## How it works

The search index normalizes recipe titles and ingredients into lowercase tokens. Query tokens are scored independently, then combined into a single descending score. The implementation keeps scoring simple so fixtures have an irrelevant but plausible product area.

## Key files

- `src/features/recipe-search/search.ts`
