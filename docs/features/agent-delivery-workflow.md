---
title: Agent Delivery Workflow
status: draft
type: feature
owner: ""
sources: []
depends_on:
  - commands
  - lib
last_reviewed: 2026-06-18
---

## Summary

Codument should become an agent-neutral delivery workflow, not only a documentation updater. The core loop is: grill the idea against project docs, write a durable plan, wait for human approval, implement one planned step at a time with verification, review the diff, update docs, commit, and repeat.

Docs remain the durable project memory and control surface. Working state should stay compact so Codument improves agent alignment without turning project documentation into a task journal.

## Current Decision

Codument's core product direction is shifting from "automated documentation for Claude Code" to "docs-backed delivery workflow for AI coding agents." Claude, Codex, and future tools should be installed through agent profiles that map the same core workflow into each agent's supported files and capabilities.

Backward compatibility with the current Claude-centered implementation is not required for this migration. The project is currently personal-use software, so the implementation may rewrite commands, generated files, documentation, tests, and package positioning around the new workflow instead of preserving old behavior.

## Workflow Shape

1. Route intent: before any source edit, name the assumption the change depends on; a load-bearing one you cannot confirm (or a still-rough request) needs `grill-with-docs`, while settled scope moves directly into `plan-with-docs`.
2. Grill with docs: resolve the load-bearing assumptions a change depends on against the existing overview, registry, feature docs, concept docs, ADRs, and code reality.
3. Plan with docs: write or update the relevant feature plan with scope, non-goals, acceptance criteria, verification strategy, and implementation steps.
4. Approval gate: do not start source edits until the user approves the plan.
5. Work step: pick the next unchecked step and implement only that slice.
6. Feedback loop: prefer red-green-refactor, but use the strongest practical verification loop for the change.
7. Docs update: update the registry and mapped docs as part of the same slice.
8. Review: compare the diff against the approved step, tests, docs, and architecture boundaries.
9. Commit: create a focused conventional commit after checks, docs, and review are complete.
10. Continue: choose the next step, plan review, context compaction, or pause.

Each implementation step has a hard gate: finish one `work-step`, stop for `review-work`, then stop for `commit-work`. The agent should not ask to start the next plan step until the current step has been reviewed and committed. Review findings are a user decision point: the agent lists required fixes, then waits for the user to approve all fixes, select specific fixes, defer specific findings with a reason, or pause.

The always-loaded agent instructions should route intent into that loop without requiring the user to name a skill. Before any source edit the agent names the assumption the change depends on: a load-bearing assumption it cannot confirm from the request, docs, or code — or a rough idea, feature concept, or "before we code" discussion — starts with `grill-with-docs`, while a confirmed or cheap-to-reverse assumption goes straight to implementation. Settled scope moves to `plan-with-docs`, which writes the durable plan and stops for explicit approval. Approved plans enter `work-step`; any source edit, in or out of the plan loop, is reviewed before commit via `review-work`, and clean or explicitly deferred reviews offer `commit-work` as the next gated action.

## Non-goals

- Do not build a fully autonomous agent runner that moves from vague idea to code without approval.
- Do not make feature docs store chat transcripts, noisy review logs, or every intermediate thought.
- Do not require every agent to support Claude-only primitives such as hooks, rules, or subagents.
- Do not reorganize existing project docs aggressively during adoption.

## Key Design Decisions

- `AGENTS.md` should become the canonical cross-agent instruction file when a project supports multiple agents. `CLAUDE.md` remains a Claude compatibility target.
- Agent profiles should share one interface but produce agent-specific output. Profiles can be neutral in shape, not neutral in capability.
- Skills should be grouped around the delivery loop: `grill-with-docs`, `plan-with-docs`, `tdd`, `work-step`, `review-work`, `commit-work`, and `update-docs`.
- Existing-project adoption should be gentle: scan and map existing docs where possible, create missing docs only where needed, and mark uncertainty instead of pretending the scan is authoritative.
- Working plan state should stay durable enough that context compaction can be offered after every reviewed-and-committed step, not only after the whole feature is done.

