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

Profiles place the same contract on each host's instruction and skill surfaces. Independent review
uses a fresh agent when available and discloses reduced independence otherwise. Existing-project
adoption preserves authored knowledge, creates only needed scaffolds and marks uncertainty.

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

## Delivery Plan

Status: approved
Plan-ID: outcome-milestone-delivery

Make the delivery workflow lighter while retaining project memory, ownership and review of the
exact changes being delivered. The field feedback identifies permission tied to predicted files,
disagreement between scope projections, repeated administration and progress without demonstrated
product value. Some safeguards already exist; reuse them before introducing another command or record.

- [x] Step 1: Make plan scope and Feature Map projections agree across context and verification.
- [x] Step 2: Approve outcomes and constraints while treating implementation file lists as guidance.
- [x] Step 3: Plan demonstrable milestones and repair routine failures without human interruptions.
- [ ] Step 4: Batch ownership lookup and source mapping around the staged delivery boundary.
- [ ] Step 5: Scale review effort to risk while preserving verification of staged changes.
- [ ] Step 6: Generate progress and handoffs from one consistent view of selected work.
- [ ] Step 7: Demonstrate the lighter workflow and report measured overhead separately from implementation.

### Outcome

An approved milestone can reach a working user or integration boundary even when implementation
reveals additional files. Agents can repair tests, mappings and documentation within the agreed
outcome without asking the human to restart the workflow. Progress names what can actually be
demonstrated, and completion requires the promised evidence.

Durable decisions, source ownership, resumable interruptions and exact staged review remain useful
across sessions. Routine administration is batched, review effort follows risk, and reported overhead
distinguishes observed workflow activity from implementation and uncaptured time.

### Constraints & non-goals

- Keep the Git-native, local, deterministic CLI and its existing agent profiles. Add no dependency,
  service, autonomous agent runner or renderer.
- Preserve existing approval meanings. An upgrade must not reinterpret an old approval as wider
  permission; adopting the new contract requires an explicit human approval.
- New approval binds the promised outcome, milestone deliverables, acceptance evidence and explicit
  constraints on behavior, architecture, compatibility, privacy, security and spending. File Scope,
  Feature Maps and implementation notes guide routing rather than granting or withholding permission.
- Approved milestone descriptions remain stable. Implementation details may evolve within them;
  changing promised behavior, acceptance, non-goals or constraints requires renewed approval.
- The agent and reviewer judge whether work fits an outcome. The CLI validates explicit contract
  bindings and evidence; it must not claim to infer intent or authenticate human approval.
- Verification still covers exactly the staged change, including approval and mapped contracts.
  Changed reviewed bytes reopen review. Neither workflow simplification nor a green test licenses
  unrelated work, stale documentation, unmapped source or a commit through a failing gate.
- Routine failure is a repair obligation. Ask the human when a repair needs an unapproved decision,
  external input or genuinely irreversible action; preserve an explicit user pause or gated mode.
- Keep a focused review and commit for each delivery slice. Visible milestones guide slice selection
  and acceptance; do not replace reviewable changes with one large end-of-project commit.
- No additional persistent work ledger, mandatory manual timers, universal risk score or invented
  claims about complete session timing. Existing timing evidence may be incomplete.

### Design & migration

Introduce an explicitly distinguishable outcome approval alongside the existing contract model.
Legacy records keep their current validation, archived-delivery and recovery semantics. Newly
approved outcome plans exclude advisory implementation-file routing from their approval identity.
Contract fields, selected milestone deliverables and acceptance evidence remain bound; unsupported,
missing or ambiguous contracts fail visibly rather than falling back to permissive approval.

Scope projections share the selected plan and its routing inputs. For legacy file-bound plans,
supported Feature Map declarations participate consistently in guidance and scope diagnostics.
For outcome plans, a newly discovered file outside the initial guidance is an implementation
discovery, not proof of unapproved work. Its ownership, impact and documentation obligations still
appear in the staged boundary check. Reclassifying a plan never silently renews old permission.

Use the plan as the authored milestone record and derive agent-facing progress and handoffs from
the existing selected-work inspection. Approval owns permission, local state owns interruption and
pending gates, and Git owns delivered evidence. These answer different questions; unify their
projection rather than copying them into another editable record. A pending review or commit must
survive refresh, compaction and an implementation discovery.

