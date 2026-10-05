---
title: Repair the piece report
status: in-progress
type: plan
last_reviewed: 2026-10-04
---

# Repair the piece report

## Delivery Plan

Plan-ID: matched-report-repair
Status: approved

- [ ] Step 1: Repair the existing count parser and report presentation, extend the existing regression test, add a result note, and deliver verified staged readiness without a commit.
- [ ] Step 2: A future presentation milestone; leave it untouched during this attempt.

### Acceptance criteria

- The emitted CLI preserves the existing documented valid and invalid input behavior.
- Repairs stay inside existing function bodies and preserve public signatures, imports and module-level initialization.
- Regression tests exercise the emitted CLI and input boundaries.
- Step 1 reaches reviewed, verified staged readiness with its commit pending; Step 2 stays unchecked.

### Verification strategy

- Run build, typecheck and the existing test runner.
- Inspect emitted CLI output for valid and invalid input.
- Review exactly the staged boundary at the generated minimum effort, then run verify and work finish.

### Scope

- `src/count.ts`
- `src/report.ts`
- `tests/report.test.ts`
- `docs/plans/repair-report.md`
- `docs/notes/result.md`
