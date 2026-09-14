---
title: Agent work state
status: current
type: feature
last_reviewed: 2026-09-11
---

# Agent work state

## In plain terms

Explicit work commands preserve the selected plan and pending gate across agent sessions. A pause,
block or change of priority retains unfinished work instead of making the next agent reconstruct it.
Ready means a verified step still awaits its commit; completed requires observed delivery.

## Design approach

The tracked approval owns permission and Markdown owns planned scope. Ignored local state belongs
to one worktree and records selection, interruption reasons, resume conditions and the pending gate.
Selecting another plan requires a reason; supersession explicitly names a replacement. Reading
status reconciles approval and Git evidence without rewriting saved state.

Finishing captures verification of the exact staged change and its approval. A matching committed
boundary advances progress using that commit's checklist, so unfinished delivery cannot disappear
behind newer working-tree edits or later unrelated commits. Recovery searches bounded reachable
history and reports when its window is exhausted. Conflicting writers and invalid or moved state
fail with a remedy.
Checklist, context, mapping and verification commands share selected work; an explicit preview of
another plan grants no execution. The live monitor displays saved interruption and pending gates.
Final compaction retains approval in tracked data and binds it to the exact final delivery. Recovery
notes remain local context, so a fresh checkout can verify delivery without them.
A direct commit made before readiness was saved can still reconcile final completion from matching
verification and committed delivery. Consumed approval alone never substitutes for missing review
evidence; missing or mismatched evidence requires recovery and cannot reopen permission.

## Invariants & boundaries

- The approval command requires an explicitly approved plan and reports self-reported attribution.
  A stale plan remains readable but cannot emit a start event. *(test: `work.test.ts`)*
- Plan identity is shared with checklist selection, preserving the intended section when a document
  holds several efforts. *(test: `plan-approval.test.ts`)*
- Only the selected plan can be active; switching, pausing and blocking retain prior work and never
  grant approval. Superseded work cannot silently restart. *(test: `work-state.test.ts`)*
- Corrupt, foreign-root, locked or concurrently changed state is never overwritten by a transition.
  Status reads do not mutate it. *(test: `work-state.test.ts`)*
- Readiness requires the exact verified staged step. Completion and the next step are inferred from
  committed progress, never uncommitted checkbox changes; later commits retain that evidence.
  *(test: `work.test.ts`)*
- A final checkbox does not prevent explicit resume while review or delivery remains pending.
  *(test: `work-state.test.ts`)*
- Paused work cannot emit execution or pass the execution gate. Final compaction survives a fresh
  checkout; later changes cannot reuse its archived approval. *(test: `work.test.ts`)*
- Final preparation checks the selected identity and expected state revision under its writer lock.
  Final read projections remain available through readiness and completion. *(test: `work.test.ts`)*
- An interruption before final preparation resumes only already-saved work whose recovery context
  matches the tracked approval. Explicit same-path resume preserves its saved section identity.
  Modified recovery scope cannot authorize continuation. *(test: `work.test.ts`)*
- Final delivery committed before local readiness was saved reconciles from its matching receipt,
  including after later unrelated commits, without touching newer staged work. Lost verification
  evidence is reported instead of manufacturing completion. *(test: `work.test.ts`)*

## Decisions

- [Approval binds the approved contract](../architecture/decisions/023-plan-approval-binds-the-approved-contract.md).

## Key files

- `src/commands/work.ts` — explicit work actions and readback.
- `src/lib/work-state.ts` — worktree selection, transitions and delivery reconciliation.
