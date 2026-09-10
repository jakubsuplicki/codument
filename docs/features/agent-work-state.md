---
title: Agent work state
status: current
type: feature
last_reviewed: 2026-09-10
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
Final-plan compaction and automatic handoffs are integrated by the next approved delivery slice.

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

## Decisions

- [Approval binds the approved contract](../architecture/decisions/023-plan-approval-binds-the-approved-contract.md).

## Key files

- `src/commands/work.ts` — explicit work actions and readback.
- `src/lib/work-state.ts` — worktree selection, transitions and delivery reconciliation.