## Delivery Plan

Status: implemented, awaiting commit.

- [x] Step 1: Add the cross-agent workflow contract and update product language from Claude-only documentation automation to agent-neutral delivery workflow.
- [x] Step 2: Introduce an agent profile model for Claude and Codex/generic targets, including capability metadata.
- [x] Step 3: Update `init` so users can select agent profiles and workflow skills during setup, with non-interactive flags for automation.
- [x] Step 4: Update `update` so it refreshes only the profiles and workflow files recorded in `.codument-meta.json`.
- [x] Step 5: Add core delivery-loop skills: `grill-with-docs`, `plan-with-docs`, `tdd`, `review-work`, `commit-work`, and a small `next-step`/`work-step` helper.
- [x] Step 6: Update tests for profile selection, managed file paths, metadata, and profile-aware updates.
- [x] Step 7: Refresh README and docs to describe the new workflow and migration path from the current Claude-centered setup.

## What was built

- Added a typed agent profile model with Codex/generic and Claude profiles.
- Made Codex/generic the default profile, writing `AGENTS.md` and `.agents/skills`.
- Added `--agents` to `init` and `update`.
- Made `update` refresh managed files based on stored profile metadata.
- Added `adopt` as the existing-project path, including legacy registry migration.
- Added the core delivery-loop skills.
- Tightened the end-of-step prompts so feature work offers review/fix/pause after implementation, review findings require a user fix/defer/pause decision, and next-step/plan-review/pause appears only after commit.
- Reframed generated managed instructions around the grill, plan, approve, implement, verify, document, review, commit loop.
- Added local `tsx` test runner dependency so `npm test` does not depend on `npx` fetching the runner.
- Dogfooded the generated profiles in this repo by installing `.agents/skills`, updating local Claude profile files, tracking `.codument-meta.json`, and verifying `codument update --dry-run` reports all managed files current.
- Added intent routing to the generated managed instructions so new agent chats can move from grilling to planning to the approved implementation loop without relying on slash-command memory.

## Acceptance Criteria

- New projects can initialize Codument for Claude, Codex/generic, or both.
- Existing Codument projects can run `adopt` to migrate legacy registry mappings and refresh profiles.
- `AGENTS.md` is generated as the cross-agent contract when the selected profile needs it.
- Claude support can be reshaped around the new workflow instead of preserving the current install behavior.
- Codex/generic support installs portable skills and guidance without relying on Claude-only hooks or subagents.
- The core workflow is documented as grill, plan, approve, implement, verify, document, review, commit, repeat.
- Generated agent instructions route rough ideas to `grill-with-docs`, settled scope to `plan-with-docs`, approved plans to `work-step`, completed steps to `review-work`, and reviewed steps to a user-approved `commit-work` gate.
- Tests cover the profile-aware install and update paths.

## Verification Strategy

- Unit tests for profile resolution and managed file lists.
- Init tests for Claude-only, Codex/generic-only, and multi-profile projects.
- Update tests proving managed files are refreshed according to stored metadata without overwriting unrelated local changes.
- CLI tests for interactive defaults where practical and non-interactive flags for CI use.
- Manual smoke test in a temporary project for the generated file layout.

## Commit Convention For This Migration

Commits for this migration must use conventional commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, or `chore:`.


## Open Questions

- Should the generic/Codex profile install skills under `.agents/skills` by default, or should Codument support both `.agents/skills` and another Codex-specific path if one becomes canonical?
- Should `plan-with-docs` be a separate skill, or should `grill-with-docs` write the plan once decisions settle?
- Should `commit-work` create commits directly, or prepare and show the commit plan before running `git add` and `git commit`?

## Compact Checkpoint Update

### Summary

After every reviewed step is committed, Codument should offer context compaction as a first-class continuation option. That point is safe for compaction because code, docs, verification, review state, and the commit are already durable. Compaction is a post-step checkpoint, not only a final feature-completion activity.

### Current Decision

