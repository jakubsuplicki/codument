# Codument Quality Benchmark Task

You are in a fixture project created by `codument benchmark init`.

Add skip-day support to weekly meal plans.

Expected behavior:

- Export `skipDay(plan, isoDate, reason)` from `src/plans/weekly-plan.js`.
- A skipped day stays in the plan, has `skipped: true`, stores the trimmed reason as `skipReason`, and has no meals.
- `summarizePlan(plan)` reports `skippedDays` in addition to the existing `days` and `meals` counts.
- `updateMeal(plan, isoDate, slot, name)` must reject edits for skipped days.
- Existing behavior and tests must keep working.

Workflow:

- Use the Codument instructions in `AGENTS.md`.
- Add or update tests before implementing the behavior where practical.
- Keep the public API in `src/plans/weekly-plan.js`; do not move meal catalog behavior out of `src/domain/menu.js`.
- Update the durable docs and `docs/.registry.json` if your implementation changes the documented behavior.
- Do not modify `benchmark.lock.json` or `.codument/benchmark.json`.
- Run `npm test` before you stop.

Stop with a concise review summary and the verification you ran.
