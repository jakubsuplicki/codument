---
title: Meal Plans
status: current
type: feature
sources:
  - src/features/meal-plans/plans.ts
  - src/features/meal-plans/schedule.ts
depends_on:
  - date-utils
last_reviewed: 2026-05-29
---

## Summary

Meal plans convert a weekly recipe selection into dated cooking slots. A plan stores a stable plan id, the ISO week it belongs to, and a list of scheduled meals.

## How it works

The feature treats the week as seven local dates. `createMealPlan` validates that every requested meal lands inside the requested week, then stores the meals in chronological order. `listMealsForDate` filters a plan by local date and returns the meals for that day.

The date calculations are intentionally delegated to the shared date utilities so week boundaries stay consistent across features.

## Key files

- `src/features/meal-plans/plans.ts`
- `src/features/meal-plans/schedule.ts`
