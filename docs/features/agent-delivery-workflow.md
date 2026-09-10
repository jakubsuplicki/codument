---
title: Agent delivery workflow
status: current
type: concept
last_reviewed: 2026-09-10
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

## Delivery Plan — reliable approvals, context, and session control
Plan-ID: a08f294d-ca64-49d8-bc21-df4408c2d660

Status: approved

This proposal covers all seven remaining gaps: approval revisions, explicit work state, review
coverage and CI, knowledge quality, realistic agent evaluation, cross-agent telemetry, and workspace
history selection. The durable layers above describe current behavior; this block describes work
that has not been implemented. The user approved this plan and authorized committing the earlier repair tranche and each verified implementation step.

- [x] Step 1: Bind human-approved plan scope to a recorded revision and diagnose stale or unbound approval.
- [x] Step 2: Add explicit active, paused, blocked, superseded, ready, and completed work states.
- [x] Step 3: Connect work state to agent handoffs, steps, context, verification, and the live monitor.
- [x] Step 4: Ground planning and review in existing files, changed docs, and instruction contracts.
- [x] Step 5: Export and validate portable review evidence for the exact reviewed change.
- [x] Step 6: Require matching review evidence in the CI template and this repository's workflow.
- [x] Step 7: Expose missing context and compact the command and workflow documentation.
- [ ] Step 8: Compact the shared-library and registry-health documentation without losing contracts.
- [ ] Step 9: Report capture availability and export only explicit, portable usage summaries.
- [ ] Step 10: Capture Codex usage locally alongside the existing Claude feed without double counting.
- [ ] Step 11: Add explicit workspace-root and member selection for history audits.
- [ ] Step 12: Add realistic retrieval, approval-change, and interrupted-work benchmark scenarios.
- [ ] Step 13: Run bounded independent agent comparisons and finish integrated verification.

### Outcome

Agents can recover which revision was approved, which work is active or interrupted, the relevant
contracts, and the next required gate. Material plan changes invalidate recorded approval while
ordinary progress updates do not. Review includes work on existing code and documentation, and CI
can verify evidence for the actual branch change. Context omissions and unavailable telemetry are
visible. History audits name the repository they cover. Repeatable task results test whether these
changes reduce mistakes and interruptions rather than equating coverage with quality.

Commit reviewed repository changes locally, one verified slice at a time. The CLI continues to support agents rather
than run them. No hosted service, identity system, new dependency, paid API integration, release,
remote repository change, or domain-specific research workflow is included. Local approval and
review records disclose attribution; they do not authenticate a human against another process with
the same filesystem permissions. Real GitHub execution waits for a separately authorized push; this plan
prepares and verifies the workflow in isolated fresh-checkout fixtures.

### Proposed architecture and decisions for approval

The charter's local-first Git/file model remains in place. Shared pure resolvers own selection,
revision identity, state transitions, and evidence validation; existing CLI commands remain thin.
Reuse the existing atomic-write, registry ownership, staged-snapshot, event, and Git seams.

Approval: add `codument work approve --plan <path>` as an explicit recording action used only after
the human approves the displayed plan. Store versioned records in tracked `docs/.approvals.json`,
separately from runtime state, so staged verification reads staged approval records and plan text.
A stable plan identifier distinguishes sections in the same doc; explicit `--plan-id` selects one
when a path alone is ambiguous. Carry the same identity through steps, map, context and verification.
The record retains the approved contract needed after compaction; completed records never become
active candidates implicitly or authorize an unscoped change. The digest covers the selected
plan's step text, outcome, scope, map, acceptance, verification, and decisions; exclude only approval
bookkeeping, checkbox completion, resume checkpoints, and normalized line endings. Scope or plan
identity changes require a fresh approval; neither another section nor a missing record can clear a
stale binding. Refuse malformed records and conflicting writes. Progress and revision are separate.
Record this boundary in `023-plan-approval-binds-the-approved-contract.md`.

Final compaction: before removing the Delivery Plan, persist its complete approved contract and an
explicit final-delivery intent in the tracked approval record, referencing the same plan identity
and approval digest. Verification of that final boundary uses this retained contract, including
its scope, even when its checklist is fully checked or its Markdown has been compacted. The CI
manifest explicitly references that same approval. The ignored recovery copy is never the only
approval evidence. A completed archival record is not an automatic candidate for new work; missing
or mismatched final-delivery binding refuses the gate. Runtime completion stays separate, avoiding
a tracked post-commit bookkeeping edit. Test a never-committed single-step plan through compaction,
final verification, fresh-checkout CI validation and recovery cleanup.

