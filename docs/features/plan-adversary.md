---
title: Plan adversary
status: in-progress
type: feature
owner: ""
primary_sources:
  - src/lib/plan-grounding.ts
related_sources:
  - src/commands/map.ts
  - src/lib/agent-profiles.ts
docs:
  - agents/adversarial-planner.md
depends_on:
  - adversarial-review-gate
  - feature-decomposition
  - agent-delivery-workflow
  - lib
risk: []
last_reviewed: 2026-06-30
---

# Plan adversary

## In plain terms

The [adversarial review gate](adversarial-review-gate.md) contests the diff after the work; this contests the **plan before** the work. Once grilling has resolved the open questions and the plan is surfaced, an independent adversary reads the written plan and argues against it — but only with **grounded** objections. Each objection must cite a committed constraint the plan contradicts (a dependency edge, an ADR, a documented invariant, a feature-map row), or name a load-bearing assumption the grill left unresolved. It hands the user every grounded objection — one tight line each, ordered most-serious-first — folded into the same approval summary the user already reads, and the user decides (dismiss it, or hand it back to the authoring agent to rebut). It never blocks, never rewrites the plan, never reopens the grill on its own.

"No material objections" is the correct, expected outcome for a well-grilled plan. The adversary is not there to disagree for the sake of looking useful; it exists to catch a plan that fights the facts, and to stay silent when the plan holds.

The two adversaries are one thesis at the two moments an agent commits to something: one before the first line of code, one before the commit. The cheapest bug to kill is the one caught before it is written.

## Design approach

- **It rides the existing approval moment, not a new gate.** The planning workflow already writes the plan's steps, outcome, and open questions, runs the plan's shape check, and stops for the user to approve or change. The adversary slots in there: after the plan is written and shape-checked, before the human decides. Its objections fold into the single open-questions block the user already reads, so there is never a second competing list — the text overload this design exists to avoid.

- **The objection's ground truth is the same kind of oracle the implementation adversary uses, projected to plan time.** A "review my plan" agent with no ground truth nitpicks; Codument hands the adversary the committed constraints the plan must honor — the invariants and test pointers of the features the plan's Feature Map routes to, their dependency edges, and their risk tags — derived deterministically from the registry and the feature docs, with no new source of truth and no model call. An objection that cannot cite one of these facts is not material and is dropped. This is the plan-time analog of "verify, don't trust": the implementation adversary's candidate findings are filtered by a test that runs red; the plan adversary's are filtered by a constraint that is actually written down.

- **Independence is by fresh context, and degrades honestly, not into theater.** On a host with subagents the adversary is a fresh subagent fed only the plan and the grounding, never the author's reasoning, so it cannot re-anchor to the author's mental model. On a host without subagents it does NOT run a self-critique: the same context that wrote the plan arguing against its own plan is exactly the completion bias the thesis exists to defeat — and, unlike the implementation gate where a deterministic test still bites regardless of who reviews, a plan has no such backstop, so a self-graded "no objections" would be false confidence dressed as scrutiny. There the workflow emits the grounding plus a paste-ready prompt and states plainly that no independent pass ran on this host. Real independence where the host offers it; honesty where it does not.

- **Proportionality is structural.** A plan that introduces no source files carries no Feature Map and routes to no documented invariant, so there is nothing to ground an objection against; the adversary is skipped and the approval summary says so in one line. Because the grill ran immediately before, re-raising an assumption the grill already settled is an explicit non-objection — the adversary's unique surface is the written plan itself (its scope rows, its non-goals, its cut), not the pre-plan decisions.

## Invariants & boundaries

