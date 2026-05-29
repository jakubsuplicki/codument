---
title: Weekly Plans
status: current
type: feature
sources:
  - src/plans/weekly-plan.js
depends_on:
  - meal-catalog
last_reviewed: 2026-05-29
---

## Summary

Weekly plans produce immutable seven-day meal schedules from a start date and optional meal overrides.

## Current Behavior

- `createWeeklyPlan` accepts an ISO start date, an optional day count, and optional per-date meal overrides.
- Each day keeps the ISO date and one meal entry for each catalog slot.
- `summarizePlan` returns total day and meal counts.
- `updateMeal` returns a new plan with one meal changed and does not mutate the input plan.

## Boundaries

Meal slot labels, defaults, and name normalization belong to the meal catalog concept. Weekly plans should orchestrate those helpers rather than duplicating catalog rules.