Migration: existing Markdown plans remain readable with an explicit legacy/unbound diagnostic.
Newly recorded approvals are revision-bound and never fall back to the legacy status. An explicit
project policy in `.codument-meta.json` requires bound approvals; new installs use it, existing
projects opt in after review. Enable it in this checkout once this plan has been approved and the
recording command exists. An empty or absent active selection cannot bypass that policy when a
governed change requires approval. Routine progress does not prompt for approval again.

Work state: keep one selected plan per worktree plus resumable records in ignored
`.codument/work-state.json`. Plan Markdown continues to own scope and checklist completion;
runtime state owns selection, pause/block reason, resume condition, and next gate. Approval remains
independent. Use explicit `work status/start/pause/block/resume/supersede/finish` actions, with JSON
readback. Selecting another plan requires a reason and preserves the previous plan as paused;
supersession names its replacement and never happens implicitly. Reads reconcile revision and Git
evidence without changing files. Use schema validation, bounded reads, atomic writes and a revision
check under an exclusive local writer lock; conflicting transitions fail rather than lose state.
Finish means verified work is ready; completed means its intended delivery has actually happened.
No-commit work stays ready with its pending commit visible. Compacted final plans use the existing
recovery copy until that gate passes. Never trust an old ordinal or receipt after its inputs change.
Bind the selected plan identity and validated approval revision into verification and receipt reuse;
changing local selection cannot reuse a pass for different work. Runtime state never grants approval.

Shared grounding: make the selected plan's explicit Scope and Feature Map complementary inputs to
the same owner resolver used by context and review. Include direct doc owners and explicitly
registered instructions when only documentation/skills changed. Preserve before/after contracts so
removing an invariant cannot remove it from review. Name unowned and unreadable inputs instead of
presenting an empty contract set as sufficient grounding. Planning review uses actual host
capabilities, including this host's available independent agents, rather than a hard-coded vendor
label. Missing independence remains a named limitation; a self-report does not become independent
evidence merely because a field says so.

Review eligibility is separate from source-change counting. Require review when a documentation-only
boundary changes durable contract layers, when an invariant is removed or changed beyond formatting,
or when a declared workflow instruction changes beyond formatting. Treat whitespace, line endings,
frontmatter housekeeping, plan progress and path-only Key files corrections as non-contract changes.
Do not claim a parser can prove semantic equivalence: uncertain edits to protected contract layers
receive review. Ordinary mapped-doc maintenance does not add another source change or independently
retire the existing trivial-source fast path unless one of these explicit triggers applies. Add this
additive eligibility rule to ADR 021 and test invariant removal, harmless prose/formatting, instruction
policy changes, and a trivial source edit with its ordinary mapped-document update.

Portable review: provide explicit `review --export <file>` and `--review-file <file>` paths around a
strict, versioned transport record. Bind it to the resolved merge base, exact reviewed content,
review policy, documented contracts, and relevant tests. Export only when an existing review covers
that entire boundary; never convert a staged step receipt into approval of an unreviewed PR range.
For the default CI recipe, use a tracked `.codument-review.json` manifest containing digests,
checked-contract identifiers, declared reviewer attribution, and finding disposition. Exclude only
that reserved, schema-validated manifest from its own content digest to avoid a self-reference loop;
source, tests, docs, registry and policy changes still invalidate it. No source contents, transcripts,
absolute paths, or free-form private findings are copied automatically. The local full review remains
private. Export every covering attestation, not just the cleanest or newest. Carry minimal checked-
contract/finding identifiers, repository-relative test references, attribution and disposition for
each, with opaque references replacing private prose. The receiving gate merges the covering set
and re-runs named tests using its existing local runner and finding policy; claimed resolution never
overrides an observed red test. Preserve and disclose advisory/unrunnable findings. A digest alone
is insufficient review evidence. Reject missing, malformed, stale, partial or wrong-base evidence; do not silently downgrade
CI to documentation-only checks. This is review coverage and attribution, not authenticated identity.

