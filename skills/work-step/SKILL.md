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
4. Read `docs/.registry.json` before touching source files.
5. Implement only that step.
6. Use `tdd` or the strongest practical verification loop.
7. Update mapped docs and registry as part of the same step.
8. Mark the step complete only after verification passes.
9. Outside autopilot, stop and do not start the next delivery-plan step. In an autopilot run, proceed directly to `review-work` for this step without waiting.
10. Outside autopilot, present the user with end-of-step options:
    - Run `review-work` now (recommended)
    - Make a specific correction to this step
    - Pause here

## End-Of-Step Gate

A completed implementation step is not ready for the next plan step until it has been reviewed and committed.

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
