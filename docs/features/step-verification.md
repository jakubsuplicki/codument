---
title: Focused step verification
status: approved
type: feature
last_reviewed: 2026-09-03
---

# Focused step verification

## In plain terms

Codument verifies the change about to be committed, not every unfinished edit in the workspace. A
developer or agent stages one delivery slice and runs one command; unrelated unstaged work stays
visible without blocking that slice.

## Design approach

One change-set projection defines the boundary for every consumer. Locally it resolves from the Git
index, in CI from the merge-base range, and for focused inspection from an explicit subset of staged
paths. The projection is passed through documentation drift, test impact, acknowledgments, review
grounding, review artifacts, and the final verdict so no surface silently widens back to the whole
worktree.

For a staged review, that projection is also the read boundary. Registry ownership, approved-plan
scope, exclusions, source baselines, and documentation pointers are resolved from the selected Git
snapshot, so an unrelated worktree edit cannot alter the verdict indirectly through control-plane
state.

The compact verification surface is the normal step gate. It combines documentation synchronization
and required adversarial-review coverage, prints actionable failures by default, and keeps full
diagnostics and a deterministic machine contract available on demand. When a clean non-trivial
boundary lacks review coverage, that invocation writes a deterministic ready-to-fill worksheet;
record-and-verify consumes the same shape, so the workflow never depends on a user reverse-engineering
loose JSON or running a separate preparation command.

Tests are evidence rather than documentation subjects. Explicit invariant pins are authoritative;
supported direct imports are a fallback signal; an unattributed test is named rather than guessed.
Test changes participate in impact and review invalidation but never wake a doc or require registry
ownership.

## Invariants & boundaries

- The local authoritative verdict covers exactly the complete staged set; an explicit subset is
  diagnostic until it equals that set and cannot satisfy a strict gate. *(tests:
  `change-set.test.ts` staged/subset matrix; `review-boundary.test.ts` strict subset refusal)*
- A path changed both in the index and again in the working tree fails before analysis, because the
  committed bytes and inspected bytes differ. Dirty paths outside the staged set never block.
  Registry, plan, exclusion, and doc reads follow the same snapshot. *(tests: `change-set.test.ts`
  overlap refusal and outside-churn fingerprint; `review-boundary.test.ts` command-level overlap,
  concurrent dirty work, and staged control-plane fixtures; `verify.test.ts` compact-command parity)*
- Every boundary consumer receives the same base, paths, transitions, and fingerprint. An
  acknowledgment, review artifact, or verification receipt from another boundary never clears this
  one. Printed acknowledgment remedies reproduce that boundary and refuse if it moves before the
  decision is recorded. Review bundles disclose the compact projection identity they hand to the
  reviewer, and artifacts persist the same binding. Unrelated diagnostic churn is deliberately not
  part of either stamp. *(tests: `review-boundary.test.ts` focused remedy,
  moved-boundary refusal, bundle, and artifact flow; `review-artifact.test.ts` exact-binding
  round-trip and coverage; `change-set.test.ts` receipt parity; `verify.test.ts` receipt integration)*
- Staged tests affect evidence attribution, dependency blast reporting, and review fingerprints
  while remaining excluded from documentation ownership and staleness. Explicit invariant pins win
  over supported direct TypeScript imports. A deleted test can retain its surviving pin; any test
  those signals cannot attribute stays visible as unattributed rather than being guessed. *(tests: `test-impact.test.ts` attribution and
  dependency matrix; `review-boundary.test.ts` focused command, bundle, and artifact flow;
  `review-bundle.test.ts` test-only oracle and delta projection)*
- The default human output contains only actions that can change the verdict; `--details` preserves
  complete diagnostics and `--json` remains byte-deterministic for the same repository state.
  *(test: `verify.test.ts` human/JSON parity)*
- CI range verification keeps the existing merge-base fail-closed review semantics and does not
  depend on an index. Local verification does not reinterpret that compatibility route.
  *(tests: `review.test.ts` range fixtures)*
- The ordinary green, already-reviewed or trivial step requires one user-invoked verification
  command. A clean non-trivial step with no review requires two: the first writes its worksheet and
  record-and-verify completes it; no unchanged-boundary third run occurs. An ordinary rerun preserves
  a same-boundary worksheet being completed, while explicit preparation deliberately refreshes it.
  *(test: `verify.test.ts` command-budget and worksheet flow)*
- Working-tree review, whole-repository doctor, unsupported-file policy, and acknowledgment
  eligibility keep their existing semantics. This feature focuses their boundary; it does not
  re-litigate their judgments.

## Decisions

- The local boundary is the Git index, per [ADR 022](../architecture/decisions/022-the-local-delivery-boundary-is-the-git-index.md).
- Verification never stages files automatically. The agent stages explicit paths, preserving the
  user's unrelated work and making the commit boundary reviewable before the gate runs.
- A successful local verification may write an untracked receipt under Git-owned state. The receipt
  names the Codument version and exact boundary identity without a timestamp, so identical state is
  byte-deterministic. It is a cache, never authority beyond its fingerprint; the hook recomputes the
  fingerprint and reruns the gate on any mismatch.
- Review preparation and recording are first-class parts of the verification command. A clean
  uncovered boundary writes its worksheet automatically, an explicit preparation mode can reproduce
  it, and record-and-verify both persists the artifact and returns the resulting verdict.
