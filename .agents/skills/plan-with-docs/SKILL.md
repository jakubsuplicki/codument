---
name: plan-with-docs
description: Turn resolved decisions into a Codument feature plan with scope, non-goals, acceptance criteria, verification strategy, and implementation steps.
---

# Plan With Docs

Use this after grilling has resolved enough uncertainty to create an implementation plan. The output is a durable feature or concept doc that the agent can resume from later.

Before lifecycle commands, run the session compatibility check from `work-step`: the actual
`codument --help` must list `work` and `verify`. Repair a mismatch before recording approval;
do not substitute older commands or manual checkpoints. Reuse a completed session check.

## Boundary With Grill With Docs

`plan-with-docs` is for writing the agreed plan, not for discovering the work's boundaries. Use it only when the important decisions are already settled enough to define scope, non-goals, acceptance criteria, verification, and implementation steps.

Do not use `plan-with-docs` yet if any meaningful decision is still open:

- product behavior, user workflow, or success criteria
- architecture, migration, compatibility, or data-shape tradeoffs
- scope, non-goals, rollout, or reversibility
- affected callers or dependencies whose treatment requires an unapproved behavior or architecture choice
- verification strategy or acceptance criteria
- the right durable doc home for the decision

When those questions remain, switch to `grill-with-docs` first. Ask one sharp decision question with a recommended answer, wait for the user to settle it, then return to planning.

## Workflow

1. Read `docs/overview.md` and the relevant docs and ADRs. Ground known paths together with one `codument context --paths <paths...>` query; use `--feature <slug>` when the feature is known instead. Reuse this planning context during implementation and refresh the affected working set when discoveries or routing changes make it stale. Single-file queries remain useful for ad-hoc ownership questions. Read `docs/.registry.json` when editing or assessing the whole map, or when the CLI is unavailable. `--budget <tokens>` is a soft target: optional context can be trimmed, but selected contracts may exceed it and must not be silently discarded.
2. Choose the narrowest doc home:
   - Feature behavior: `docs/features/{feature}.md`
   - Cross-cutting model or pattern: `docs/concepts/{concept}.md`
   - Hard-to-reverse architecture decision: `docs/architecture/decisions/{NNN}-{title}.md`
3. Write or update the **durable doc** in the documentation standard's layers (the `doc-audience-layers` concept): `## In plain terms`, `## Design approach`, `## Invariants & boundaries`, `## Decisions`, `## Key files`. Fill these at plan time — they are the knowledge that outlives the work, written at intent altitude (no identifiers, counts, or call order; that is mechanism and lives in code).
4. Append a **transient `## Delivery Plan`** block. New plans default to `Approval-Model: outcome-v1` in its header, alongside `Status: awaiting approval` and an optional `Plan-ID`. Include nonempty direct-child `### Outcome`, `### Constraints & non-goals`, `### Acceptance evidence`, and `### Verification` sections. Keep the milestone checklist in this selected block; Scope, Feature Map and implementation notes guide routing and cannot hide executable milestones. Sibling or historical plans cannot supply the contract. It compacts out when the work ships.
5. Show the delivery-plan checklist and approval contract inline (see Approval Summary), run the adversarial plan pass and fold its objections in, then stop and ask the user to approve or change the plan before implementation. Never make the user open the doc to see what they are approving. Compact verified cleanup uses its approval exception below.
6. After explicit human approval, change only that plan to exact `Status: approved`, run `codument work approve --plan <path>` (with `--plan-id` for an identified section), and stage the plan with `docs/.approvals.json`. Outcome approval binds promised milestones, outcome, constraints, acceptance evidence and verification; routing updates do not renew it. Existing approvals remain legacy and file-bound unless the human explicitly renews approval to adopt `outcome-v1`. Never silently add the model to an approved legacy plan. Checkbox and Resume checkpoint updates do not renew approval; frontmatter and another plan's approval authorize nothing.

## Delivery Plan Format

### Compact verified dead-code cleanup

For a small removal within an existing feature, use one short outcome Delivery Plan in its owning doc:
one checkbox, the explicitly permitted removal, constraints and non-goals, unused-code acceptance
evidence, and verification commands. The outcome is removal with unchanged supported behavior;
name the permitted deletion in the contract, not only advisory Scope. Do not create a new feature doc, Feature
Map, ADR, separate research phase or repeated checkpoints for that removal.

