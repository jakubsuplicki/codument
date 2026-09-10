---
title: Retry
status: current
type: feature
last_reviewed: 2026-09-10
---
# Retry
## In plain terms
Retries back off from one second, doubling each time. The approved change caps waiting at thirty seconds.
## Design approach
Keep the original sequence below the cap. Callers supply nonnegative integer attempts.
## Invariants & boundaries
- The first delay remains one thousand milliseconds. *(test: `tests/smoke.test.js`)*
- Once the cap is reached, later attempts must never exceed thirty thousand milliseconds. *(untested in the smoke suite)*
## Decisions
The cap bounds user-visible waiting regardless of attempt number.
## Key files
- `src/retry.js`
