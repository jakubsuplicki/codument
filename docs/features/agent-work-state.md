---
title: Agent work state
status: current
type: feature
last_reviewed: 2026-09-10
---

# Agent work state

## In plain terms

Explicit work commands record decisions that should survive an agent session. The approval action
records the human-approved plan revision and tells the agent which tracked records belong together.

## Design approach

Commands delegate policy and persistence to the owning model. Recording human approval is a
deliberate action; merely reading a plan or displaying its checklist grants nothing. Delivery-state
transitions remain a planned extension in the approved workflow plan.

## Invariants & boundaries

- The approval command requires an explicitly approved plan and reports self-reported attribution.
  A stale plan remains readable but cannot emit a start event. *(test: `work.test.ts`)*
- Plan identity is shared with checklist selection, preserving the intended section when a document
  holds several efforts. *(test: `plan-approval.test.ts`)*

## Decisions

- [Approval binds the approved contract](../architecture/decisions/023-plan-approval-binds-the-approved-contract.md).

## Key files

- `src/commands/work.ts` — explicit work actions and readback.