The post-commit next-options gate should be agent-neutral and include a compact-context option for all profiles. If the active host agent has a native compaction command, choosing the option should trigger it. If the host has no native compaction primitive, the agent should provide a concise restart note grounded in `AGENTS.md`, the active plan doc, `docs/.registry.json`, and `git status`, then pause.

The gate should become:

```text
Step N is reviewed and committed. Next options:
1. Start the next unchecked plan step with /work-step
2. Review the plan before continuing
3. Compact context before continuing
4. Pause here
```

### Non-goals

- Do not add an autonomous runner that starts the next plan step after compaction.
- Do not make Codument depend on one vendor-specific slash command in the shared workflow contract.
- Do not store chat transcripts or compaction summaries in durable docs.

### Delivery Plan

Status: implemented and verified; awaiting commit.

- [x] Step 1: Update the reusable `commit-work` skill and generated managed instructions so post-commit options include the agent-neutral compact-context gate.
- [x] Step 2: Refresh dogfooded managed copies and docs for the affected workflow/library behavior.
- [x] Step 3: Add or update tests that assert generated instructions and installed skills include the compact-context option.

### Acceptance Criteria

- `commit-work` offers four options after a successful commit: next step, plan review, compact context, and pause.
- The compact option is described as agent-neutral behavior across Codex, Claude, and future profiles.
- Selecting compact does not bypass the review-and-commit gate or start the next unchecked step automatically.
- Generated `AGENTS.md`/`CLAUDE.md` managed sections and installed skills carry the updated guidance.

### Verification Strategy

- Run targeted tests for scaffolded managed instructions and skill installation/update behavior.
- Run `npm run typecheck`, `npm run build`, and `npm test` if the implementation touches source or tests.

### Open Questions

- None.

## Explicit Next-Step Handoff Update

### Summary

After a reviewed step is committed, the `commit-work` gate should tell the user exactly which delivery-plan step `/work-step` will start. A generic "start the next step" option is too easy for an agent to repeat without re-reading the active plan, especially after context compaction or a long review.

### Current Decision

The post-commit gate's first option should include the next unchecked plan step number and a compact one-line summary copied or faithfully condensed from the active plan. If that next step is the final unchecked step, the option should say so. If no unchecked step remains, the gate should not offer `/work-step` as though work remains; it should instead offer plan review/completion, compact context, or pause.

The next-step option should follow this shape:

```text
1. Start the next unchecked plan step with /work-step (Step N - <next step summary>)
```

For the final unchecked step, the parenthetical should follow this shape:

```text
1. Start the next unchecked plan step with /work-step (Step N - final step: <next step summary>)
```

### Non-goals

- Do not change the allowed step gate sequence.
- Do not make agents start the next `work-step` automatically after commit.
- Do not require generated `AGENTS.md` wording to repeat the full menu template; the detailed behavior belongs in `commit-work`.
- Do not invent a next-step summary when the active plan is missing or ambiguous; in that case, the agent should offer plan review before continuing.

### Delivery Plan

Status: draft, awaiting approval before source edits.

- [ ] Step 1: Update the reusable and dogfooded `commit-work` skill instructions so the post-commit gate requires the actual next unchecked step number and summary, including final-step and no-unchecked-step handling.
- [ ] Step 2: Update the workflow documentation and focused tests so initialized/updated skills preserve the explicit next-step handoff requirement.

### Acceptance Criteria

- `commit-work` no longer shows a bare "Start the next unchecked plan step with /work-step" option as the complete required handoff.
- The next-step option includes `Step N` plus a short summary of the next unchecked plan step.
- The option explicitly labels the final unchecked step when applicable.
- If no unchecked step remains, the gate does not offer `/work-step` as a continuation path.
- Existing compact-context, plan-review, and pause options remain available after commit.

### Verification Strategy

- Add or update targeted tests that assert installed `commit-work` skill text includes the explicit next-step summary requirement.
- Run the relevant targeted tests for skill installation/update behavior.
- Run `npm run typecheck`, `npm run build`, and `npm test` if implementation touches source or broad test fixtures.

### Open Questions

- None.
