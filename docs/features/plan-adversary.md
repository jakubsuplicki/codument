---
title: Plan adversary
status: current
type: feature
last_reviewed: 2026-07-06
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