Review remains proportional and accountable. Focused self-review is suitable only when the change
is understood, local and reversible, with no substantial behavior or contract change. Public
interfaces, documented invariants, security/privacy, migrations, deletions, dependencies, substantial
behavior and uncertain analysis require the stronger review path. Static escalation reasons cannot
be waived by labelling work low risk. The reviewer still compares acceptance with observed evidence;
a screenshot or local stand-in establishes only the boundary actually inspected.

### Scope

Existing source files; their owning docs must be updated when their contracts change:

- `src/lib/plan-steps.ts` — selected plans, approved milestone declarations and scope interpretation.
- `src/lib/plan-approval.ts` — explicit contract models, migration and final-delivery bindings.
- `src/lib/change-state.ts` — scope diagnostics and affected ownership.
- `src/lib/feature-map.ts` — shared routing interpretation.
- `src/commands/doctor.ts` — bounded Windows compatibility repair for historical health inspection.
- `src/lib/git.ts`, `src/lib/git-hooks.ts` and `src/commands/ack.ts` — explicit repository selection across delivery checks and commit hooks.
- `src/lib/plan-grounding.ts` — the contracts supplied to plan review.
- `src/lib/context-pack.ts` and `src/commands/context.ts` — batched grounded ownership.
- `src/commands/map.ts` — batched registration using existing routing and writers.
- `src/lib/review-gate.ts` — review escalation based on risk and analysis confidence.
- `src/lib/review-bundle.ts` and `src/lib/review-artifact.ts` — bounded review context and evidence.
- `src/commands/review.ts` and `src/commands/verify.ts` — one staged verification entry point.
- `src/lib/work-state.ts` and `src/commands/work.ts` — authoritative selected-work projection.
- `src/commands/steps.ts` and `src/commands/watch.ts` — generated milestone progress and handoffs.
- `src/lib/events.ts` and `src/commands/cost.ts` — observed workflow timing alongside existing activity.
- `src/lib/scaffold.ts`, `src/lib/agent-profiles.ts` and `src/cli.ts` — installed guidance and CLI surfaces.

Instruction and documentation surfaces:

- `skills/plan-with-docs/SKILL.md`, `skills/work-step/SKILL.md`, `skills/review-work/SKILL.md`,
  `skills/commit-work/SKILL.md`, `skills/grill-with-docs/SKILL.md` and `skills/tdd/SKILL.md`.
- Managed workflow blocks in `AGENTS.md` and `CLAUDE.md`, and installed profile guidance.
- The existing owner docs for approval, work state, context, decomposition, review, verification,
  checklist projection, CLI, cost and library contracts; update this doc at each relevant boundary.
- `docs/.registry.json` for genuinely changed ownership or supporting documentation declarations.
- An ADR alongside the approval change to record its migration and permission boundary.

No new runtime source files are required. Tests and temporary fixture projects are verification
evidence rather than source ownership; add no Feature Map just to mirror existing file ownership.

### Milestone acceptance & verification

1. Scope consistency: replay a plan whose Scope names kitchen geometry and whose Feature Map names
   a catalogue file. Context, map checking and out-of-plan reporting agree for explicit paths and
   supported patterns, including selected sections and staged snapshots. A real legacy out-of-scope
   change remains visible. Cover this in the existing plan, context and review-boundary suites.
   Include the approved Windows historical-inspection repair and explicit repository selection for
   review, verification, acknowledgments, readiness and commit checks. Default workspace aggregation
   stays available; a root receipt cannot cover a different member tuple. Preserve separately staged
   nested repositories, invalidate changed boundaries and test receipt reuse through delivery.
2. Outcome approval: an additional implementation file and routing change preserve outcome-plan
   approval; changing the outcome, milestone deliverables, constraints or acceptance invalidates it.
   Existing approval identities, ambiguous selection, malformed contracts, staged/worktree isolation,
   consumed final delivery and fresh-checkout recovery retain their guarantees. Exercise approval,
   work-state, boundary and receipt tests; update ADR 023 through an explicit superseding decision.
