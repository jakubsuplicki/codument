---
title: Commands
status: current
type: feature
last_reviewed: 2026-09-10
---

# Commands

## In plain terms

These commands install Codument, map existing code, and keep managed project files current.
Discovery proposes documentation boundaries for an agent to review; upgrades preserve authored
work and project settings. The separate benchmark commands measure bounded, repeatable outcomes.

## Design approach

The live repository is authoritative. Onboarding detects its current stack and maps existing code
only when creating a registry; an authored ownership map is preserved. Existing projects retain
their approval policy, while new installs require approval bound to the displayed plan revision.

Upgrades reconcile the package, local files, and previous synchronization state. Local divergence
is preserved or backed up before replacement, and shared instruction files change only inside
managed markers. Adoption reuses that reconciliation instead of maintaining a separate merge path.

Discovery and health checks share source-scope rules, including declared exclusions and Git ignores.
Directory structure supplies provisional boundaries, not verified knowledge: scaffolds retain their
uncertainty until documented. [[proof-benchmarks]] owns measurement; it does not run normal delivery.

## Invariants & boundaries

- New installs require bound approval. Reinitialization preserves an existing project's policy.
  *(test: `init.test.ts`)*
- Adoption and update preserve metadata keys they do not own, including unknown future settings.
  *(test: `adopt.test.ts`)*
- Forced initialization affects only managed scaffolds. It preserves authored registry entries
  and unrelated shared agent settings, including permissions, environment and other hooks.
  *(test: `init.test.ts`)*
- Reinitialization and adoption preserve accumulated synchronization state, scan and charter data,
  and original initialization time. *(tests: `init.test.ts`, `adopt.test.ts`)*
- Present but unparseable registry, settings or metadata is refused rather than replaced with empty
  state. *(test: `init.test.ts`)*
- Reinitialization does not duplicate editor hooks and upgrades outdated hook matchers or command
  forms in place. *(test: `init.test.ts`)*
- Existing source is mapped during initialization only when that run created the registry and
  mapping was not declined. Authored maps remain untouched; unresolved discovery scope does not
  undo workflow installation. The next action reflects scaffolds actually created.
  *(test: `init.test.ts`)*
- Commit hooks are opt-in. Before Git initialization, requesting them produces a setup hint rather
  than failing installation. *(test: `hooks-command.test.ts`)*
- A missing local runtime leaves the editor hook dormant without breaking edits; installation
  explains how to enable it. *(tests: `hooks.test.ts`, `init.test.ts`)*
- User prose outside managed instruction markers survives initialization. *(test: `init.test.ts`)*
- Identical local and upstream content requires no backup, even without a prior hash. Genuine
  divergence is backed up before replacement; reports distinguish convergence from unchanged files.
  *(test: `codemod.test.ts`)*
- Update requires project metadata and exits nonzero when it is missing. *(test: `update.test.ts`)*
- An unchanged local managed file can take an upstream update; a local edit with unchanged upstream
  is preserved. *(test: `update.test.ts`)*
- Dry-run adoption and update report proposed actions without changing files or recorded versions.
  *(tests: `update.test.ts`, `adopt.test.ts`)*
- An unwritable or non-directory managed entry is left untouched and named as skipped; other update
  entries can complete. *(test: `update.test.ts`)*
- Upgrade notices name required cleanup and relaxed enforcement, using the incoming project
  version even when a delegating caller already updated metadata. An unreadable prior version and
  a dry run still show the notice; already-upgraded projects are not nagged.
  *(tests: `update.test.ts`, `adopt.test.ts`)*
- Adoption normalizes legacy registry fields without migration and backs up a changed registry
  before replacement. *(test: `adopt.test.ts`)*
- Adoption re-detects the current language and source scope rather than trusting stored metadata.
  *(test: `adopt.test.ts`)*
- Unselected workspace-wide history ranges and root hook installation are refused with a member
  recovery path. Worktree review can still aggregate members. See [[change-control-gate]] and ADR 016.
  *(test: `workspace-refusals.test.ts`)*
- Standalone discovery can create a provisional registry before adoption; workflow installation
  remains a separate choice. *(test: `scan.test.ts`)*
- Discovered entries require review. Their layered scaffolds mark ambiguity and contain no invented
  narrative; detected sources initially receive primary ownership. *(test: `scan.test.ts`)*
- Discovery never overwrites existing documentation, including unmapped filename collisions. It
  can restore a missing scaffold while preserving authored ownership, dependencies, risk, supporting
  docs and status, refreshing only detected sources. *(test: `scan.test.ts`)*
- Known utility directories become concepts; other discovered boundaries become features. The
  shared walker excludes generated/tool output, declarations, language-specific tests, Git-ignored
  content and project-declared exclusions. Undetermined Git ignores and unreadable directories are
  disclosed and recorded while discovery continues; unreadable scope declarations stop writes.
  Declared exclusions still cover tracked output that Git ignores cannot remove. Summaries name
  the exclusions shaping durable proposals. *(test: `scan.test.ts`)*
- Benchmarks stay separate from delivery, use deterministic scoring without network or model calls,
  refuse non-empty quality-fixture targets, and reject changed locked metadata. They do not judge
  subjective quality or an unobserved agent path.
  *(test: `benchmark.test.ts`)*

## Decisions

- [Registry normalization without migration](../architecture/decisions/001-registry-v2-model-no-migration.md).
- [Deterministic benchmark proofs](../architecture/decisions/008-benchmark-proof-deterministic-not-judge.md).

## Key files

- `src/commands/init.ts` — workflow installation.
- `src/commands/scan.ts` — provisional source discovery.
- `src/commands/update.ts` — managed-file reconciliation.
- `src/commands/adopt.ts` — adoption of an existing project.
- `src/commands/benchmark.ts` — bounded evaluation commands.