- **The adversary's judgment is never auto-trusted as a verdict and never blocks.** It surfaces objections to the human, who adjudicates at the existing approve/change gate; it cannot gate, commit, or reopen the grill on its own. *(boundary — enforced by the planning workflow and the `adversarial-planner` mandate, not by codument code)*
- **An objection is material only if it cites a committed constraint the written plan contradicts, or a load-bearing assumption the grill left unresolved.** An objection that cannot cite a grounding fact is dropped, never softened into advisory padding. "No material objections" is the expected output for a plan consistent with its constraints, and manufacturing a weak objection is the cardinal failure. *(enforced by the `adversarial-planner` mandate; no code gate — the honesty-is-load-bearing limit recorded in [ADR 011](../architecture/decisions/011-plan-adversary-human-adjudicated-grounded-no-artifact.md))*
- **Volume is bounded by materiality, not by a fixed cap: every grounded objection is surfaced, one line each, ordered most-serious-first; ungrounded ones are dropped.** Truncating away a grounded objection is a false negative and is not allowed — if the plan contradicts many committed facts, that scale is itself the headline, never trimmed to look tidy. Objections fold into the single existing open-questions block, never a second list. *(workflow + mandate contract)*
- **Independence is by fresh context.** On a subagent-capable host the adversary never receives the author's transcript; on a host without subagents no independent pass runs automatically and the output says so — a self-critiquing author is never presented as an adversary. *(test: init.test.ts — the `adversarial-planner` def installs only on the subagent-capable Claude profile, none on Codex)*
- **The grounding is a deterministic projection over the registry and committed feature docs** (invariants, test pointers, dependency edges, risk tags), introducing no new source of truth and no model call; both hosts consume identical grounding. *(test: plan-grounding.test.ts — `buildPlanGrounding` is a pure, order-independent projection; `gatherPlanGrounding` + `map check --json` read it off disk)*
- **A plan that introduces no source files runs no adversary.** *(test: plan-grounding.test.ts — `map check --plan --json` reports `hasMap:false` with empty grounding when the plan carries no Feature Map; the skip itself is enforced by the planning workflow)*
- **A Feature Map written in the wrong form is flagged, never silently skipped.** A plan that has a "Feature Map" heading but no parseable fenced ```feature-map``` block (a table or prose) routes nothing, so the proportionality skip would wrongly bypass the adversary; `map check --json` reports `malformedMap:true` and the workflow surfaces it instead of skipping. *(test: plan-grounding.test.ts — `malformedMap` on a table-form Feature Map; feature-map.test.ts — hasFeatureMapHeading)*

## Decisions

All four are recorded in [ADR 011 — Plan adversary: human-adjudicated, grounded, no artifact](../architecture/decisions/011-plan-adversary-human-adjudicated-grounded-no-artifact.md).

- **No artifact, no flag, no confirm step.** The implementation gate's fingerprint artifact, opt-in flag, writer command, and test-confirm existed solely to bind a verdict across the review-to-commit temporal gap. The plan adversary surfaces synchronously into the same approval moment, so there is no gap to bridge and nothing to re-derive — all of it is correctly omitted.
- **Human-adjudicated, not test-confirmed.** A plan has no executable oracle. The honest deterministic analog is groundedness — does the objection cite a real, written constraint — not correctness. The human is the adjudicator.
- **A host without subagents gets a manual-independence handoff, not a labeled self-critique** — the implementation gate's "same-agent pass is not theater" justification does not transfer, because no deterministic step backs a plan.
- **Grounding piggybacks on the existing plan shape-check via a small pure projection module, not a standalone command** — it reuses the existing routing and the invariants/test-pointer extraction helpers; the projection lives in its own module for testability and clean ownership rather than inlined into the command.

## Key files

- `src/lib/plan-grounding.ts` (new) — the pure projection: from the plan's Feature-Map rows and the registry, emit each routed and adjacent feature's invariants, test pointers, dependency edges, and risk tags. No model call, no new source of truth.
- `src/commands/map.ts` — the plan shape-check calls the projection and emits the grounding alongside its existing checks (the step the planning workflow already runs at the gate).
- `agents/adversarial-planner.md` (new) — the adversary mandate: attack the written plan against the grounding only, the material-objection definition, one tight line each ordered most-serious-first, "no objections is the expected output," the "checked against" audit line, never rewrite, never block. Installed only into a subagent-capable profile via `AGENT_DEFINITIONS`.
- `skills/plan-with-docs/SKILL.md` — wires the adversary into the Approval Summary: the proportionality skip, the fresh-subagent spawn or the honest handoff, and the fold of objections into the open-questions block.
- `src/lib/agent-profiles.ts` — registers the new agent def in `AGENT_DEFINITIONS`.

## Delivery plan

Status: approved (2026-07-01). Implementing one step at a time; commits held at the user's request until they say otherwise. Transient scaffolding; compacts out on ship, surviving decisions move to the Decisions layer and an ADR.

The source cut, routed to owning features (the one new file plus the existing files this plan edits):

```feature-map
src/lib/plan-grounding.ts | plan-adversary        | feature | plan-time grounding projection: the adversary's oracle (invariants/tests/deps/risk)
src/commands/map.ts       | feature-decomposition | feature | map check --plan --json emits the grounding
src/lib/agent-profiles.ts | lib                   | concept | registers the adversarial-planner agent def
src/cli.ts                | cli                   | feature | the --json flag on map check
```

Only `plan-grounding.ts` is new (owned by **plan-adversary**); the other three are additive edits to their existing owners. The managed files this plan also adds — `agents/adversarial-planner.md` (the adversary mandate) and the wiring in `skills/plan-with-docs/SKILL.md` — are docs, not source, so they ride the registry `docs` list rather than a Map row.

