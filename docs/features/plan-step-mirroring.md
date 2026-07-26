---
title: Plan step mirroring
status: current
type: feature
last_reviewed: 2026-06-29
---

# Plan step mirroring

## In plain terms

A delivery-plan checklist normally lives only in a markdown file you have to open. This feature surfaces it where the agent already looks while coding: it reads the plan doc's checklist and projects the steps two ways, into the host agent's native to-do panel and into `codument watch`'s activity tape. The plan doc stays the one source of truth, so a step is never "done" until its checkbox is, and both projections are re-derived from the doc rather than written back to it. Open this when you want to understand how the live step view stays honest to the plan.

## Design approach

The plan doc is authoritative and the projections are strictly one-way. Completion lives in the checkbox; the panel and the tape are read-only mirrors re-derived at each step start, never a place where progress is recorded. This is the whole point: a checklist that can be edited from two places becomes two sources of truth that drift, the exact failure the change-control discipline exists to prevent. So no path writes step completion back from a panel.

The work splits into a pure core and thin side-effecting seams, because the checkbox-and-status logic is the part worth testing exhaustively on plain strings. Pure parsing turns plan markdown into an ordered step list with a status and an active (first-unchecked) step; small filesystem discovery finds plans on disk; a single emit seam logs to the event tape. The step ordinal is positional, assigned by checklist order, not lifted from any "Step N" label in the text, so human-authored labels can be anything without throwing off the mirror.

Two projection surfaces serve two different reach levels. The native to-do panel is host-specific and richer, available only where the host exposes such a tool, so on a host without one the mirror is skipped silently rather than failing. The `watch` tape is the portable, cross-agent equivalent that needs no host support, which is why the emitted step event is the durable surface and the panel is the bonus.

Plan discovery is deliberately conservative about what counts as "the plan you are working on": only an approved plan that still has an unchecked step. Approval is an exact status, not a word inside one, so a plan that is merely awaiting approval — or explicitly not approved — is excluded and never auto-surfaced. The same predicate is shared with the change-control gate's plan-scope detection, so the two surfaces can never disagree about whether a plan is approved. When discovery is ambiguous (more than one candidate) the command refuses and asks for an explicit choice rather than guessing, since picking the wrong plan would mirror the wrong work.

The tape projection is idempotent. Logging the same active step repeatedly must not spam the tape, so an append happens only when the latest step event for that plan names a different step. This makes re-running the step command, or a watch loop, safe to call as often as the loop wants.

## Invariants & boundaries

- The checklist comes from the Delivery Plan section if present, else Definition of Done, and checkboxes outside the chosen section are ignored. *(test: `plan-steps.test.ts` `parseDeliveryPlan` "ignores checkboxes outside the chosen section" + "prefers Delivery Plan over Definition of Done when both exist")*
- A section is scoped by heading depth: it runs to the next heading at the same or a shallower level, so a checklist filed under a subheading still belongs to the plan while a sibling section's checkboxes never do. Depth is what makes "outside the section" mean something — ending a section at any heading at all made every plan that files its steps under `### As-built`-style subheadings report no checklist, which silently hid unfinished work from plan discovery. *(test: `plan-steps.test.ts` "reads a checklist filed under a subheading that does not itself match" + "still ends a section at a sibling heading, not just a shallower one")*
- A doc may carry more than one Delivery Plan section, because a long-lived feature doc accumulates one per shipped effort. The chosen section is the first with an unchecked step, falling back to the last when every plan is complete — the same "has unfinished work" predicate plan discovery uses, so a single doc and a directory of docs can never disagree about which plan is active. *(test: `plan-steps.test.ts` `parseDeliveryPlan across multiple plan sections`)*
- The step ordinal is positional within the checklist, not parsed from any "Step N" label in the step text. *(test: `plan-steps.test.ts` `parseDeliveryPlan` "extracts ordered steps with done flags from the Delivery Plan section")*
- The active step is the first unchecked one, and a fully-checked plan has no active step. *(test: `plan-steps.test.ts` `activeStep / todoStatus` "returns the first unchecked step" + "returns null when every step is done")*
- Approval means EXACTLY the status "approved" (markdown-stripped): "awaiting approval", "not approved", and "never approved" are all not approved — an explicitly rejected plan can never drive the workflow. The predicate is the single shared one the scope gate also uses. *(tests: `plan-steps.test.ts` `extractStatus / isApproved` including "an explicitly REJECTED plan is never approved"; `change-state.test.ts` "detectApprovedPlanScope — one approval predicate with steps")*
- Auto-discovery surfaces only approved plans that still have an unchecked step; a draft or fully-complete plan is excluded. *(test: `plan-steps.test.ts` `findActivePlans / loadPlan (fs discovery)` "finds the single approved plan that still has an unchecked step")*
- Ambiguity is surfaced, not guessed: with more than one approved-with-active plan the command exits non-zero and asks for an explicit plan; an explicit plan resolves it. *(test: `steps.test.ts` `codument steps (CLI, temp repo)` "reads a specific doc with --plan even when discovery would be ambiguous")*
- An explicit plan via `--plan` does not require approval, so the approval gate never blocks reading a named plan (e.g. the plan-approval summary path). *(test: `steps.test.ts` `codument steps (CLI, temp repo)` "renders an awaiting-approval plan via --plan (the plan-approval summary path)")*
- The tape projection is idempotent: it appends a step event only when the active step changed, and emits the next step once the plan advances. *(test: `plan-steps.test.ts` `emitActiveStep (idempotent step events)` "appends a step event for the active step, then is a no-op on repeat" + "emits the next step once the plan advances")*
- An emitted step event renders in the `watch` activity tape, keeping the cross-agent surface in sync with the plan. *(test: `plan-steps.test.ts` `watch tape integration` "the emitted step event renders in the watch activity tape")*
- The projections are one-way: completion is read from the doc's checkboxes, never written back from a panel or tape. *(structural boundary — no code path writes completion back; the to-do status is a pure derivation of doc state, covered by `plan-steps.test.ts` `activeStep / todoStatus` "maps done/active/pending to native to-do statuses")*

## Key files

- `src/lib/plan-steps.ts` — the engine: pure checklist-and-status parsing, the small filesystem discovery of candidate plans, and the idempotent step-event emit.
- `src/commands/steps.ts` — the `codument steps` command surface: resolves which plan to read, then renders the human checklist or the machine projection used to mirror into a native to-do panel.
- `src/cli.ts` — wires the `steps` command and its flags into the CLI (related).
- `src/commands/watch.ts` — renders the emitted step event in its live activity tape, the portable cross-agent surface (related).
