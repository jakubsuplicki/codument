---
name: work-step
description: Execute the next approved Codument delivery-plan step, using the relevant implementation and verification skills.
---

# Work Step

Use this when the user says to continue, work the next step, or implement the approved plan.

## Workflow

1. Find the explicitly selected plan under `docs/features`, `docs/concepts`, or `docs/plans`. On resume, reconcile its Resume checkpoint with the plan and `git status`; hand a pending review or commit to its skill before starting another step.
2. Confirm the selected plan's status is exactly approved. Approval is permission, not a claim that paused work is running; a draft preview cannot authorize implementation.
3. Pick the first unchecked delivery-plan step.
4. Surface the checklist in the live view (see Plan Checklist Mirror below): mirror the plan's steps into your host's native to-do panel with the step you are about to implement marked in progress, and run `codument steps --plan <active-plan> --emit` so `codument watch` shows the active step. Post that checklist inline in the chat as well — the step just completed, the step now starting, and what remains — because the native to-do panel and the watch tape are not the chat transcript, and a run that does not wait between steps otherwise advances with no in-chat marker.
5. Ask `codument context --file <path> --owner` before and after each affected source file. For a plan with a Feature Map, use `codument context --plan <active-plan>` for its grounded working set. Without a Map, route the plan's explicit scoped files or features through `context --file <path>` / `--feature <slug>` and read their owning docs, invariants, and tests. Read the whole registry when editing the map or when the CLI is unavailable. A context budget is soft: selected contracts may exceed it and must not be silently discarded.
6. Implement only that step.
7. Use `tdd` or the strongest practical verification loop.
8. Register each NEW source file by running `codument map materialize <file>` (see Feature Map Materialization), then update the mapped docs + registry as part of the same step.
9. Mark the step complete — in the plan doc, and in the mirrored native to-do list — only after implementation verification passes. Before final-step compaction, save the approved plan with a pending-review checkpoint at `.codument/pending-plans/<repo-relative-plan-path>`; keep this recovery copy outside the staged step. Then compact the `## Delivery Plan` block per `plan-with-docs` (Compaction on ship): lift surviving decisions into `## Decisions`/ADRs and any newly-true constraint into `## Invariants & boundaries`, then delete the delivery scaffolding so the durable doc is left in the standard's layers.
10. Stage only the files belonging to this step. This exact staged boundary is the input to review; leave unrelated dirty files unstaged.
11. Proceed directly to `review-work` for this step without waiting. Never start the next delivery-plan step from here — review and commit come first, in either mode.
12. In gated mode, stop instead and present the user with end-of-step options:
    - Run `review-work` now (recommended)
    - Make a specific correction to this step
    - Pause here

## Plan Checklist Mirror

The plan doc's `## Delivery Plan` checklist is the source of truth; the panels below are one-way projections of it, so a step is never "done" until its `- [ ]` is `- [x]` in the doc.