- Detailed legacy surfaces remain available during migration. The workflow changes entry point
  without removing diagnostic commands in the same release.

## Key files

- `src/lib/change-set.ts` — boundary resolution and fingerprint contract shared by every focused
  consumer.
- `src/lib/test-impact.ts` — test-evidence attribution and dependency impact without documentation
  ownership.
- `src/commands/verify.ts` — compact verification, worksheet, record-and-verify, and receipt surface.
- `src/commands/review.ts` — the detailed change-control and adversarial-review engine; it accepts a
  selected boundary and reads its control-plane inputs from the same snapshot.
- `src/lib/git.ts` — existing Git seam extended with index-scoped facts.

## Delivery Plan — Plan 50: the change is what will be committed

Status: approved 2026-08-24.

- [x] **Step 1 — Change-set substrate.** Add the staged, range, and explicit-staged boundary model, index change enumeration, overlap refusal, deterministic fingerprint, and focused unit/CLI fixtures.
- [x] **Step 2 — Change-control integration.** Thread the boundary through drift, ownership, deletions, renames, plan-scope reporting, and detailed review output while preserving the existing working-tree and CI range contracts.
- [x] **Step 3 — Boundary-bound decisions and attestations.** Make acknowledgments, review bundles, review artifacts, printed remedies, and their invalidation rules consume and reproduce the exact boundary context.
- [x] **Step 4 — Test evidence.** Attribute staged tests through invariant pins and supported direct imports, expose unattributed tests, and include test changes in impact and adversarial-review fingerprints without creating documentation obligations.
- [x] **Step 5 — One verification surface.** Add compact staged verification, deterministic detailed and JSON modes, automatic review worksheets for clean uncovered boundaries, record-and-verify, and exact-fingerprint pass receipts for the pre-commit arm.
- [ ] **Step 6 — Workflow migration and field proof.** Stage before review in the installed skills, remove redundant per-step review invocations, teach the hook to reuse an exact receipt, update public guidance, and replay concurrent-dirty, test-change, Windows-command, and invocation-budget scenarios end to end.

### Feature Map

```feature-map
src/lib/change-set.ts   | step-verification | feature | resolves the exact staged, range, or explicit delivery boundary
src/lib/test-impact.ts  | step-verification | feature | attributes changed tests as review evidence without doc ownership
src/commands/verify.ts  | step-verification | feature | compact step gate plus review worksheet and recording workflow
```

### Outcome

A local step is verified against the bytes queued for its commit, so unrelated unstaged work no
longer blocks it and partially staged in-scope files cannot produce a false pass. Documentation,
test impact, acknowledgments, and adversarial-review artifacts agree on that boundary.

The ordinary green path becomes one `codument verify` invocation with actionable output; full detail
remains available when requested. A clean non-trivial first run writes the review worksheet and one
record-and-verify call completes it, replacing the inferred JSON workflow without adding a separate
preparation invocation. CI continues to verify the committed merge-base range.

This does not make test execution hermetic, change unsupported-file policy, replace Git staging,
remove existing diagnostic commands, or make Codument run the coding agent.

### Acceptance criteria

- A clean staged source/doc/test slice passes even when unrelated unstaged files elsewhere would make
  today's whole-worktree gate red; those files are counted but never included in its artifacts.
- A blocking contract event inside the staged slice still fails with a remedy copied from the actual
  staged invocation context; applying it, restaging, and rerunning clears the finding.
- A staged file edited again after staging fails before any green verdict, naming the exact mismatch.
- Explicit staged paths inspect only those paths, but cannot mint a commit receipt while other staged
  paths remain outside the selection.
- A staged test is attributed where evidence exists, otherwise named as unattributed; neither case
  asks for prose or registry ownership, and changing the test invalidates a covering review.
- A clean uncovered verification writes a valid worksheet shape, and record-and-verify accepts that
  same file without redirects, undocumented flags, or hand-authored artifact structure on Windows.
- A successful already-reviewed or trivial step takes one manual verification call; a clean
  non-trivial first review takes exactly two—worksheet-producing verify, then record-and-verify—with
  no unchanged-boundary third run. The field fixture asserts this budget rather than reporting it
  after the fact.
- `review` working-tree compatibility, `doctor` whole-repo health, SARIF, hooks, and CI range behavior
  retain regression coverage throughout the migration.

### Verification strategy

- Pure tests pin change-set mode resolution, ordering, transitions, fingerprints, and receipt
  invalidation.
- Repository fixtures exercise staged additions, deletions, renames, partial staging, unrelated dirty
  work, explicit subsets, initial commits, and merge-base CI ranges on Windows-safe argv.
- Cross-surface tests prove review, acknowledgments, worksheets, artifacts, hooks, JSON, and remedies
  receive one boundary and cannot print or honor another.
- Test-impact fixtures cover invariant pins, direct TypeScript imports, unattributed tests, test-only
  changes, and the no-doc-obligation boundary.
- The field-shaped replay measures Codument invocations and proves the old whole-worktree failure no
  longer blocks the staged step.
- Each implementation step runs typecheck, build, its focused suites, and the strongest practical
  broader regression pass before review.

### Open questions

None. The staged authoritative boundary, diagnostic explicit subsets, CI range behavior, test-evidence
role, compatibility posture, and non-hermetic test limit are settled for this plan.
