---
title: Registry Health And Change Control
status: draft
type: feature
owner: ""
sources: []
depends_on:
  - cli
  - commands
  - lib
last_reviewed: 2026-06-04
---

## Summary

Codument should optimize its deterministic change-control layer before adding more workflow polish. The Peelmeal dogfood repo showed that Codument can preserve valuable product and architecture memory, but its current flat source-to-doc registry can become hard to maintain as docs and mappings grow.

The next product wedge is not more generated documentation. It is a local, git-native safety layer that helps developers understand AI-made changes: which feature owns a changed file, which docs are stale, which secondary areas are impacted, whether the active plan still matches the diff, and whether the Codument docs themselves are becoming noisy.

## Current Decision

Build registry health and change control into the free Codument CLI as a standalone open-source capability. Downstream tools can consume the same deterministic model later, but the package should not depend on or advertise any separate product.

The near-term direction has three parts:

1. Add a health diagnostic command, `codument doctor`, to expose registry and docs maintenance problems.
2. Evolve the registry model from flat `sources` into primary ownership, secondary impact, durable docs, dependencies, and optional risk hints, prioritizing a cleaner model over indefinite backward compatibility.
3. Add diff-aware change review with `codument review` once the ownership model can produce useful signal.

Initial implementation decisions:

- Agent routing is part of the change-control surface. At the start of a request, the agent should decide whether the scope is settled enough for `plan-with-docs` or whether it must use `grill-with-docs` with the user before planning. The agent should make that routing decision from context when intent is clear instead of asking the user to name the skill.
- Codument is pre-1.0 and should improve what does not work, even when that means replacing an early data shape. Compatibility is a migration-safety concern, not a reason to preserve a model that makes ownership ambiguous.
- `doctor` starts warning-only for health findings. It should exit nonzero for unexpected runtime failures, but findings such as stale mappings, bloated docs, and empty dependencies should not fail CI until an explicit strict mode exists later.
- Existing `sources` and older `mappings` registries should remain readable and importable for `doctor`, `adopt`, and migration commands. New writes can move to the new registry shape once a backup-and-migrate path exists.
- Doc-size and build-log checks should use conservative default thresholds with CLI options so projects can tune noise without editing code.
- Risk hints should be hand-authored in the new registry shape first. Path-based inference can be limited to obvious generated/build leakage in `doctor`.
- `review` should inspect the uncommitted working-tree diff by default. Arbitrary ref comparison can be added later without changing the analyzer model.
- Context compaction is a step-level post-commit option: after one `work-step`, its `review-work`, and its `commit-work` are complete, the user can choose compact context before starting the next step. It should not be reserved only for whole-feature completion.
- Completed delivery detail in docs should be compacted in place for now. Archival or automated pruning can be a later feature after `doctor` can identify noisy sections reliably.

Feature docs should remain the current product and architecture contract. They should not permanently accumulate verbose delivery logs. Completed delivery detail should be compacted, archived, or removed once the durable decision and current behavior are captured.

## Determinism Boundary

Codument should be explicit about what it can prove deterministically and what remains human or agent judgment. The strongest product surface should present repo facts and risk signals without pretending to understand all semantics.

Deterministic today or with straightforward local analyzers:

- parse and normalize `docs/.registry.json`
- list source and documentation files from the filesystem
- detect missing mapped files and missing mapped docs
- detect unmapped relevant source files
- detect duplicate and high-fanout mappings
- detect generated or build directories leaking into source mappings
- detect empty `depends_on` across mature registries
- detect oversized docs and oversized build-log sections
- read git diff and group changed files by registry relationships
- compare changed source files against changed mapped docs
- expand explicit registry dependencies
- score fixed fixtures, as the benchmark commands already do

Structured fields can make these checks deterministic, but prose alone cannot:

- primary feature ownership for a file
- secondary impact relationships
- whether a changed file was in scope for an approved plan
- which docs should be considered required for a source change
- which verification commands apply to a feature
- which risk class applies to a source path or feature area

These should remain evidence-based human or agent judgment unless Codument has explicit structured data:

