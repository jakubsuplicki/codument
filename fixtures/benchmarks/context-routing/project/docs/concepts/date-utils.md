---
title: Date Utils
status: current
type: concept
sources:
  - src/lib/date-utils.ts
depends_on: []
last_reviewed: 2026-05-29
---

## Summary

Date utilities provide local-date helpers for week-based product features. Meal plans depend on these helpers so every feature agrees on the same week start and ISO date format. This concept depends on timezone normalization, which gives the benchmark a transitive dependency to verify.

## How it works

Dates are represented as `YYYY-MM-DD` strings at feature boundaries. Internally the helpers convert to UTC noon before arithmetic, which avoids daylight-saving edge cases in this small fixture.

## Key files

- `src/lib/date-utils.ts`
