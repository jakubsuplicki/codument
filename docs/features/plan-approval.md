---
title: Plan approval
status: current
type: feature
last_reviewed: 2026-09-10
---

# Plan approval

## In plain terms

Human approval applies to the plan that was shown. Changing its intended work makes that approval
stale; recording progress does not. Agents can see whether approval matches, is stale, or exists
only as a legacy Markdown declaration.

## Design approach

A tracked approval record retains the selected contract and its revision identity. The plan keeps
its checklist, and a stable identifier distinguishes work sharing a documentation page. Verification
reads approval and plan content from the same Git snapshot. Recording approval is an explicit action
after the human approves; the tool records attribution without authenticating it.

New projects require a bound approval for governed changes. Existing projects opt in after reviewing
their workflow. A recorded plan cannot silently fall back to legacy approval when its identity or
binding disappears. Conflicting writers and invalid state require recovery rather than replacement
with defaults. Durable knowledge outside an embedded plan remains independently maintainable.

Final preparation binds the compacted document and delivery changes to a Git base while retaining
the approved contract. Only that binding's own payload is canonicalized out of its digest; approval
contracts and all other changes remain covered. A later change cannot inherit archived permission.
Preparation precedes final review, and corrections require preparing and verifying the boundary again.

## Invariants & boundaries

- Approval includes the source map actually consumed by routing, including a supported sibling map outside a standalone delivery section. Scope verification and checklist discovery share the same ambiguity refusal. *(test: `plan-approval.test.ts`)*

- Changes to intended work, scope, outcomes, decisions or examples invalidate approval. Completion,
  resume notes and line-ending conversion preserve it. Resume notes cannot supply executable steps,
  scope or source ownership. *(test: `plan-approval.test.ts`)*
- Approval never borrows another identified section's scope or map; ambiguous selection requires
  an explicit identity. Missing, inconsistent and unsupported records cannot authorize work.
  *(test: `plan-approval.test.ts`)*
- Recording is idempotent for the same approved contract; writer locks and revision checks prevent
  accidental lost updates. An interrupted identity write leaves unbound work rather than approval.
  *(test: `plan-approval.test.ts`; interruption between writes is untested)*
- Unstaged approval cannot authorize a staged change or refresh a stale staged contract. A project
  requiring bound approval refuses governed changes without an eligible plan. *(test: `work.test.ts`)*
- Attribution is self-reported. The local filesystem permissions remain the trust boundary; a
  digest is a change detector, not proof that a human approved. *(architectural boundary)*
- Final approval remains verifiable from tracked data after compaction, including a fresh clone and
  a broader review range. Changed delivery content invalidates it; an archived identity cannot
  authorize new work. *(test: `work.test.ts`)*
- Compaction removes only the selected section and preserves sibling plans. Restoring an archived
  unchecked checklist grants no execution, while saved pending delivery can resume for corrections.
  *(test: `work.test.ts`)*

## Decisions

- [Approval binds the approved contract](../architecture/decisions/023-plan-approval-binds-the-approved-contract.md).

## Key files

- `src/lib/plan-approval.ts` — revision validation and explicit recording.
- `src/lib/plan-steps.ts` — shared section and progress interpretation.
- `src/commands/work.ts` — explicit recording surface.
