---
name: work-step
description: Execute the next approved Codument delivery-plan step, using the relevant implementation and verification skills.
---

# Work Step

Use this when the user says to continue, work the next step, or implement the approved plan.

## Workflow

1. Find the active plan in the relevant `docs/features/*.md` or `docs/concepts/*.md`.
2. Confirm the plan status is approved.
3. Pick the first unchecked delivery-plan step.
4. Surface the checklist in the live view (see Plan Checklist Mirror below): mirror the plan's steps into your host's native to-do panel with the step you are about to implement marked in progress, and run `codument steps --emit` so `codument watch` shows the active step. In an autopilot run, also post this checklist inline in the chat — the step just completed, the step now starting, and what remains — because the native to-do panel and the watch tape are not the chat transcript, and autopilot otherwise advances between steps with no in-chat marker.
5. Read `docs/.registry.json` before touching source files.
6. Implement only that step.
7. Use `tdd` or the strongest practical verification loop.
8. Register each NEW source file by running `codument map materialize <file>` (see Feature Map Materialization), then update the mapped docs + registry as part of the same step.
9. Mark the step complete — in the plan doc, and in the mirrored native to-do list — only after verification passes. If this was the final step, compact the `## Delivery Plan` block per `plan-with-docs` (Compaction on ship): lift surviving decisions into `## Decisions`/ADRs and any newly-true constraint into `## Invariants & boundaries`, then delete the delivery scaffolding so the durable doc is left in the standard's layers.
10. Outside autopilot, stop and do not start the next delivery-plan step. In an autopilot run, proceed directly to `review-work` for this step without waiting.
11. Outside autopilot, present the user with end-of-step options:
    - Run `review-work` now (recommended)
    - Make a specific correction to this step
    - Pause here

## Plan Checklist Mirror

The plan doc's `## Delivery Plan` checklist is the source of truth; the panels below are one-way projections of it, so a step is never "done" until its `- [ ]` is `- [x]` in the doc.

- If your host agent has a native to-do / checklist tool (e.g. Claude Code's TodoWrite), mirror the plan steps into it at the start of the step so the checklist is visible while you work. Run `codument steps --json` for the exact list — each item carries `text` plus a `status` of `completed` / `in_progress` / `pending` that maps directly onto the to-do tool. Mark the active step `in_progress`. If your host has no such tool, skip this silently.
- Run `codument steps --emit` to log the active `step` event into `.codument/events.jsonl`, so anyone running `codument watch` (any agent, any terminal) sees the active step in the activity tape. It is idempotent — safe to run every step; it only appends when the active step changes.
- `codument steps` auto-detects the single approved plan with an unchecked step; pass `--plan docs/features/<name>.md` when more than one is active.

## Feature Map Materialization

When a step lands a NEW source file, route it via the approved plan's Feature Map instead of inventing a feature for it:

- Run `codument map materialize <file>` for each new source file. It creates the owning feature's registry entry + a doc scaffold (seeded from the Map's responsibility) the first time that feature appears, and appends to an existing feature otherwise — idempotently, keyed on the file's Map row. New entries are created with status `needs-review`.
- **An unmapped or ambiguous file is a flag, not a lump.** If `codument map materialize` reports the file unmapped (or two glob rows tie), STOP: add or tighten a Map row in the plan — never fold the file into an existing umbrella feature. The owner of a file is a decomposition decision, not a default.
- Because materialization is per-file and lazy, `doctor` is expected clean only at STEP BOUNDARIES — after every source file the step landed has been materialized. A half-materialized step will transiently show `unmapped-source`; that is the backstop working, not a failure.
- Then fill the materialized feature's `depends_on` and doc content as usual.

## End-Of-Step Gate

A completed implementation step is not ready for the next plan step until it has been reviewed and committed.

The registry must be in sync before review: `codument review --strict` must pass at the step boundary. It exits nonzero while the step left a new source unmapped or a mapped doc stale — materialize the file(s) (`codument map materialize <file>`) and update the stale doc(s) until it is clean. Mid-step `unmapped-source` is transient and fine; a red gate at the boundary is not — never hand a half-synced step to `review-work` or `commit-work`.

In an autopilot run, skip the options below and continue directly to `review-work` for this step. Outside autopilot, when the implementation and verification are done, say plainly:

```text
Step N is implemented and verified. Next options:
1. Run /review-work on this step
2. Make a correction to this step
3. Pause here
```

Only after `review-work` is clean and `commit-work` has committed the slice may you offer to start the next unchecked plan step.

## Rules

- Stop if the plan is missing, still draft, or ambiguous (in autopilot, this stops the whole run).
- Do not skip ahead to later steps.
- Outside autopilot, do not ask to start the next step at the end of implementation.
- Do not bundle unrelated cleanup into the step.
- Keep the diff small enough to review.
- If implementation reveals a missing decision, pause and update the plan before continuing.
