---
title: Billing
status: current
type: feature
sources:
  - src/features/billing/invoices.ts
depends_on: []
last_reviewed: 2026-05-29
---

## Summary

Billing creates invoice summaries for a subscription account. This area has no dependency on meal plans and should be excluded from the Codument context for a meal-plan task.

## How it works

Invoices are generated from line items and tax configuration. Totals are rounded at the invoice boundary, not per item, so small fractional values do not accumulate. The fixture keeps this content intentionally verbose enough to make irrelevant context visible in token estimates.

## Key files

- `src/features/billing/invoices.ts`
