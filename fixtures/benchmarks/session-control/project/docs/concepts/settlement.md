---
title: Settlement
status: current
type: concept
last_reviewed: 2026-09-10
---
# Settlement
## In plain terms
Each invoice line settles independently in whole cents, including credit lines.
## Design approach
Apply a percentage coupon to each extended line amount, round that line, then total the rounded lines.
## Invariants & boundaries
- Half cents round away from zero. A negative credit uses the same magnitude rounding as a charge.
- Rounding the total after adding unrounded discounted lines is forbidden.
- An omitted coupon means zero discount; permitted percentages are integers from zero through one hundred.
These constraints are not covered by the smoke suite.
## Decisions
Independent line settlement lets a credit reverse the original charge exactly.
## Key files
- `src/pricing.js`
