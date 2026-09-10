---
title: Pricing
status: current
type: feature
last_reviewed: 2026-09-10
---
# Pricing
## In plain terms
Invoices total line items in cents. Coupon support must preserve settlement rules.
## Design approach
Use the money contract in [[settlement]]; callers include credits as negative line amounts.
## Invariants & boundaries
- Existing calls without a coupon retain their totals. *(test: `tests/smoke.test.js`)*
- Settlement owns rounding, including credits. *(untested in the smoke suite)*
## Decisions
Monetary inputs are already integer cents; do not convert currencies.
## Key files
- `src/pricing.js`