- If your host agent has a native to-do / checklist tool (e.g. Claude Code's TodoWrite), mirror the plan steps into it at the start of the step so the checklist is visible while you work. Run `codument steps --plan <active-plan> --json` for the exact list — each item carries `text` plus a `status` of `completed` / `in_progress` / `pending` that maps directly onto the to-do tool. Mark the active step `in_progress`. If your host has no such tool, skip this silently.
- Run `codument steps --plan <active-plan> --emit` to log the active `step` event into `.codument/events.jsonl`, so anyone running `codument watch` sees the active step. It is idempotent — safe to run every step; it only appends when the active step changes.
- `codument steps` auto-detects the single approved plan with an unchecked step; pass `--plan docs/features/<name>.md` when more than one is active.

## Feature Map Materialization

When a step lands a NEW source file, route it via the approved plan's Feature Map instead of inventing a feature for it:

- Run `codument map materialize <file>` for each new source file. It creates the owning feature's registry entry + a doc scaffold (seeded from the Map's responsibility) the first time that feature appears, and appends to an existing feature otherwise — idempotently, keyed on the file's Map row. New entries are created with status `needs-review`.
- **An unmapped or ambiguous file is a flag, not a lump.** If `codument map materialize` reports the file unmapped (or two glob rows tie), STOP: add or tighten a Map row in the plan — never fold the file into an existing umbrella feature. The owner of a file is a decomposition decision, not a default.
- Because materialization is per-file and lazy, `doctor` is expected clean only at STEP BOUNDARIES — after every source file the step landed has been materialized. A half-materialized step will transiently show `unmapped-source`; that is the backstop working, not a failure.
- **Once the plan has shipped, name the owner directly.** The Feature Map is compacted out of a plan's doc when the last step lands, so a file added or renamed after that has no Map row to route through. Use `codument map materialize <file> --feature <slug>` — the same decision a Map row records, made inline. It refuses an unknown slug on purpose: a genuinely new feature needs a responsibility line to seed its doc, which is plan work, not a flag.
- **A second feature claiming the same file is a decision, so make it deliberately.** `map materialize` warns when a file becomes primary for more than one feature with no symbol claimed on it: from that moment every edit to it wakes all of those docs until the registry resolves the split. Take one of the two exits at the moment you see the warning — claim a symbol under one feature (`owned_symbols`), or keep one primary owner and give the rest a `[secondary: ...]` row so they carry the file as `related_sources`. Deferring it is how one file comes to wake five docs on a one-line edit, and nothing you can write in a doc will clear that.
- **A step that renames or deletes a mapped file updates the registry entry in the same step.** The registry is the control plane every later answer is derived from, so an entry left naming a path that no longer exists is a lie the gate now refuses to commit — re-point it for a rename, drop it for a deletion. Then make the separate judgment call the gate deliberately does not make for you: if the owning doc's Key files layer named the old path, update it; a pure move that no doc mentions owes no prose at all.
- **A step that GENERATES artifacts declares them in the same step.** Add the output path to the `exclude` block of `.codument-meta.json` when you write the generator, not when the files start showing up. A generated tree that stays ungoverned because its extension happens not to be a source extension is the right outcome reached by luck: change the generator to emit `.ts`, or register one of its files, and the gate wakes on every regeneration with nothing an author can say about it. `scan` already prints this signpost for swept build output; a step that creates the output is the one moment the intent is known.
- Then fill the materialized feature's `depends_on` and doc content as usual.

## End-Of-Step Gate

A completed implementation step is not ready for the next plan step until it has been reviewed and committed.

Stage the exact step before review. `review-work` runs `codument verify` over those staged bytes, so unrelated dirty work cannot enter the verdict. Mid-step `unmapped-source` is transient and fine; a red verifier at the boundary is not.

By default, skip the options below and continue directly to `review-work` for this step. In gated mode, when the implementation and verification are done, say plainly:

```text
Step N is implemented and verified. Next options:
1. Run /review-work on this step
2. Make a correction to this step
3. Pause here
```

Only after `review-work` is clean and `commit-work` has committed the slice may the next unchecked plan step start; offer it only in gated mode.

## Resume checkpoint

On pause or redirection, preserve a short checkpoint inside this plan's transient Delivery Plan: plan path, unfinished step, next gate, reason, and resume condition. Keep unfinished work unchecked and approval intact. On resume, use current docs and Git state to correct the checkpoint; a completed implementation still owes review and commit. Refresh the checkpoint when the next gate changes, and remove it after the recorded gate passes or the plan ships. This is a handoff, not a new lifecycle database.

If final-step compaction removed the original checklist, use the recovery copy at `.codument/pending-plans/<repo-relative-plan-path>` for its existing approval and pending gate; write any pause checkpoint there. It is recovery evidence for this selected plan, never a newly approved or discoverable plan. Reconcile it with Git and finish review/commit of the compacted boundary. If implementation must reopen, restore only the Delivery Plan block to its original doc, preserving the durable layers, and repeat verification and compaction before review. Retain the copy until the final commit succeeds.

## Rules

- Stop if the plan is missing, still draft, or ambiguous — this stops the whole run.
- Do not skip ahead to later steps.
- Never ask to start the next step at the end of implementation; review and commit come first.
- Do not bundle unrelated cleanup into the step.
- Keep the diff small enough to review.
- If implementation reveals a missing decision, pause and update the plan before continuing.
