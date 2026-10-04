---
title: Agent delivery workflow
status: current
type: concept
last_reviewed: 2026-10-04
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

Status, checklist, context and monitor share a generated view of the selected milestone. A checked
implementation does not hide verification, review or commit, and observed delivery never lifts a
saved interruption. Native panels mirror this view; they are not another authored work record.

The default loop continues after approval, stopping for decisions that need the human. Gated mode
keeps the same checks and waits between them. Local review covers the staged slice; branch delivery
to CI adds a review of the complete range and a portable manifest. Neither boundary authorizes the
other. [[step-verification]] and [[adversarial-review-gate]] own their enforcement.

New plans approve outcomes and constraints, keeping file routing advisory. Existing approvals retain
their original scope until explicitly renewed. Milestones demonstrate a representative working
experience early, including the assets and integration it needs; infrastructure slices explain
which milestone they unblock. Each slice remains independently reviewable and deliverable.
Ordinary failed checks trigger diagnosis and repair within the approved contract. Human interruption
is reserved for a genuinely unapproved decision or unavailable input, rather than the failed check
itself. Required acceptance evidence stays open until its actual boundary has been exercised.

The representative delivery replay reaches an actual local command after discovering shared helpers,
repairing a failing integration test and passing mapped, staged review before commit. Its scripted
approval and review establish CLI evidence binding; they do not establish autonomous host behavior
or authenticated independence. Administration comparisons use equivalent fixtures and the same
current executable, isolating ownership grounding and registration from the rest of delivery.
[[token-cost-tracking]] reports optional action timing without claiming complete session savings.

Profiles place the same contract on each host's instruction and skill surfaces. Independent review
uses a fresh agent when available and discloses reduced independence otherwise. Existing-project
adoption preserves authored knowledge, creates only needed scaffolds and marks uncertainty.

Generated review effort is a structural floor. Focused self-review is available only for understood,
local and reversible behavior with precise ownership and attributable test evidence. Sensitive
contracts, declared risks and uncertain analysis require the adversarial pass; semantic uncertainty
can raise that floor. Both efforts use the same worksheet and exact staged evidence, and neither
can discard a reproduced finding. [[adversarial-review-gate]] owns calibration.

Verified dead-code removal can use a compact approved step in the owning doc. Evidence must cover
public and dynamic entry points as well as ordinary callers; absence of textual imports is not
enough. This path removes duplicate planning and progress bookkeeping while retaining ownership,
project checks, staged verification and independent implementation review. Uncertain removals use
the normal decision process. A request to leave changes uncommitted preserves readiness and the
pending commit rather than claiming delivery.

Replies lead with the conclusion and offer supporting detail. Brevity never reduces grounding or
removes required parts of a decision. Compaction similarly removes working history while preserving
contracts and the pending gate; it is not permission to advance.
After any reviewed commit, gated handoff can offer native compaction or a grounded restart note.

## Invariants & boundaries

- Session preflight checks the executable's workflow capabilities before using the skills. A stale
  installation is repaired rather than replaced with manual gate approximations. *(test: `skill-parity.test.ts`)*
- Compact cleanup retains explicit scope approval and independent deletion review, with no duplicate
  plan-adversary pass or progress projections. Dynamic usage uncertainty disqualifies the shortcut.
  *(instruction contract: `skill-parity.test.ts`; agent execution remains untested)*

- Paused work cannot restart through checklist projection. Uncommitted work stays ready, and
  completion requires its verified delivery to be observed in Git. *(test: `work.test.ts`)*
- Outcome claims stop at the observed user or integration boundary. Substitutes prove only what
  they exercised; missing required evidence keeps acceptance open unless the user changes it.
  *(untested host behavior; installed guidance: `skill-parity.test.ts`)*
- A discovered implementation helper can be mapped and delivered without renewing outcome approval
  when the promised milestone and constraints remain unchanged. Routine repair retains acceptance
  evidence and exact staged review. The administration replay measures only grounding and source
  registration; implementation duration remains unknown. *(test: `workflow-milestone.test.ts`)*
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
- Working-set ownership is grounded once with batched context and refreshed when routing changes.
  The exact staged boundary checks affected mapping, documentation and review readiness together;
  one-file ownership questions retain their lean interface. Read the full registry when editing or
  inspecting the map itself. *(tests: `context-pack.test.ts`, `skill-parity.test.ts`, `verify.test.ts`)*
- Every step passes implementation, review and commit in that order before another step starts.
  Continuous execution removes routine waits, never gates. *(test: `scaffold.test.ts`)*
- Local work stages only its own slice and uses the compact verifier as its normal gate. Required
  review uses its generated worksheet; commit does not restage or introduce another local review
  surface, and the hook reuses an exact receipt. Branch CI review remains a separate obligation.
  *(tests: `scaffold.test.ts`, `verify.test.ts`)*
- Repository health is checked at plan completion and reports inherited debt rather than blocking
  each delivery step. *(behavioral instruction in the commit skill)*
- Source implementation requires current bound human approval. Routine test, mapping, documentation
  and review corrections proceed within that contract; changing promised behavior, evidence or
  constraints requires renewed approval. External blockers, irreversible actions needing permission
  and explicit user pauses preserve the pending gate. An already-approved correction does not create
  a second decision merely because it touches a sensitive boundary.
  *(tests: `scaffold.test.ts`, `skill-parity.test.ts`; host execution remains behavioral)*
- New planning instructions use explicit outcome approval and require demonstrable milestones with
  observed acceptance evidence. File discoveries repair guidance without widening the outcome;
  legacy file-bound approvals keep their original boundary. Missing acceptance evidence cannot be
  replaced by a green unrelated check. *(tests: `skill-parity.test.ts`, `init.test.ts`, `update.test.ts`)*
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

- Explicit outcome approval binds promised milestones and constraints while source routing remains
  advisory. Existing approvals require renewed human approval to adopt it; see
  [ADR 024](../architecture/decisions/024-outcome-permission-keeps-routing-advisory.md).

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