Eligibility requires checking callers, exports/public entry points, framework discovery, routes,
dynamic imports and side-effect registration. No textual imports alone is not proof. If any use or
behavioral effect remains uncertain, use the normal grilling/planning path. Include associated tests
and assets only when their removal is supported by the same evidence; retain coverage of live behavior.

Retain explicit human approval of the named removal and its limits. If the user already requested that removal
and the evidence confirms it without expanding scope, record that approval without asking again.
Otherwise present the compact step for approval. Skip the separate plan-adversary pass only for this
verified cleanup; the implementation still requires fresh independent review, ownership and registry
repair, any genuinely affected docs, project checks and staged `codument verify`.

Run the single step through review once; do not split it into planning/checkpoint/review substeps.
Honor a no-commit request by leaving verified work ready with its commit pending.

```markdown
## Delivery Plan

Status: awaiting approval
Approval-Model: outcome-v1

- [ ] Step 1: Export a project report for one representative CLI input.
- [ ] Step 2: Export the remaining supported input variants in a reviewable batch.

### Scope

- `src/example.ts` — the existing report-export boundary this plan changes.

### Outcome

A CLI user can export the current project's report in the documented format.

### Constraints & non-goals

Preserve existing formats and local-only operation; add no remote publishing or dependency.

### Acceptance evidence

A real CLI invocation exports the representative report, then each supported variant; invalid input is rejected.

### Verification

Run CLI integration checks for valid exports and invalid input, then the project's required checks.
```

## Feature Map (required when the plan introduces source files)

Tests are evidence, not source ownership. Keep test paths in Verification and invariant citations,
not Feature Map rows; `map check` and materialization share the same source exclusions.

A plan that adds source files MUST carry a fenced `feature-map` block. It routes each source path to its owning feature, and `work-step` consumes it via `codument map`. In an outcome plan this is editable routing guidance, not a permission boundary. A discovered file needs correct ownership and documentation; it needs renewed approval only if the work changes the approved contract. Legacy file-bound plans retain their scope rules.

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
`### Outcome` section inside the Delivery Plan and render it at the approval gate. Cover:

- **The concrete after-state**, before → after where it helps: what a user, repo, or caller gets
  that they did not have before. Group by the change that matters, not step-by-step.
- **Where it lands** — who notices and on which surface (the product, a consumer repo, a CLI).
- **What it deliberately does NOT do** — the honest limits and non-goals restated as outcomes, so
  approval is informed. A plan that lists only upside oversells.

Keep it to a few grouped outcomes plus the limits. It must follow from the steps — never promise an
outcome no step delivers.

For a costly build, include what it unblocks, a rough effort estimate, and the cheapest useful experiment that could disprove the approach before the expensive steps. Reuse an experiment already performed during grilling; do not create another approval gate or impose this exercise on a small reversible fix.

Pair each promised milestone with observable evidence in `### Acceptance evidence`; put how to obtain it in `### Verification`. Name the affected user or integration boundary, success and failure cases, and untested assumptions. State what a substitute establishes and which real integration remains unverified. If required evidence is unavailable, keep acceptance open and record the condition for completion; changing acceptance requires the human's approval.

## Approval Summary

The user approves from the chat, not by opening the doc — so the approval message must carry the plan's checklist, its outcome, and its open questions, not just a link to the file.

- Render the steps inline by running `codument steps --plan docs/features/<name>.md` (or the `docs/concepts/...` path) and showing its output. It reads the checklist back from the file you just wrote, so the summary the user approves is exactly what is on disk — no paraphrase drift. `--plan` works even though the plan is only "awaiting approval".
- If the CLI is unavailable, list each `- [ ]` step inline yourself.
- Render the plan's `### Outcome` inline alongside the steps — the user approves the *end state*, not just the task list. State what completing every step achieves and, honestly, what it does not. This is required, not optional: do not make the user ask "so what does this achieve?"
- Render the Open Questions inline too, each with its recommended default, so unresolved choices are settled at the gate rather than discovered mid-implementation.
- Keep the message to the step list, outcome, constraints, acceptance evidence and open questions, a line each; link the doc for full detail. The inline summary must never be a bare link.
- When the plan carries a Feature Map, run `codument map check --plan docs/features/<name>.md` and correct malformed routing before approval. Show the proposed ownership cut compactly; distinguish advisory paths from the contract the human approves. Legacy file-bound scope remains part of approval.
- Then run the **adversarial plan pass** below and fold its objections into the Open Questions you render, so the user approves against an independent check, not just the author's confidence.

## Adversarial plan pass (the plan adversary)