Cross-feature note: the edits to `map.ts`, `agent-profiles.ts`, and `cli.ts` are additive (a new emission, a new install entry, a new flag) and change no existing contract — acked contract-neutral where the freshness gate flags a move.

### Steps

- [x] **Step 1 — Plan-grounding projection.** New `src/lib/plan-grounding.ts`: pure function from Feature-Map rows + registry + feature docs to per-feature `{invariants, test pointers, depends_on, risk}`, reusing the existing routing and the invariants/test-pointer extraction helpers. Register the plan-adversary feature in `docs/.registry.json` with this as its first primary source. *(`src/lib/plan-grounding.ts` + `tests/plan-grounding.test.ts`: pure `buildPlanGrounding` — routed + one-hop deps, unknown-feature flag, order-independent — and the disk-reading `gatherPlanGrounding`.)*
- [x] **Step 2 — Emit grounding from the plan shape-check.** Have the existing `map check --plan` call the projection and emit the grounding block; the shape check is untouched. *(`--json` branch in `mapCheck` + `--json` flag in `cli.ts`; `tests/plan-grounding.test.ts` covers the CLI emit + the no-map `hasMap:false` case.)*
- [x] **Step 3 — The adversarial-planner agent def.** Write `agents/adversarial-planner.md`, porting the implementation adversary's honesty and audit contract: the material-objection definition, one line each ordered most-serious-first, "no objections is expected," the "checked against" line, never rewrite or block, scope to the grill's delta. Register in `AGENT_DEFINITIONS`; installs only on subagent-capable profiles. *(`agents/adversarial-planner.md` + `agent-profiles.ts`; `tests/init.test.ts`: both adversary defs install on Claude, none on Codex.)*
- [x] **Step 4 — Wire into the planning workflow.** At the Approval Summary: the proportionality skip (no Feature Map means no adversary, noted in one line); the fresh-subagent spawn on a subagent host fed only the plan + grounding; the honest handoff otherwise (grounding + paste-ready prompt + "no independent pass ran on this host"); fold every grounded objection (one line each, ordered most-serious-first) into the existing open-questions block. *(`skills/plan-with-docs/SKILL.md`.)*
- [x] **Step 5 — ADR + dogfood + finalize.** ADR capturing the four decisions (no-artifact, human-adjudicated, host-honest-handoff, grounding-via-shape-check). Run the adversarial-planner on a real plan as a dogfood. Fill the Invariants test pointers, finalize the registry entry, `review --strict` green. *([ADR 011](../architecture/decisions/011-plan-adversary-human-adjudicated-grounded-no-artifact.md); Invariants pointers filled; registry finalized; `review --strict` exits 0. **Dogfooded**: the adversary ran its shipped mandate on this very plan against real grounding (8 features, incl. change-control-gate's data-loss risk) and returned "no material objections" without manufacturing noise — after the dogfood setup caught this plan's own Feature Map written as a table instead of a fenced `feature-map` block, since fixed. Two independent implementation reviewers found 0 bugs across 23 probed invariants.)*

### Acceptance criteria

- The grounding is reproducible from the registry + committed feature docs, with no model call and no new source of truth.
- On a Feature-Map-bearing plan that contradicts a documented invariant or dependency edge, the adversary surfaces a grounded objection citing that fact; on a plan consistent with its constraints it returns "No material objections."
- Objections fold into the single approval summary, one line each, ordered most-serious-first; volume is bounded by materiality (grounded objections are never truncated to a fixed number), never a second list.
- A plan with no Feature Map runs no adversary.
- On a subagent-capable host a fresh subagent runs with no author transcript; on a host without subagents no auto self-critique runs and the output says so.
- The adversary never blocks, never rewrites the plan, never reopens the grill.

### Verification strategy

- Unit tests for the grounding projection (deterministic output from a fixed registry + docs).
- Tests for the plan shape-check emitting the grounding.
- Install tests proving the agent def lands only on subagent-capable profiles.
- Dogfood: run the adversary on a real plan; confirm grounded objections and a clean "no objections" path.
- `npm run typecheck`, `npm run build`, `npm test` on every source-touching step.

### Non-goals

- No artifact, no `--require-plan-review` flag, no writer command, no test-confirm — there is no review-to-commit gap to bridge.
- No blocking, no auto-fix, no auto-reopening the grill — the human adjudicates.
- No self-critique presented as independent review on a host without subagents.
- No plan score or numeric rubric; the only classification is material / not-material, and objections are simply ordered most-serious-first — nothing heavier.
- No re-litigating assumptions the grill already resolved.

### Open questions

- The grounding projection is a small owned module (`plan-grounding.ts`) rather than inlined into `map.ts` — a deliberate refinement of the stress-tested design for testability and clean feature ownership. Recommended default: keep it a module. Flag if you'd rather inline it.