- whether documentation prose is good enough
- whether an architecture decision is correct
- whether a code change is semantically safe
- whether a feature boundary is conceptually perfect
- whether an implementation is the right product choice

The CLI should therefore say "here are the repo facts and suspicious gaps," not "this change is definitely safe." `doctor` and `review` should be strongest when they report explainable evidence.

## Peelmeal Evidence

Peelmeal has used Codument from early development and is a useful stress case. Its docs contain real value: the overview explains the product loop and architecture compactly, and feature docs preserve decisions that code alone would not explain.

The maintenance problem showed up in the registry and doc shape:

- 48 registry entries, all marked `current`
- 1,508 total source mappings
- 576 unique mapped source paths
- 422 files mapped to more than one doc
- every registry entry had `depends_on: []`
- several feature docs had grown into hundreds or thousands of lines

That means Codument can say "this file is related to these docs", but it cannot reliably say "this doc is the primary owner, these docs are secondary impacts, and this dependency is high risk." Without ranking and review pressure, Codument can become a warehouse of accumulated context.

## Registry Model Direction

Prefer the simplest registry model that supports real change control. Old registries should be recoverable and migratable, but they should not restrict the new shape.

New code should normalize old and new registry inputs at the boundary, then run analyzers against one clean internal model. The internal model should not treat legacy `sources` as first-class ownership once primary and related source fields exist.

The future registry entry should support:

- `primary_sources` for files owned by the feature or concept
- `related_sources` for files that affect or are affected by the feature but are not owned by it
- `docs` for durable docs, ADRs, runbooks, QA notes, or research docs that inform the feature
- `depends_on` for explicit feature, concept, ADR, or shared-module dependencies
- optional `risk` hints for shared infrastructure, auth, payments, data loss, security, generated code, public API, or high-fanout surfaces

Migration rule: legacy `sources` and old `mappings` stay readable/importable until a migration path exists. After that, generated registries and normal command writes should use the new shape. Migration should create a backup, preserve all source/doc relationships, mark ambiguous ownership explicitly, and let `doctor` explain what still needs human promotion into `primary_sources` or `related_sources`.

## Command Shape

### codument doctor

`codument doctor` should diagnose Codument health, not product-code correctness. It should be deterministic, local, and useful on real repos before any AI analysis exists.

It should flag:

- bloated docs over configurable line or word thresholds
- empty `depends_on` across mature registries
- duplicate mappings with no primary owner
- registry entries whose source files no longer exist
- relevant source files that are not mapped
- generated/build directories accidentally included as source
- large `Definition of Done` or `What Was Built` sections that should be compacted
- stale `.codument-meta.json` versions or old generated workflow files

The first version can be warning-only and should explain why each finding matters.

### codument review

`codument review` should be the no-daemon snapshot command for the current git diff. It should read git changes, the active plan docs when detectable, `docs/.registry.json`, and changed docs.

It should report:

- changed files grouped by primary feature when known
- changed files with no registry owner
- source files changed while mapped docs stayed untouched
- docs changed while mapped source stayed untouched
- files touched outside the approved plan or likely impacted files when plan hints exist
- high-fanout files that map to many docs
- dependent features that may need review

### codument watch

`codument watch` can come after `review`. It should continuously refresh the same change-state summary in a second terminal while the agent works. The watcher should reuse the same underlying analyzer as `review`.

## Non-goals

- Do not require a daemon for the basic `review` safety gate.
- Do not claim semantic impact analysis before registry ownership and dependencies exist.
- Do not add more generated docs without pruning and quality pressure.
- Do not make Codument run the coding agent in this feature.
- Do not silently discard existing registry information during migration.
- Do not maintain compatibility shims that keep the old flat ownership model alive as a permanent product constraint.

## Delivery Plan

Status: draft, awaiting approval before source edits.

