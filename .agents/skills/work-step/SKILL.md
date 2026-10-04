---
name: work-step
description: Execute the next approved Codument delivery-plan step, using the relevant implementation and verification skills.
---

# Work Step

Use this when the user says to continue, work the next step, or implement the approved plan.

## Compatibility and project checks

At the first delivery action in a session, inspect `codument --help` from the executable you will
actually use: it must list `work` and `verify`. A version string alone does not establish capability.
If either is absent, repair the installation before executing this workflow: rebuild a linked
Codument checkout with `npm run build`, or install the matching package and run `codument update`.
Do not substitute older commands or invent manual approval/review checkpoints. Reuse this check
for the session unless the executable changes.

Run the project's existing relevant tests, lint and type checks. Codument's named-test reproduction
is a separate review check, not a requirement to install its own test runner. When reproduction is
needed, declare the project's file-targeted runner once with `testCommand` in `.codument-meta.json`
(including `{file}`); use a TAP reporter so failures are distinguishable from toolchain errors.

## Workflow

1. Read `codument work status --json` and the selected plan under `docs/features`, `docs/concepts`, or `docs/plans`. Reconcile saved work with Git; hand its pending review or commit to the owning skill before starting another step. Explicitly resume interrupted work only when its resume condition is satisfied and the user has authorized continuation.
2. Confirm current bound approval with `codument steps --plan <path> --json`. Record approval with `work approve` only after actual human approval. For `outcome-v1`, compare work with the approved outcome, milestone, constraints, acceptance evidence and verification; implementation routing discoveries alone do not require an amendment. Legacy file-bound plans retain their scope gate, and existing approvals cannot adopt outcome permission without renewed human approval. Approval does not mean paused work is running.
3. Start new selected work with `codument work start --plan <path>`. Switching plans requires `--reason` and preserves the old plan; use `work supersede` only for an explicit replacement decision. Pick the first unchecked step only after any saved delivery has passed its pending gate.
4. Surface the checklist in the live view (see Plan Checklist Mirror below): mirror the plan's steps into your host's native to-do panel with the step you are about to implement marked in progress, and run `codument steps --plan <active-plan> --emit` so `codument watch` shows the active step. Post that checklist inline in the chat as well — the step just completed, the step now starting, and what remains — because the native to-do panel and the watch tape are not the chat transcript, and a run that does not wait between steps otherwise advances with no in-chat marker.
5. Reuse the grounded planning context and read its owning docs, invariants and tests. If it is missing or stale, query the affected paths together with `codument context --paths <paths...>`, or use `--plan <active-plan>` / `--feature <slug>` for the selected working set. Refresh after routing discoveries as needed; no ownership query is owed before and after every file. Read the whole registry when editing the map or when the CLI is unavailable. A context budget is soft: selected contracts may exceed it and must not be silently discarded.
6. Implement only that step toward its observable milestone. An infrastructure slice names the milestone it unblocks; do not claim that milestone complete without its promised evidence.
7. Use `tdd` or the strongest practical verification loop. Diagnose routine test, mapping and documentation failures, correct their cause within the approved contract, and rerun the affected checks. A failed check prevents delivery while red; it does not by itself require human intervention. Use the repair boundary below.
8. Batch new source registration with `codument map materialize <files...>` (see Feature Map Materialization), then update the mapped docs + registry as part of the same step.
9. Mark the step complete — in the plan doc, and in the mirrored native to-do list — only after implementation verification passes. Before final-step compaction, save the approved plan with a pending-review checkpoint at `.codument/pending-plans/<repo-relative-plan-path>`; keep this recovery copy outside the staged step. Then compact the `## Delivery Plan` block per `plan-with-docs` (Compaction on ship): lift surviving decisions into `## Decisions`/ADRs and any newly-true constraint into `## Invariants & boundaries`, then delete the delivery scaffolding so the durable doc is left in the standard's layers.
10. Stage only the files belonging to this step. For the compacted final step, run `codument work finish --prepare-final`, then stage `docs/.approvals.json`; this binds the retained approved contract to the final staged delivery. Repeat preparation after any boundary correction. The ignored recovery copy is context, never the only approval evidence. Record the pending gate with `codument work resume --gate review` before handing off.
11. Proceed directly to `review-work` for this step without waiting. It selects focused self-review or independent adversarial review from the generated minimum effort and the change's semantics. Never start the next delivery-plan step from here — review and commit come first, in either mode.
12. In gated mode, stop instead and present the user with end-of-step options:
    - Run `review-work` now (recommended)
    - Make a specific correction to this step
    - Pause here