Context quality: retain the existing soft budget and complete selected contracts. Add structured
omission reasons and useful recovery pointers when an owner/doc cannot be resolved or read, while
retaining valid context. Compact four bounded, frequently used pages in two batches: commands and
agent workflow, then the library overview and registry health. Keep each contract/test pointer and
durable decision, remove code mirrors and repeated history, and move specialized detail to its
existing owner. Do not alter ownership or exclusions to improve a score. Measure context size and
required-contract coverage before/after; shorter output alone is not success.

Telemetry: retain manual vendor-neutral events and existing Claude behavior. Add an explicit
per-host capture state distinguishing available, empty, partial, unavailable and unsupported inputs;
cost totals remain estimates over captured counts, separate from capture availability. An explicit
summary export carries counts, model/host, run identity and limitations only; it never exports raw
transcripts or silently imports a summary into the live ledger. Local feed discovery is restricted
to sessions whose recorded repository matches the requested root, including legitimate worktrees.
Codex input supports explicit JSON event files and best-effort local session logs, with defensive
schema handling, incremental reads, replay-safe identities and reset/truncation diagnostics. Cache
and reasoning subdivisions must not be counted twice; missing model/rate data stays unpriced.
Do not modify the user's Codex configuration, intercept its process, or open a telemetry service.