- [ ] Step 1: Harden the generated workflow instructions and delivery skills so every request starts by classifying whether to use `grill-with-docs` first or go straight to `plan-with-docs`, and so compact context is offered after each reviewed-and-committed step loop.
- [ ] Step 2: Add a shared registry/docs health analyzer that reads a project root and returns typed warning findings for missing `docs/.registry.json`, missing mapped docs, missing mapped source files, duplicate/high-fanout legacy source mappings, and empty `depends_on` across mature registries.
- [ ] Step 3: Wire `codument doctor` to the health analyzer with warning-only human output, configurable doc-size thresholds, and CLI tests for success, missing registry, and finding output.
- [ ] Step 4: Expand `doctor` coverage with source discovery and doc-quality checks: unmapped relevant source files, generated/build-source leakage, oversized docs, and oversized `Definition of Done` or `What Was Built` sections. Include a Peelmeal-shaped fixture.
- [ ] Step 5: Extend registry types and normalization to support `primary_sources`, `related_sources`, `docs`, `depends_on`, and optional `risk`, while keeping legacy `sources` and `mappings` readable/importable at the boundary.
- [ ] Step 6: Update `scan`, `adopt`, generated docs, and registry templates so new writes use the new registry shape, with backup-and-migrate behavior for existing projects and explicit ambiguity markers where ownership cannot be inferred.
- [ ] Step 7: Add a diff snapshot analyzer for uncommitted git changes using the normalized registry model to identify owners, related impacts, stale docs, docs changed without mapped source changes, unmapped changes, high-fanout files, and dependent features.
- [ ] Step 8: Wire `codument review` to the diff analyzer with deterministic human output and CLI tests against a temporary git repo.
- [ ] Step 9: Refresh README/product language around Codument as an AI change-control safety layer, including clear guidance that agent workflow routing is automatic from installed instructions while CLI commands provide deterministic review and health checks.

## Acceptance Criteria

- Existing registries with `sources` or old `mappings` can be read, diagnosed, backed up, and migrated without data loss.
- New registry writes use the new ownership-aware shape after migration support exists.
- Generated workflow instructions make the grill-versus-plan routing decision explicit before planning begins.
- Compact context is offered after every completed step loop once the step is reviewed and committed, not only after a whole feature is finished.
- `codument doctor` runs without network access or an AI model.
- `doctor` defaults to warning-only health findings and documents the difference between findings and runtime failures.
- `doctor` reports actionable warnings on a fixture that resembles Peelmeal's registry/doc bloat failure mode.
- `doctor` distinguishes Codument health issues from application correctness issues.
- The normalized registry model can answer primary owner, related impact, docs, dependencies, and risk hints when present.
- `scan` and `adopt` do not make mature repos noisier by treating every relationship as equal ownership, and they do not preserve the old flat model as a permanent constraint.
- `codument review` can run against an uncommitted git diff and group changed files by known ownership.
- `doctor` and `review` separate deterministic evidence from human or agent judgment.
- README explains both sides of Codument: installed agent workflow routing and deterministic CLI safety checks.

## Verification Strategy

- Unit test registry normalization for legacy and new entry shapes.
- Unit test migration from legacy `sources` and old `mappings` into the new ownership-aware shape with backups and ambiguity preservation.
- Unit test generated workflow instructions and installed delivery skills for the grill-versus-plan router and post-step compact option.
- Unit test the shared health analyzer with temporary fixture repos.
- CLI-level tests for `doctor` output, option parsing, and warning-only exit behavior.
- Unit test generated/build directory filtering so common outputs are ignored.
- Unit test duplicate/high-fanout mapping reporting.
- Unit test doc-size and build-log-section detection.
- Unit test diff snapshot analysis with a temporary git repo.
- Later CLI-level tests for `review` using a temporary git repo with changed source and docs.
- Run `npm run typecheck`, `npm run build`, and `npm test` for implementation steps.

## Open Questions

- What default thresholds should `doctor` use for bloated docs and oversized build-log sections?
- Should `doctor --strict` ship with the first command version, or wait until warning noise is proven low on real repos?
- Should migration live inside `adopt`, a new `codument migrate-registry` command, or both?
- Should `watch` be implemented as a thin loop around `review`, or should it wait for a future analyzer API?
