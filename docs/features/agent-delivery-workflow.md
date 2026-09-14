---
title: Agent delivery workflow
status: current
type: concept
last_reviewed: 2026-09-14
---

# Agent delivery workflow

## In plain terms

Agents ground a request in project docs, write a plan, and wait for human approval. Each approved
step is implemented, verified, documented, reviewed and committed before work advances. Codument
supplies the durable context and checks; the coding agent runs the workflow.

## Design approach

Approval, active work and delivery evidence answer different questions. Tracked approval binds the
selected contract; local state preserves interruptions and the next gate; Git proves delivery.
Final compaction retains the approved contract and its exact delivery binding, with local recovery
context available until the commit succeeds. See [[plan-approval]] and [[agent-work-state]].

The default loop continues after approval, stopping for decisions that need the human. Gated mode
keeps the same checks and waits between them. Local review covers the staged slice; branch delivery
to CI adds a review of the complete range and a portable manifest. Neither boundary authorizes the
other. [[step-verification]] and [[adversarial-review-gate]] own their enforcement.

Profiles place the same contract on each host's instruction and skill surfaces. Independent review
uses a fresh agent when available and discloses reduced independence otherwise. Existing-project
adoption preserves authored knowledge, creates only needed scaffolds and marks uncertainty.

Replies lead with the conclusion and offer supporting detail. Brevity never reduces grounding or
removes required parts of a decision. Compaction similarly removes working history while preserving
contracts and the pending gate; it is not permission to advance.
After any reviewed commit, gated handoff can offer native compaction or a grounded restart note.

## Invariants & boundaries

- Paused work cannot restart through checklist projection. Uncommitted work stays ready, and
  completion requires its verified delivery to be observed in Git. *(test: `work.test.ts`)*
- Outcome claims stop at the observed user or integration boundary. Substitutes prove only what
  they exercised; missing required evidence keeps acceptance open unless the user changes it.
  *(untested host behavior; installed guidance: `skill-parity.test.ts`)*
- Costly work identifies its outcome, effort and cheapest useful experiment before implementation.
  Existing evidence is reused; small reversible fixes gain no extra interview or approval gate.
  *(untested host behavior; planning and TDD instruction contract)*
- Routine review-to-commit waits apply only in gated mode. A single-step request still receives
  review and commit, then stops; handoffs name the actual next step and distinguish a final remaining
  step from completion. *(tests: `scaffold.test.ts`, `skill-parity.test.ts`; execution is behavioral)*
- Interruptions retain the selected plan, unfinished step, next gate, reason and resume condition.
  Resume reconciles that checkpoint with current docs and Git; approval is not execution state.
  Final recovery preserves the compacted doc and renews review after staged changes. Implementation
  completion never erases review or commit obligations. *(instruction contract; `work.test.ts` covers state)*
- Plans retrieve ownership from Scope and the Feature Map. A missing Map does not require reading
  the whole registry; soft budgets retain selected contracts. *(test: `context-pack.test.ts`)*
- One-file ownership questions use `context --file --owner`, sharing the gate's resolver. Read the
  full registry when editing or inspecting the map itself. *(test: `skill-parity.test.ts`)*
- Every step passes implementation, review and commit in that order before another step starts.
  Continuous execution removes routine waits, never gates. *(test: `scaffold.test.ts`)*
- Local work stages only its own slice and uses the compact verifier as its normal gate. Required
  review uses its generated worksheet; commit does not restage or introduce another local review
  surface, and the hook reuses an exact receipt. Branch CI review remains a separate obligation.
  *(tests: `scaffold.test.ts`, `verify.test.ts`)*
- Repository health is checked at plan completion and reports inherited debt rather than blocking
  each delivery step. *(behavioral instruction in the commit skill)*
- Source implementation requires human-approved scope. After approval, stop for judgment-call
  findings, public-interface, security, data-loss or dependency decisions, failed verification, or
  work outside the plan. *(test: `scaffold.test.ts` for installed gates; execution is behavioral)*
- A spoken request can enable gated mode for the session. Only the user resolves findings in that
  mode. *(test: `scaffold.test.ts` for routing; execution is behavioral)*
- The CLI installs, audits and gates work; it never runs the coding agent. *(architectural boundary)*
- Claude is the default when no profile is detected; other profiles remain selectable explicitly or
  through detection. *(test: `agent-profiles.test.ts`)*
- Compact-context never bypasses review or commit and never starts another step automatically.
  Hosts without native compaction receive a grounded restart note. *(test: `scaffold.test.ts`)*
- Final delivery compacts its completed checklist into durable knowledge. Health checks name
  completed scaffolding left behind. *(test: `scaffold.test.ts`; [[registry-health]])*
- Instructions recognize launcher argument-splitting failures and name alternate CLI invocations
  instead of asking the agent to keep changing quotes. *(test: `scaffold.test.ts`)*
- Response brevity never licenses reading less or omitting a mandated format's required parts.
  *(test: `scaffold.test.ts`)*

## Decisions

- [[plan-approval]] binds permission to one selected contract; [[plan-step-mirroring]] and
  [[change-control-gate]] use the same scope selection. Malformed approval cannot become permission.
- [[agent-work-state]] preserves interruptions and pending delivery without an autonomous runner
  or a domain-specific research lifecycle.
- Scope and new-file mappings are complementary grounding. Missing contracts and unavailable
  independent review are disclosed; reviewer self-report does not authenticate independence.
- `AGENTS.md` is the shared contract; `CLAUDE.md` is a compatibility surface. Skills group around
  delivery responsibilities, while profiles provide host-specific placement and capabilities.
- Approved plans run continuously by default because routine confirmations add no decision.
  Gated mode is an explicit, session-persistent spoken choice that needs no project setting.
- Response altitude is a standing rule, not a brevity toggle or abbreviated writing register.
  Decisions need less surface area, not compressed spelling or reduced evidence gathering.

## Key files

- `src/lib/agent-profiles.ts` — host placement and capabilities; [[lib]] owns implementation.
- `src/lib/scaffold.ts` — managed installation surfaces; [[project-charter-gate]] and [[lib]] own machinery.
- `skills/` — instructions that agents execute during delivery.