Feasibility evidence: the installed session envelopes expose repository identity and token-count
records, including cumulative/last-turn usage; only their field names were inspected, not copied
transcripts. These internal envelopes are not a stable public API. The documented non-interactive
stream also provides completed-turn usage, usable through an explicit input file ([OpenAI Docs](https://learn.chatgpt.com/docs/non-interactive-mode)).

Workspace history: add `audit <range> --repo <member-path>` and `--repo .` for the root repository.
The selected repository supplies its own refs, registry, blobs and paths; an explicit root selection
does not aggregate nested members. Pass one selected-repository view through the existing history
and Git seams instead of changing the working directory and re-triggering workspace discovery.
Unselected workspace-wide ranges remain refused. Invalid selectors, paths outside the workspace,
unreadable members and non-repository roots fail with actionable JSON/human diagnostics. Preserve
ordinary single-repository output and informational audit exit behavior. Update ADR 016's explicit
selection boundary rather than quietly weakening its refusal.

Evaluation: extend the package-native benchmark fixtures and deterministic scoring, without adding
an autonomous agent runner. Use three general engineering tasks: retrieving an important dependent
contract, handling a material change to an approved plan, and resuming interrupted reviewed work.
Each includes valid alternatives/negative controls so unnecessary stops and false positives count
alongside missed constraints. Run one matched pair first; if the harness works, complete two runs per
task and condition (twelve runs total), using independent fixture agents. Both conditions receive the
same task and engineering information; only Codument's workflow integration changes. Record actual
outcomes, interventions, observed time/usage when available, and uncertainty. No fabricated sessions,
no answers exposed to the worker, no source changes in this checkout by evaluation workers, and no
claim of a universal quality gain from a small sample. A negative result is evidence to report and
investigate, not a reason to change the scoring rules.

### Effort and cheapest experiments

Expect several focused working sessions across the thirteen reviewable slices. Most effort is in approval compatibility, exact
CI evidence matching, and replay-safe telemetry. Keep the slices below independent and avoid a new
general framework. Before each costly slice, use one existing seam: canonicalize an edited plan;
resume from a stale checkpoint; validate a review record in a second local checkout; import one
sanitized usage stream twice; audit a root beside one nested repository; run one benchmark pair.
Broaden only after that representative case works. Unknown external availability stays explicit.

### Feature Map

```feature-map
src/lib/plan-approval.ts | plan-approval | feature | revision-bound approval of a selected plan contract
src/lib/work-state.ts | agent-work-state | feature | durable selection and resumable delivery state
src/commands/work.ts | agent-work-state | feature | explicit approval and work-state commands [secondary: plan-approval]
src/lib/review-transfer.ts | adversarial-review-gate | feature | portable evidence for an exact reviewed boundary
src/lib/agent-feed.ts | token-cost-tracking | feature | combine host capture status and route configured local feeds
src/lib/codex-feed.ts | token-cost-tracking | feature | normalize repository-scoped Codex usage without retaining transcripts
src/lib/benchmark-sessions.ts | proof-benchmarks | feature | compare recorded task outcomes with transparent deterministic scoring
```

### Scope

All new source files are listed in the Map and materialized into their named owners when added.
Existing source ownership remains authoritative. Corresponding tracked skills mirror shipped edits.

- `src/cli.ts`, `src/index.ts`, `src/lib/scaffold.ts`, `src/lib/agent-profiles.ts`, `src/commands/init.ts`, `src/commands/update.ts` — command wiring, explicit policy defaults and installed host capabilities; preserve existing public exports.
- `src/lib/plan-steps.ts`, `src/lib/plan-approval.ts`, `src/lib/work-state.ts`, `src/commands/work.ts`, `src/lib/change-state.ts`, `src/commands/steps.ts`, `src/commands/review.ts`, `src/commands/verify.ts` — selection, bound approval and state-aware guardrails.
- `src/lib/change-set.ts`, `src/lib/state-io.ts`, `src/lib/events.ts`, `src/lib/verdict.ts`, `src/commands/watch.ts`, `src/commands/report.ts`, `src/lib/report-html.ts` — exact snapshots, safe persistence and honest work-state projections.
- `src/lib/plan-grounding.ts`, `src/lib/feature-map.ts`, `src/lib/context-pack.ts`, `src/commands/context.ts`, `src/lib/review-bundle.ts`, `src/commands/map.ts`, `src/lib/ownership.ts`, `src/lib/analyze.ts` — shared grounding and omission diagnostics without silently discarding contracts.
- `src/lib/review-artifact.ts`, `src/lib/review-gate.ts`, `src/lib/review-transfer.ts`, `src/commands/hooks.ts`, `templates/ci-codument.yml`, `.github/workflows/ci.yml` — exact portable review and CI wiring; no remote writes.
- `src/lib/token-report.ts`, `src/lib/token-cost.ts`, `src/lib/claude-feed.ts`, `src/lib/agent-feed.ts`, `src/lib/codex-feed.ts`, `src/commands/feed.ts`, `src/commands/cost.ts`, `src/commands/emit.ts` — capture availability, replay-safe local feeds and explicit summaries.
- `src/lib/git.ts`, `src/lib/two-ref.ts`, `src/lib/history-audit.ts`, `src/commands/audit.ts` — one explicitly selected repository throughout a history audit.
- `src/lib/benchmark-quality.ts`, `src/lib/benchmark-context.ts`, `src/lib/benchmark-sessions.ts`, `src/commands/benchmark.ts`, `fixtures/benchmarks/` — packaged general engineering scenarios and deterministic evaluation.
- `skills/grill-with-docs/SKILL.md`, `skills/plan-with-docs/SKILL.md`, `skills/work-step/SKILL.md`, `skills/review-work/SKILL.md`, `skills/commit-work/SKILL.md`, `skills/tdd/SKILL.md`, `skills/update-docs/SKILL.md`, `.agents/skills/`, `agents/adversarial-planner.md`, `AGENTS.md` — approved workflow integration and truthful host-capability routing.
- `docs/.approvals.json`, `.codument-meta.json`, `.codument-review.json`, `docs/.registry.json`, `templates/feature.md`, `templates/concept.md` — explicit control artifacts and compatible generated plans.
- `docs/features/plan-approval.md`, `docs/features/agent-work-state.md`, `docs/features/agent-delivery-workflow.md`, `docs/features/plan-step-mirroring.md`, `docs/features/change-control-gate.md`, `docs/features/plan-adversary.md`, `docs/features/adversarial-review-gate.md`, `docs/features/context-pack.md`, `docs/features/hooks.md`, `docs/features/token-cost-tracking.md`, `docs/features/history-audit.md`, `docs/features/proof-benchmarks.md` — new owners and updated contracts.
- `docs/features/commands.md`, `docs/concepts/lib.md`, `docs/features/registry-health.md`, `docs/overview.md`, `docs/getting-started.md`, `README.md`, `docs/architecture/decisions/` — bounded compaction, discoverability and durable decisions.
- `tests/plan-approval.test.ts`, `tests/work-state.test.ts`, `tests/work.test.ts`, `tests/review-transfer.test.ts`, `tests/agent-feed.test.ts`, `tests/codex-feed.test.ts`, `tests/benchmark-sessions.test.ts` — focused new behavior suites.
- Existing plan, context, review, verification, CLI/install, feed, cost, history, workspace, benchmark and skill-parity suites under `tests/` — regression coverage for their affected callers.

### Acceptance and verification

- Approval: material edits and reordered/added steps stale the binding; checkbox/checkpoint/EOL updates do not. Historical sections, invalid records, unbound-mode downgrade, unstaged approval and concurrent writers cannot authorize a different staged plan. Existing plans have an explicit migration route. Final compaction remains verifiable from tracked approval data in a fresh checkout, without the ignored recovery copy.
- State: only one selected active plan per worktree; pause and resume retain approval, pending review and commit. Switching and superseding preserve prior work. Corrupt, stale, moved or conflicting state yields a named remedy. A no-commit request never triggers a commit or marks pending delivery complete.
- Grounding: plans without a Map still retrieve scoped owners; doc/skill-only changes include relevant before/after contracts and test pointers. Missing/unreadable inputs are named. Scope resolution, review and context agree, while legacy single-feature/file selectors retain their contracts. Independent review eligibility covers contract/instruction edits without counting accompanying documentation as another source change.
- Review transport: a fresh checkout accepts only matching complete evidence. Wrong base, changed source/test/doc/policy, partial coverage, inconsistent transport fields, missing or malformed records fail. A staged receipt cannot certify an aggregate PR. Conflicting covering attestations are all retained, and a claimed-resolved finding with a red test still blocks. Private prose is absent from exports, and CI cannot silently bypass missing review.
- Knowledge: required-contract and test-pointer coverage is preserved during compaction, and representative context packs get smaller without changing budget guarantees. No ownership/exclusion manipulation to improve scores; unresolved inconsistencies are reported.
- Telemetry: available-empty differs from unavailable/partial; Claude still works. Duplicate, concurrent, resumed, truncated, malformed and foreign-repository streams cannot inflate usage or imply complete capture. Missing counts, unsupported versions, unknown rates and inaccessible sessions remain visible; exported fixtures contain no transcript content.
- Workspace: default single-repo behavior stays unchanged; root and member selection use only the selected Git history and registry, including a Git root with nested members. Bad refs/selectors and unreadable repositories stay unavailable rather than zero drift.
- Evaluation: deterministic scorers detect wrong changes and missed constraints, include valid controls, and refuse incomplete/tampered inputs. Real runs remain distinguishable from fixture unit tests; all twelve attempts and their limitations appear in the comparison, including failures and missing metrics.

Use red/green cases at each shared resolver and repository-shaped integration tests for staged
isolation, Git range/manifest round trips, native Windows paths, profile installation, feed replay,
and root/member topology. Record normalized schema-only fixtures rather than copied private logs.
Run focused checks per slice, typecheck/build after source changes, independent review of each
slice, and exact cumulative staged `codument verify`. Run the full suite after the approval/state
integration and again at completion; run repository-wide health once at completion. Windows runs
locally; Linux/other host executions are reported only where actually exercised, with CI changes
prepared locally until the user authorizes committing and publishing them.

### Execution and commits

The user approved implementation and explicitly authorized committing all verified work. Commit
the existing reviewed repair tranche, then run implementation, verification, independent review and
a focused conventional commit for each step. Stage only that step and verify its complete boundary;
a partial `--paths` result is diagnostic. Preserve unrelated user changes and pause on overlaps.
No resets, tags, pushes, releases or remote writes. Compact the final plan only after retaining its
approved contract and pending gate, and remove its recovery copy after the final commit succeeds.

### Approval gate

Recommended choices are recorded above: tracked revision-bound approval without an identity
service; per-worktree local execution state; a privacy-limited tracked CI manifest; complete soft-
budget contracts; local best-effort Codex capture; explicit history selection; and twelve bounded
fixture-agent attempts. Approval authorizes these implementation choices and local validation,
including independent plan/step reviewers and isolated evaluation agents, with local commits now authorized. Implementation is approved; publishing remains outside scope.

### Resume checkpoint

Plan: docs/features/agent-delivery-workflow.md
Completed implementation: Steps 1–7.
Next gate: independent review, exact staged verification, then commit.
Resume condition: resolve review findings and obtain a passing receipt before Step 8.
