---
title: Plan Step Mirroring
status: active
type: feature
owner: ""
sources:
  - src/lib/plan-steps.ts
  - src/commands/steps.ts
related:
  - src/cli.ts
  - src/commands/watch.ts
depends_on:
  - cli
  - lib
  - registry-health-and-change-control
last_reviewed: 2026-06-17
---

## Summary

Surfaces a plan's delivery-plan checklist where the agent can see it while coding: it parses the `## Delivery Plan` (or `Definition of Done`) `- [ ]` / `- [x]` items from the active plan doc and projects them two ways — into the host agent's native to-do panel (e.g. Claude Code's TodoWrite) and into `codument watch`'s activity tape as a `step` event.

The plan doc stays the single source of truth. Both projections are one-way and re-derived from the doc, so a step is never "done" until its checkbox is `[x]`. This closes the gap where the checklist lived only in a markdown file you had to open: `work-step` now mirrors it into the live view at the start of each step.

## How it works

1. **Parse (pure)** — `parseDeliveryPlan(markdown)` collects checkbox items under the first heading matching `Delivery Plan`, falling back to `Definition of Done`; checkboxes outside that section are ignored. Each `PlanStep` carries a 1-based ordinal `n` (not parsed from "Step 1a"-style labels), the full `text`, and `done`. `activeStep()` is the first unchecked step. `extractStatus()`/`isApproved()` read the plan's status (`approved` counts; `awaiting approval` deliberately does not).
2. **Discover (fs)** — `findActivePlans(root)` scans `docs/features` + `docs/concepts` for approved plans that still have an unchecked step, sorted by path; the single-element common case is the active plan. `loadPlan(root, path)` reads one specific doc.
3. **Project to the panel** — `todoStatus(plan, step)` maps each step to a native to-do status (`completed` / `in_progress` / `pending`) so the agent's mirror is a direct field copy. `codument steps --json` emits the whole list in that shape.
4. **Project to watch** — `emitActiveStep(root, plan)` appends a `type: "step"` event (`▶ <label>`, `data: {plan, n, total}`) to `.codument/events.jsonl`, which `watch`'s tape already renders. It is **idempotent**: it only appends when the latest `step` event for that plan names a different step, so re-running `work-step` (or a watch loop) never spams the tape.

The agent-facing seam is the `codument steps` command, which `work-step` calls (see the Plan Checklist Mirror section of that skill). On a host with no native to-do tool, the mirror is skipped silently and the `watch` tape remains the portable, cross-agent surface.

## Key files

- `src/lib/plan-steps.ts` — the whole mechanism: pure parsing (`parseDeliveryPlan`, `activeStep`, `extractStatus`, `isApproved`, `todoStatus`), fs discovery (`findActivePlans`, `loadPlan`), and the idempotent `emitActiveStep`.
- `src/commands/steps.ts` — the `codument steps` CLI action: plan resolution (`--plan` or single-approved-plan discovery), `--json` projection, `--emit`, and the human checklist.
- `src/cli.ts` — wires the `steps` command (related).
- `src/commands/watch.ts` — renders the emitted `step` event in its activity tape (related).
- `src/lib/events.ts` — the append-only event log `emitActiveStep` rides on (via the `lib` dependency).

## API / Interface

- `parseDeliveryPlan(markdown: string): PlanStep[]` — checklist steps from the Delivery Plan / Definition of Done section.
- `activeStep(steps: PlanStep[]): PlanStep | null` — first unchecked step.
- `extractStatus(markdown): string | null` / `isApproved(status): boolean` — plan status helpers.
- `todoStatus(plan: ActivePlan, step: PlanStep): "completed" | "in_progress" | "pending"`.
- `loadPlan(root, planPath): ActivePlan | null` / `findActivePlans(root): ActivePlan[]`.
- `emitActiveStep(root, plan): { emitted: boolean; step: PlanStep | null }` — idempotent `step` event append.
- CLI: `codument steps [--plan <path>] [--json] [--emit] [--dir <path>]`.

## Gotchas

- **One-way projection.** TodoWrite items and `step` events are ephemeral/per-session derivations; the plan doc's checkboxes are authoritative. Never write completion back from the panel — re-derive the panel from the doc at each step start.
- **Idempotency key is the plan path + ordinal.** `emitActiveStep` compares against the latest `step` event for the same `plan`; a different plan, or the same step already logged, both behave correctly (transition vs no-op).
- **Approval is exact.** `isApproved` requires the word `approved`; `awaiting approval` and `draft` are excluded, so `findActivePlans` won't surface a plan that hasn't cleared the approval gate.
- **Ambiguity is surfaced, not guessed.** With more than one approved-with-active plan, `codument steps` exits non-zero and asks for `--plan` rather than picking one.
- **Host-specific panel, portable tape.** The native to-do mirror only works where the host exposes such a tool (Claude Code today); `codument watch` is the cross-agent equivalent and needs no host support.
