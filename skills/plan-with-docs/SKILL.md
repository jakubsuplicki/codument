---
name: plan-with-docs
description: Turn resolved decisions into a Codument feature plan with scope, non-goals, acceptance criteria, verification strategy, and implementation steps.
---

# Plan With Docs

Use this after grilling has resolved enough uncertainty to create an implementation plan. The output is a durable feature or concept doc that the agent can resume from later.

## Boundary With Grill With Docs

`plan-with-docs` is for writing the agreed plan, not for discovering the work's boundaries. Use it only when the important decisions are already settled enough to define scope, non-goals, acceptance criteria, verification, and implementation steps.

Do not use `plan-with-docs` yet if any meaningful decision is still open:

- product behavior, user workflow, or success criteria
- architecture, migration, compatibility, or data-shape tradeoffs
- scope, non-goals, rollout, or reversibility
- affected callers, docs, tests, or dependent features
- verification strategy or acceptance criteria
- the right durable doc home for the decision

When those questions remain, switch to `grill-with-docs` first. Ask one sharp decision question with a recommended answer, wait for the user to settle it, then return to planning.

## Workflow

1. Read `docs/.registry.json`, `docs/overview.md`, relevant feature/concept docs, and relevant ADRs.
2. Choose the narrowest doc home:
   - Feature behavior: `docs/features/{feature}.md`
   - Cross-cutting model or pattern: `docs/concepts/{concept}.md`
   - Hard-to-reverse architecture decision: `docs/architecture/decisions/{NNN}-{title}.md`
3. Write or update the **durable doc** in the documentation standard's layers (the `doc-audience-layers` concept): `## In plain terms`, `## Design approach`, `## Invariants & boundaries`, `## Decisions`, `## Key files`. Fill these at plan time — they are the knowledge that outlives the work, written at intent altitude (no identifiers, counts, or call order; that is mechanism and lives in code).
4. Append a **transient `## Delivery Plan`** block — the working artifact, not durable doc content. It carries the step checklist, the Feature Map (when the plan introduces source files — see below), the Outcome, acceptance criteria, verification strategy, and open questions. It compacts out when the work ships (see Compaction on ship).
5. Mark the Delivery Plan as awaiting approval.
6. Show the delivery-plan checklist, the outcome, and the open questions inline (see Approval Summary), run the adversarial plan pass and fold its objections in, then stop and ask the user to approve or change the plan before implementation. Never make the user open the doc to see what they are approving.

## Delivery Plan Format

```markdown
## Delivery Plan

Status: draft, awaiting approval before source edits.

- [ ] Step 1: ...
- [ ] Step 2: ...
- [ ] Step 3: ...
```

## Feature Map (required when the plan introduces source files)

A plan that adds source files MUST carry a fenced `feature-map` block. This is the decomposition decision made explicit and approvable: it routes each source path to the feature that owns it, and `work-step` consumes it via `codument map` so files land in the right feature instead of being lumped into one umbrella feature.

```feature-map
src/fairness.ts | fairness    | feature | provably-fair seed/HMAC engine; isolated seam
src/board.ts    | board       | feature | canvas peg/slot render + ball animation
src/payouts.ts  | payouts     | concept | static multiplier tables
src/main.ts     | app-shell   | feature | DOM bootstrap + wiring  [secondary: game, board]
```

Each row is `path-or-glob | feature-slug | type (feature|concept) | one-line responsibility`, with an optional trailing `[secondary: a, b]` for files whose logic also belongs to other features (entry/wiring files especially).

How to draw the cut:

- **The default unit is the module, not the app.** Treat each module/responsibility you named in the plan as a *candidate feature*. Do not collapse the whole app into one feature — that reproduces the one-feature collapse where blast, cost, and drift cannot resolve.
- **Group only genuine single responsibilities.** Merge two files into one feature only when they are truly one thing.
- **Leaf utilities → `concept`.** Small tables, pure helpers, types, and barrels go to `type: concept` so they are documented without inflating the feature count.
- The slug becomes the doc/registry key (`docs/features/{slug}.md` or `docs/concepts/{slug}.md`); use kebab-case a developer would say out loud.

## Outcome (what completing the plan achieves)

The steps say what you will *do*; the Outcome says what is *true once they all land* — the end state
the user is approving, in their words, not a restatement of the steps. Write it as the plan's
`## Outcome` section and render it at the approval gate. Cover:

- **The concrete after-state**, before → after where it helps: what a user, repo, or caller gets
  that they did not have before. Group by the change that matters, not step-by-step.
- **Where it lands** — who notices and on which surface (the product, a consumer repo, a CLI).
- **What it deliberately does NOT do** — the honest limits and non-goals restated as outcomes, so
  approval is informed. A plan that lists only upside oversells.

Keep it to a few grouped outcomes plus the limits. It must follow from the steps — never promise an
outcome no step delivers.

## Approval Summary

The user approves from the chat, not by opening the doc — so the approval message must carry the plan's checklist, its outcome, and its open questions, not just a link to the file.