The symmetric twin of the implementation adversary in [review-work](../review-work/SKILL.md): an independent check that contests the plan *before* a line of code exists, folded into this same approval moment. Run it after the plan, its Outcome, and its open questions are written and the Feature Map is checked — and before you ask the user to approve or change. It never blocks and never rewrites the plan; it surfaces grounded objections and the user decides.

- **Ground it (and catch a broken Map).** Run `codument map check --plan docs/features/<name>.md --json`. Its `grounding` field is the adversary's oracle — the committed invariants, test pointers, dependency edges, and risk tags of owners named by explicit Scope and Feature Map, including direct docs and registered instructions, deterministic and identical on every host — so the adversary attacks a real contract instead of hallucinating one. Read `hasMap` and `malformedMap` first:
  - `malformedMap: true` — the plan wrote a "Feature Map" heading but not a parseable fenced ```feature-map``` block (a table or prose). Do NOT skip: surface this at the gate and fix the block, or the adversary silently reviews nothing.
  - `hasMap: false` and `malformedMap: false` — use the Scope grounding. No new files does not mean no contracts. Name each grounding omission and inspect its input before treating the plan as grounded; an empty grounding is a limitation, never a clean independent review.
  - `hasMap: true` — proceed with the pass below.
- **Run the pass — independence by host:**
  - **Host currently provides independent agents:** spawn a fresh `adversarial-planner` subagent with a fresh context (no inherited author conversation), fed ONLY the plan doc path and the grounding JSON — never your own reasoning or transcript. A reviewer that inherits the author's mental model rubber-stamps; the fresh context is the independence. It returns a `Checked against:` line and either "No material objections" or a list of grounded objections.
  - **Host currently provides no independent agent:** do NOT run a self-critique. The same context that wrote the plan arguing against it is the bias this pass exists to defeat, and — unlike the implementation gate, where a deterministic test still bites — a plan has no backstop, so a self-graded "no objections" is false confidence. Instead emit the grounding plus a short paste-ready prompt the user can run in a fresh session, and state plainly: "no independent plan pass ran automatically on this host."
- **Fold objections into the Approval Summary — never a second block.** Merge every grounded objection into the Open Questions list, one line each, ordered most-serious-first: the objection, the committed fact it cites, and the one decision it forces. Volume is bounded by materiality, not a cap — if the plan contradicts many facts, say so plainly (it likely needs rework) rather than trimming grounded findings. "No material objections" is the expected, correct result for a well-grilled plan: surface it in one line and move on.
- **The adversary never blocks and never reopens the grill on its own.** It informs the user's approve/change decision, which is the only adjudication; only the user routes work back to grilling.

## Milestones and delivery slices

Plan a representative end-to-end user or integration experience early. Describe milestones by
what can be demonstrated, not by internal modules completed. An infrastructure slice names the
observable milestone it unblocks and the evidence it contributes; infrastructure alone cannot
close that milestone's acceptance.

Keep each delivery step small enough for implementation, independent review and a focused commit.
Do not hide unbounded repetition in one step: use an end-to-end exemplar followed by explicit
reviewable batches, or explicit batches with the first batch proving the shared approach.
Approved milestone promises remain stable while implementation details evolve within them.

## Compaction on ship

The `## Delivery Plan` block is transient. When the final step passes implementation verification, preserve the approved plan and pending gate as described in `work-step` before compacting it. Lift any decision that outlived the work into `## Decisions` or an ADR, fold any newly-true constraint into `## Invariants & boundaries` (with a pointer to the test that enforces it, or mark it untested), then delete the checklist, acceptance criteria, verification strategy, and open questions. Keep still-open follow-ups in their owning docs; never turn an untested assumption into an invariant or lose it through compaction. Review and commit the compacted boundary before removing the recovery copy. What remains is the durable doc in the standard's layers; the step-by-step record lives in Git history. Never delete a superseded decision; move it to an ADR so the decision chain stays intact.

## Rules

- The durable doc follows the documentation standard's layers; the `## Delivery Plan` is transient and never becomes permanent doc content.
- Keep implementation steps independently reviewable and commit-sized; milestones describe observable value.
- Do not mix unrelated features into one plan.
- Do not begin source edits until approval is explicit.
- Do not use planning to decide unresolved product, architecture, migration, compatibility, or verification boundaries.
- Do not preserve working chatter once the durable decision is captured.
- If existing docs conflict with the requested plan, surface the conflict before writing the final plan.
