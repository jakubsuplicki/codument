---
title: Shipping
status: current
type: feature
last_reviewed: 2026-09-10
---
# Shipping
## In plain terms
Shipping costs eight hundred cents below the free-shipping threshold.
## Design approach
The current threshold is five thousand cents. Threshold changes require approval of that exact request.
## Invariants & boundaries
- At or above the current threshold shipping is free. *(untested beyond the zero subtotal smoke case)*
## Decisions
All values are cents, and no currency conversion is involved.
## Key files
- `src/shipping.js`