- Render the steps inline by running `codument steps --plan docs/features/<name>.md` (or the `docs/concepts/...` path) and showing its output. It reads the checklist back from the file you just wrote, so the summary the user approves is exactly what is on disk — no paraphrase drift. `--plan` works even though the plan is only "awaiting approval".
- If the CLI is unavailable, list each `- [ ]` step inline yourself.
- Render the plan's `## Outcome` inline alongside the steps — the user approves the *end state*, not just the task list. State what completing every step achieves and, honestly, what it does not. This is required, not optional: do not make the user ask "so what does this achieve?"
- Render the Open Questions inline too, each with its recommended default, so unresolved choices are settled at the gate rather than discovered mid-implementation.
- Keep the message to the step list, the outcome, and the open questions, plus a one-line scope / non-goals note; link the doc for full detail, but the inline summary must never be a bare link.
- When the plan carries a Feature Map, render it inline too (the human approves the *cut*, not just the steps) and run `codument map check --plan docs/features/<name>.md` — surface any malformed rows or a too-coarse-shape flag at the gate, before approval, where it can still be fixed.
- Then run the **adversarial plan pass** below and fold its objections into the Open Questions you render, so the user approves against an independent check, not just the author's confidence.

## Adversarial plan pass (the plan adversary)

The symmetric twin of the implementation adversary in [review-work](../review-work/SKILL.md): an independent check that contests the plan *before* a line of code exists, folded into this same approval moment. Run it after the plan, its Outcome, and its open questions are written and the Feature Map is checked — and before you ask the user to approve or change. It never blocks and never rewrites the plan; it surfaces grounded objections and the user decides.

- **Ground it (and catch a broken Map).** Run `codument map check --plan docs/features/<name>.md --json`. Its `grounding` field is the adversary's oracle — the committed invariants, test pointers, dependency edges, and risk tags of every feature the Map routes to, deterministic and identical on every host — so the adversary attacks a real contract instead of hallucinating one. Read `hasMap` and `malformedMap` first:
  - `malformedMap: true` — the plan wrote a "Feature Map" heading but not a parseable fenced ```feature-map``` block (a table or prose). Do NOT skip: surface this at the gate and fix the block, or the adversary silently reviews nothing.
  - `hasMap: false` and `malformedMap: false` — the plan genuinely introduces no source files, so it routes to no documented invariant and there is nothing to ground an objection against. Skip the pass and say so in one line ("no source files — no independent plan pass").
  - `hasMap: true` — proceed with the pass below.
- **Run the pass — independence by host:**
  - **Subagent-capable host (Claude):** spawn a fresh `adversarial-planner` subagent fed ONLY the plan doc path and the grounding JSON — never your own reasoning or transcript. A reviewer that inherits the author's mental model rubber-stamps; the fresh context is the independence. It returns a `Checked against:` line and either "No material objections" or a list of grounded objections.
  - **No-subagent host (Codex):** do NOT run a self-critique. The same context that wrote the plan arguing against it is the bias this pass exists to defeat, and — unlike the implementation gate, where a deterministic test still bites — a plan has no backstop, so a self-graded "no objections" is false confidence. Instead emit the grounding plus a short paste-ready prompt the user can run in a fresh session, and state plainly: "no independent plan pass ran automatically on this host."
- **Fold objections into the Approval Summary — never a second block.** Merge every grounded objection into the Open Questions list, one line each, ordered most-serious-first: the objection, the committed fact it cites, and the one decision it forces. Volume is bounded by materiality, not a cap — if the plan contradicts many facts, say so plainly (it likely needs rework) rather than trimming grounded findings. "No material objections" is the expected, correct result for a well-grilled plan: surface it in one line and move on.
- **The adversary never blocks and never reopens the grill on its own.** It informs the user's approve/change decision, which is the only adjudication; only the user routes work back to grilling.

## Compaction on ship

The `## Delivery Plan` block is transient. When the final step lands (the last `- [x]`), compact it: lift any decision that outlived the work into `## Decisions` or an ADR, fold any newly-true constraint into `## Invariants & boundaries` (with a pointer to the test that enforces it), then delete the checklist, acceptance criteria, verification strategy, and open questions — the step-by-step record already lives in git history. What remains is the durable doc in the standard's layers. A shipped feature doc that still carries a delivery checklist is the lifecycle bloat the standard exists to prevent. Never delete a superseded decision; move it to an ADR so the decision chain stays intact.

## Rules

- The durable doc follows the documentation standard's layers; the `## Delivery Plan` is transient and never becomes permanent doc content.
- Keep implementation steps independently reviewable and commit-sized.
- Do not mix unrelated features into one plan.
- Do not begin source edits until approval is explicit.
- Do not use planning to decide unresolved product, architecture, migration, compatibility, or verification boundaries.
- Do not preserve working chatter once the durable decision is captured.
- If existing docs conflict with the requested plan, surface the conflict before writing the final plan.