3. Useful milestones: installed planning guidance asks for a representative end-to-end experience
   early and acceptance evidence at its actual boundary. Infrastructure tasks explain the milestone
   they unblock. A routine failed check triggers diagnosis, correction and re-verification; a changed
   outcome or unapproved privacy/compatibility decision prompts the human. Keep all instruction
   surfaces consistent and test their installation. Host execution remains a behavioral boundary.
4. Batched administration: add `context --paths <paths...>` and backward-compatible multi-file
   materialization. Return every owner, omission and ambiguity through the existing resolver.
   Validate batch routing and path safety before mutation; preserve idempotent retries and report
   partial I/O failures accurately. Existing tree ownership and source exclusions remain authoritative.
   Replace the per-file before/after ritual with grounded planning context plus one staged boundary
   check. Verification reports required mapping and doc actions without automatically staging or
   inventing documentation. Cover existing single-file compatibility and mixed-validity batches.
5. Review proportionality: an understood small reversible change receives focused checks and
   self-review; substantial behavior and each escalation reason require the stronger pass. File count
   alone is neither permission to skip review nor proof of risk. Risk classification and relevant
   evidence belong to the exact reviewed boundary, with conservative escalation when uncertain.
   Preserve finding reproduction, stale-artifact invalidation and reusable exact receipts. Exercise
   risk/contract/deletion/uncertainty cases and re-review after source, oracle or approval changes.
6. Reliable handoff: status, checklist, context and watch agree on the selected milestone, committed
   progress, pending gate and interruption reason. Native panels are generated mirrors, never a
   second authored checklist. Recovery copies are snapshots, never an alternate current work record.
   A paused session remains paused; a reviewed uncommitted slice remains pending commit. Cover
   dirty-worktree isolation, supersession, final compaction and fresh-session recovery. An explicit
   preview of a new identified plan on a page with an archived approval shows the new plan rather
   than substituting the archived checklist.
7. Evidence and overhead: replay a representative implementation discovery through approval,
   mapping, correction, staged review and delivery. It reaches the promised observable milestone
   without a scope-amendment interruption. Compare required workflow commands and observed elapsed
   command time with the existing flow. Reuse local events for recorded workflow durations and show
   implementation duration only when separately observed; otherwise report it as unknown. Do not
   infer either from timestamp gaps, token counts or time spent awaiting the user. Keep timing outside
   deterministic gate outputs; an explicit timing view on the existing cost command leaves its normal
   ledger contract intact. Make observation failure incapable of changing a gate verdict.

Run focused tests for each slice, then the project typecheck, build and tests. Each implemented slice
receives independent review when its risk requires it, mapped documentation updates and exact staged
`codument verify` before its focused commit. At final delivery, inspect the CLI experience as well as
the tests. An instruction-parity test proves installed guidance, not autonomous agent behavior.

### Effort & cheapest useful experiment

This is a multi-slice change across approval, guidance and delivery surfaces. Approval migration and
review calibration carry the most risk; expect several agent sessions rather than a small patch.
Do not start with a rewrite or a new orchestration layer.
The scope-disagreement case has already been reproduced using the current parser and detector.
Extend that representative fixture first, then use it to prove the outcome contract before changing
the rest of the workflow. Command-count comparison is the first overhead measurement; observed
timing supports it without pretending to measure a complete coding session.

### Grounding limitations

Scope grounding covers the existing source owners without a new-source Feature Map. The generated
report names `AGENTS.md`, `CLAUDE.md` and `docs/.registry.json` as unowned inputs. These were inspected:
the first two are managed workflow instruction surfaces, and the third is the ownership control
plane, rather than an undocumented runtime source. Their contracts are supplied by the delivery,
profile, library and registry docs. Supporting instruction declarations should be repaired where
appropriate during the guidance change; do not pretend the omissions are clean ownership coverage.

### Open questions

No product decision is left open in this proposal. The recommended defaults are outcome approval
for newly approved plans, unchanged meanings for existing approvals, conservative escalation of
uncertain risk, and explicit unknowns when timing or experience evidence is unavailable. Independent
plan review checked approval, recovery, staged verification, review, ownership and installed guidance;
no material objections were found. The disclosed grounding omissions were inspected.
