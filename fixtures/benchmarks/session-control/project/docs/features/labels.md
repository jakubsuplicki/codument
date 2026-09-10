---
title: Labels
status: current
type: feature
last_reviewed: 2026-09-10
---
# Labels
## In plain terms
Invoice labels are display text. The requested normalization trims outer whitespace and uppercases text.
## Design approach
String conversion remains compatible with existing numeric callers.
## Invariants & boundaries
- Normalize text without changing the original value. *(untested in the smoke suite)*
## Decisions
This independent display change does not depend on shipping, pricing or retry policy.
## Key files
- `src/labels.js`