## Plan Checklist Mirror

For the compact dead-code cleanup path in `plan-with-docs`, one inline checklist is sufficient.
Skip duplicate native to-do and watch-event projections unless requested. Preserve the work state,
staged verification, independent review and no-commit handoff; add a Resume checkpoint only if
interrupted, not after each command.

The plan doc's `## Delivery Plan` checklist is the source of truth; the panels below are one-way projections of it, so a step is never "done" until its `- [ ]` is `- [x]` in the doc.

- If your host agent has a native to-do / checklist tool (e.g. Claude Code's TodoWrite), mirror the plan steps into it at the start of the step so the checklist is visible while you work. Run `codument steps --plan <active-plan> --json` for the exact list — each item carries `text` plus a `status` of `completed` / `in_progress` / `pending` that maps directly onto the to-do tool. Mark the active step `in_progress`. If your host has no such tool, skip this silently.
- Run `codument steps --plan <active-plan> --emit` to log the active `step` event into `.codument/events.jsonl`, so anyone running `codument watch` sees the active step. It is idempotent — safe to run every step; it only appends when the active step changes.
- `codument steps` auto-detects the single approved plan with an unchecked step; pass `--plan docs/features/<name>.md` when more than one is active.

## Feature Map Materialization

Route new source files through the selected plan's Feature Map:

- Run `codument map materialize <files...>` for the step's new sources together. The batch validates routing, source exclusions and path safety before mutation, then creates or extends each owning registry entry and seeds any new doc from the Map's responsibility. Existing tree ownership needs no per-file entries; new entries start at `needs-review`. Single-file materialization remains useful for an isolated addition.
- A routing or path-validation failure changes nothing; repair the declarations and retry the batch. An I/O failure can leave completed writes: inspect the reported results, correct the cause and retry idempotently. Never report the batch complete until all requested sources are governed and staged verification passes.
- **An unmapped or ambiguous file needs routing repair.** For an outcome plan, add or tighten the Map row and rerun materialization without a scope-amendment interruption when the discovered file serves the approved contract. Never fold it into an umbrella feature just to clear the check. For a legacy file-bound plan, preserve its existing approval boundary and renew approval when the routing change changes approved scope. Ask only when ownership exposes an unapproved product or architecture choice.
- `unmapped-source` can be transient during implementation; the staged boundary must account for all new sources before delivery.
- **Once the plan has shipped, name the owner directly.** The Feature Map compacts out when the last step lands. Group later additions by their known owner and use `codument map materialize <files...> --feature <slug>`. An unknown slug still needs a planned responsibility to seed its doc.
- **A second feature claiming the same file is a decision, so make it deliberately.** `map materialize` warns when a file becomes primary for more than one feature with no symbol claimed on it: from that moment every edit to it wakes all of those docs until the registry resolves the split. Take one of the two exits at the moment you see the warning — claim a symbol under one feature (`owned_symbols`), or keep one primary owner and give the rest a `[secondary: ...]` row so they carry the file as `related_sources`. Deferring it is how one file comes to wake five docs on a one-line edit, and nothing you can write in a doc will clear that.
- **A step that renames or deletes a mapped file updates the registry entry in the same step.** The registry is the control plane every later answer is derived from, so an entry left naming a path that no longer exists is a lie the gate now refuses to commit — re-point it for a rename, drop it for a deletion. Then make the separate judgment call the gate deliberately does not make for you: if the owning doc's Key files layer named the old path, update it; a pure move that no doc mentions owes no prose at all.
- **A step that GENERATES artifacts declares them in the same step.** Add the output path to the `exclude` block of `.codument-meta.json` when you write the generator, not when the files start showing up. A generated tree that stays ungoverned because its extension happens not to be a source extension is the right outcome reached by luck: change the generator to emit `.ts`, or register one of its files, and the gate wakes on every regeneration with nothing an author can say about it. `scan` already prints this signpost for swept build output; a step that creates the output is the one moment the intent is known.
- Then fill the materialized feature's `depends_on` and doc content as usual.

## Repair boundary

Continue diagnosis, correction and re-verification while the repair follows the approved outcome
and constraints. This includes newly discovered files in outcome plans, missing mappings, stale
docs, test regressions and obvious review fixes. Keep the exact staged review and receipt current;
never commit through a failing gate or silently weaken required evidence.

Pause when progress needs a genuinely unapproved decision, unavailable external input or a
genuinely irreversible action, or when the user explicitly pauses or selects gated mode. Changing
promised behavior, milestones, acceptance, architecture, compatibility, privacy, security or
spending constraints requires renewed approval. A public or security fix already dictated by the
contract does not require approval merely for touching that boundary. Respect single-step and
no-commit requests. Preserve the pending gate and resume condition whenever work must stop.

## End-Of-Step Gate

A completed implementation step is not ready for the next plan step until it has been reviewed and committed.

Stage the exact step before review. `review-work` runs `codument verify` over those staged bytes to check ownership, mapping and documentation together; unrelated dirty work cannot enter the verdict. This boundary check replaces per-file before/after ownership queries. Mid-step `unmapped-source` is transient and fine; a red verifier at the boundary is not.

By default, skip the options below and continue directly to `review-work` for this step. In gated mode, when the implementation and verification are done, say plainly:

```text
Step N is implemented and verified. Next options:
1. Run /review-work on this step
2. Make a correction to this step
3. Pause here
```

Only after `review-work` is clean and `commit-work` has committed the slice may the next unchecked plan step start; offer it only in gated mode.

## Resume checkpoint

Use `codument work pause --reason <text> --gate <gate>` for a pause, or `work block --reason <text> --resume-when <condition> --gate <gate>` for a blocker. Keep local state out of Git. It preserves selection and pending gates independently of approval. A no-commit request leaves verified work ready and the commit gate pending; it never marks delivery completed.

On pause or redirection, preserve a short checkpoint inside this plan's transient Delivery Plan: plan path, unfinished step, next gate, reason, and resume condition. Keep unfinished work unchecked and approval intact. On resume, use current docs and Git state to correct the checkpoint; a completed implementation still owes review and commit. Refresh the checkpoint when the next gate changes, and remove it after the recorded gate passes or the plan ships. This is a handoff, not a new lifecycle database.

If final-step compaction removed the original checklist, use the recovery copy at `.codument/pending-plans/<repo-relative-plan-path>` for its existing approval and pending gate; write any pause checkpoint there. It is recovery evidence for this selected plan, never a newly approved or discoverable plan. Reconcile it with Git and finish review/commit of the compacted boundary. If implementation must reopen, restore only the Delivery Plan block to its original doc, preserving the durable layers, and repeat verification and compaction before review. Retain the copy until the final commit succeeds.

## Rules

- Stop if the plan is missing, still draft, or ambiguous — this stops the whole run.
- Do not skip ahead to later steps.
- Never ask to start the next step at the end of implementation; review and commit come first.
- Do not bundle unrelated cleanup into the step.
- Keep the diff small enough to review.
- Repair implementation discoveries within the approved contract; pause only for a decision or input outside that permission (see Repair boundary).
