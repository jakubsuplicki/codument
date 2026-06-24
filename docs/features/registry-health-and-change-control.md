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
last_reviewed: 2026-06-24
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
- Codument is pre-1.0 and effectively single-user (the author's own repos: codument, codument-studio, Peelmeal). Do not invest in backwards-compatibility shims, a permanent dual-read layer, or data-loss-proof migration. Prefer the cleanest new shape and convert the author's own repos directly. A one-shot migration that reads legacy `sources`/`mappings` once, with an optional backup, is sufficient; ambiguity-preservation machinery is out of scope.
- The v2 registry shape is THE model from the start. The analyzers (doctor, review, score) are built once on v2 and read only v2 — there is no dual-read boundary, no legacy-normalization layer carried forward, and no flat-registry analyzer. Almost no one uses the old format yet, so optimize for the best v2 shape rather than coexistence. The legacy shape is touched exactly once, by the one-shot migration, after which the legacy read path is removed.
- Doc-size and build-log checks should use conservative default thresholds with CLI options so projects can tune noise without editing code.
- Risk hints should be hand-authored in the new registry shape first. Path-based inference can be limited to obvious generated/build leakage in `doctor`.
- `review` should inspect the uncommitted working-tree diff by default. Arbitrary ref comparison can be added later without changing the analyzer model.
- Context compaction is a step-level post-commit option: after one `work-step`, its `review-work`, and its `commit-work` are complete, the user can choose compact context before starting the next step. It should not be reserved only for whole-feature completion.
- Completed delivery detail in docs should be compacted in place for now. Archival or automated pruning can be a later feature after `doctor` can identify noisy sections reliably.
- Approved-plan autopilot is an opt-in per-run mode, not the default. It only runs after the approval gate, auto-advances `work-step` -> `review-work` -> `commit-work` per step without prompting, still running each gate and committing per step, and pauses only on a review finding that needs human judgment, a verification failure, or an out-of-plan change. The gates are not removed; the agent simply stops waiting for routine confirmations.
- `commit-work` and all generated commit guidance must commit with the user's identity only and must never add an AI agent `Co-Authored-By` trailer.
- `doctor` is framed as documentation coverage (the Jest/coverage analogy): a deterministic gap-finder, not a quality judge. It reports two separate channels — a scored coverage axis (ownership, freshness/drift, dependency, risk) and lint-style warnings (bloat, duplicate mappings, generated leakage). Bloat and other mess are never folded into the coverage number.
- The coverage denominator is defined deliberately, not naively. It must exclude generated/build/test files and trivia and should prefer feature-level counting; a naive every-file denominator makes the score noise. This is the key open design decision for the scored axis.
- Findings and ratios carry machine-readable counts; commands offer a `--json` mode over a stable contract usable by CI, a badge, and a future GUI. Results may be timestamped and appended to a history log for trend; timestamps never feed the score itself.
- The coverage/lint work adds no new npm/runtime package dependencies (Node built-ins plus the existing `picocolors`, `commander`, `prompts`; `badge-maker` is an optional package only if a polished badge is wanted). It does rely on the already-required `git` CLI for the git-history ratios and for `review`/`watch`; Codument is positioned as git-native, so that is acceptable. When `git` is absent or the directory is not a git repo, the git-dependent ratios (freshness/drift) are reported as N/A and excluded from the rolled score with the denominator adjusted deterministically, rather than failing the run. Recompute is on demand (manual, git hook, or CI); there is no daemon.
- The coverage score is a pure deterministic function of repo state, and any public README badge is earned: validate that the score moves at the right moments by backtesting it against Peelmeal's real git history before exposing a badge.

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
- roll the counts above into documentation-coverage ratios over an explicitly defined denominator

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

Prefer the simplest registry model that supports real change control. The v2 shape below is THE model — analyzers read it directly. There is no dual-read boundary and no legacy-normalization layer carried forward into the running code. The author's existing registries are converted once by a one-shot migration (optional backup); after that the legacy read path is removed and every analyzer reads only v2. Because almost no one uses the old format yet, optimize for the cleanest v2 shape from the start rather than for coexistence.

The v2 registry entry supports:

- `primary_sources` for files owned by the feature or concept
- `related_sources` for files that affect or are affected by the feature but are not owned by it
- `docs` for durable docs, ADRs, runbooks, QA notes, or research docs that inform the feature
- `depends_on` for explicit feature, concept, ADR, or shared-module dependencies
- optional `risk` hints for shared infrastructure, auth, payments, data loss, security, generated code, public API, or high-fanout surfaces

Migration rule: the one-shot migration is the only code that ever reads the legacy `sources`/`mappings` shape. It rewrites them into v2 once, with an optional backup; after that the legacy read path is removed and every analyzer reads only v2. Because Codument is pre-1.0 and single-user, do not maintain a permanent dual-read compatibility layer or data-loss-proof/ambiguity-preservation machinery; `doctor` flags entries that still need human promotion into `primary_sources` or `related_sources`.

## Command Shape

### codument doctor

`codument doctor` should report **documentation coverage**, the same way Jest/Istanbul report test coverage: a deterministic gap-finder, not a quality judge. High coverage does not certify good docs; low coverage reliably means undocumented or stale areas. It must run locally with no network and no AI model, and produce the same numbers for the same repo state.

It reports along two separate axes. Do not merge them into one number.

**Coverage (the scored axis).** Deterministic ratios with an explicitly defined denominator:

- ownership: share of in-scope source files that have a documented owner (the easy baseline, like coverage "lines"). The numerator counts a file as owned only if it is itself in-scope (passes the same exclusion globs as the denominator); membership in a `sources` array does not exempt a generated/test file. This ratio measures registry membership, not doc quality — see the gameability note below.
- freshness/drift: share of recently changed in-scope source files whose mapped docs changed within the same window. "Recently" is a repo-state-only window — the last N commits reachable from HEAD (or a named base..HEAD ref range), never a wall-clock window like `--since=14.days`. N is a CLI option, not the clock; no `now()`/today value may enter the freshness computation. If `git` is unavailable or there are no recently-changed in-scope files, the ratio is N/A and excluded from the rollup.
- dependency: share of mature registry entries with non-empty `depends_on` (harder and more telling, like coverage "branches"). "Mature" must be a deterministic, non-lossy signal — an entry with at least one in-scope source and a status not in a planned/draft set — which requires Step 5 to preserve the real status vocabulary instead of the current normalizer that flattens unknown statuses to `current`.
- risk: share of declared high-risk areas that carry risk hints or docs. The `risk` field does not exist until Step 5, so before then this ratio has an empty denominator and is excluded from the rollup (see rollup rule).

The denominator is the critical design decision. "What should be documented" is a choice, unlike "every executable line" in test coverage. A naive every-file denominator turns the score into noise, so:

- One canonical, version-controlled exclusion spec (explicit globs for `*.test.*`, `*.spec.*`, `__tests__/`, `*.seed.json`, `scripts/generate-*`, generated markers, plus the existing `IGNORED_DIRS` set) is shared by every analyzer and applied to BOTH numerator and denominator. Step 2 must reconcile the divergent lists in `detect.ts` and `scan.ts` onto this one spec so coverage, lint, `review`, and `watch` never disagree. The spec is CLI-overridable (consistent with "tune noise without editing code").
- The exclusion filter overrides the registry's own contents: a test/generated path already listed in some entry's `sources` is still filtered out of both numerator and denominator.
- Multi-mapped files are handled explicitly. File-level counting dedupes to distinct paths (count once). Feature-level counting defines the unit as "registry entries with at least one in-scope source," which avoids single-owner attribution. Feature-level becomes meaningful only once `primary_sources` exists (Step 5); until then the shipped default is deduped file-level counting.

**Lint (separate warnings, not a percentage).** ESLint-style findings that flag mess, reported as counts with evidence, never folded into the coverage score:

- bloated docs (measured by size, oversized sections, and accumulated completed-step logs; see below)
- duplicate mappings with no primary owner
- registry entries whose source files no longer exist
- generated/build directories accidentally included as source
- features whose `sources` are dominated by trivial (index/barrel/types/constants) or generated paths — an ownership-inflation signal, since `sources` membership is author-controlled and unverified
- empty `depends_on` across mature registries
- stale `.codument-meta.json` versions or old generated workflow files

Bloat is measured deterministically by three signals rather than one line count: whole-doc size (configurable line/word thresholds), per-section size (which `Definition of Done` / `What Was Built` section is oversized), and completed-log accumulation (count of inline `[x]` items and per-step build logs that should be compacted). Default thresholds start conservative and are calibrated against a Peelmeal-shaped fixture rather than guessed.

Output: human-readable by default, with a `--json` mode that emits findings carrying machine-readable counts so a score, a badge, CI, and a future GUI all read one stable contract. The first version is warning-only and explains why each finding matters. No new npm package dependencies — Node built-ins plus the already-installed `picocolors`/`commander`/`prompts`; the git-history ratios shell out to the already-required `git` CLI. A genuinely unexpected failure still exits nonzero, but git being absent or the directory not being a repo is a known, handled case (freshness reported N/A), not a runtime failure. Note shallow/grafted clones can undercount history-window queries; the badge backtest must run against a full clone. Recompute is on demand (manual, git hook, or CI); there is no daemon. The opt-in `--strict` flag makes findings exit 1 so a CI step can gate on them (notes never count); bare `doctor` stays warning-only (see the Increment section).

### Coverage score and badge

The coverage ratios roll up into a single documentation-coverage score — the headline number and the marketing surface, "test coverage for your docs." It is a pure deterministic function of repo state (filesystem + git + registry): same inputs, same score. Timestamps stamp the record for trend history; they never feed the number. Results persist to `.codument/coverage.json` (the score artifact a badge, CI, or a future GUI reads), and may append to a small history log so the score's trend over time is showable.

Rollup rule (must be specified, or the headline number is undefined): the score is the equal-weight average of the ratios that have a non-empty denominator. Any ratio whose denominator is zero (e.g. risk before Step 5, or freshness with no git/recent changes) is excluded from the average, never counted as 0% or 100%. The headline therefore averages only the computable axes, which keeps it well-defined and avoids NaN. Two repo states with identical counts must produce an identical rolled score regardless of feature insertion or filesystem traversal order.

In the CLI and `review`, the score is a doorway to the underlying findings, never shown naked: a diff leads with the delta ("this change drops coverage N points: K docs now stale"), which is self-relative and avoids meaningless cross-repo comparison. The README badge is the one place the absolute number stands alone — that is inherent to a badge, so the plan does not pretend otherwise. We make the badge honest in two ways instead: (1) it is earned via the backtest below before exposure, and (2) the limitation is stated plainly — it is a coverage figure (registry membership + freshness), not a quality or correctness score, and absolute cross-repo comparison is not meaningful. A delta/trend badge ("docs coverage -6 this week") that cannot be cross-repo-compared is a tracked alternative (see Open Questions).

The badge renders with no network (hand-rolled static SVG; `badge-maker` is the only optional package if the polished shields look is wanted later). The badge is earned, not assumed: validate that the score moves at the right moments by backtesting it against Peelmeal's real git history (full clone) before exposing a public badge.

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

`codument watch` is the live terminal view: a second terminal that continuously refreshes the same change-state summary while the agent works, so you can watch what it is doing even when the agent runs inside an IDE extension or another window. It is part of the full build (Step 8a), not deferred.

Architecture (worked out earlier; agent-neutral by design):

- The filesystem + git are the shared on-disk state every agent already writes to; `watch` derives its view from them, so it works regardless of which agent or host is driving.
- It reuses `review`'s analyzer through a shared `computeChangeState()` so the watcher and the snapshot command can never disagree.
- An append-only `.codument/events.jsonl` event log carries richer flow events (including the review-effectiveness notes from `docs/concepts/review-effectiveness-metric.md`); `watch` tails it.
- Rendered with an Ink TUI. Run with `GIT_OPTIONAL_LOCKS=0` so polling `git status` does not create lock churn that re-triggers the agent.
- No daemon required: it is a foreground loop the user starts in a spare terminal.

Live-loop cost discipline (battery): the loop must stay cheap because it runs indefinitely in a spare terminal. Three rules keep an idle watcher near-silent. (1) The render loop only writes a frame when the rendered bytes actually change — the animation tick fires many times a second but most idle frames are byte-identical, so an idle tree repaints at roughly clock-second granularity instead of every tick (the dominant idle cost is the full-screen redraw, both stdout churn and the terminal's own re-render). (2) The animation tick is mood-adaptive (`animDelayFor`): ~150ms while `working` so the mascot/typing stays fluid during real edits, ~600ms otherwise, so the loop barely wakes the CPU when quiet. (3) Each data tick computes the working-tree change set once (`getWorkingTreeChanges`) and shares it with both the `buildReview` analyzer and the activity tape, so a refresh spawns a single `git status` tree scan rather than two. The data tick stays at `--interval` (default 2000ms); the cheap `isGitRepo` rev-parse calls are left un-memoized (global memoization would widen the blast radius for a negligible gain — the costly per-tick op is the `status -uall` scan, now de-duplicated).

## Approved-Plan Autopilot

Once the user approves a plan, the per-step gates (`work-step` stop, `review-work` stop, `commit-work` stop) become friction when the user is only confirming. In practice the user repeatedly selects the first option to keep going. Autopilot removes those routine confirmations without removing the control surface.

- Opt-in per run, off by default; triggered by an explicit instruction to the agent: "codument, run the plan" (also "run the plan", "codument this plan", "autopilot", or a best-effort `/work-step --auto` hint). Interrupt with "pause" or "stop autopilot" to return to the manual gated loop.
- Never starts before the plan-approval gate. Approval stays a human decision, detected from an explicit `Status: approved` marker in the active plan.
- Auto-advances `work-step` -> `review-work` -> `commit-work` for each remaining step, committing per step with focused conventional commits.
- Still runs each gate and produces the same durable artifacts (a per-step commit and review notes) as the manual loop. Machine-readable gate events for a live watcher or Studio land later with the `.codument/events.jsonl` work, not in this step.
- Pauses and surfaces when a `review-work` finding needs a human judgment call, verification fails, or a change falls outside the approved plan. The agent may auto-apply only safe, obvious fixes; it must always pause for findings touching public interfaces, security, data loss or deletions, or dependency changes, and for anything ambiguous.
- Reports a compact summary on pause and on plan completion.

## Commit Attribution

`commit-work` must attribute commits to the user only. It must never append an AI agent `Co-Authored-By` trailer in any profile, and the generated `AGENTS.md` and `CLAUDE.md` commit guidance must state this explicitly.

## Non-goals

- Do not require a daemon for the basic `review` safety gate.
- Do not claim semantic impact analysis before registry ownership and dependencies exist.
- Do not add more generated docs without pruning and quality pressure.
- Do not make Codument run the coding agent in this feature.
- Do not silently discard existing registry information during migration.
- Do not maintain compatibility shims that keep the old flat ownership model alive as a permanent product constraint.

## Delivery Plan

Status: **All steps complete (1, 1a, 1b, 2, 3, 4, 4a, 5, 6, 7, 8, 8a, 9).** The full deterministic change-control layer is built, dogfooded, and tested (182 tests, typecheck + build green). Codument's own repo scores 94% documentation coverage. New CLI surface: `doctor` (coverage + lint, `--json`, `--write` → `.codument/coverage.json` + SVG badge), `review` (diff safety against the v2 registry), `watch` (live terminal view), `migrate-registry` (one-shot legacy → v2). The v2 registry shape is the only model the analyzers read (legacy converted once by the migration, then never read again). Shared, deterministic core: `analyze.ts` (coverage/lint), `change-state.ts` (`computeChangeState`, shared by review + watch), `badge.ts`, `git.ts`, `events.ts`. Golden fixtures: `fixtures/benchmarks/change-control/` (doctor + review) and `fixtures/benchmarks/doc-bloat/` (bloat calibration). **Remaining before a public release: the full Peelmeal git-history backtest gate for the public README badge (needs a full clone; not exposed yet), and migrating the external codument-studio/Peelmeal registries by running `codument migrate-registry` there.**

- [x] Step 1: Harden the generated workflow instructions and delivery skills so every request starts by classifying whether to use `grill-with-docs` first or go straight to `plan-with-docs`, and so compact context is offered after each reviewed-and-committed step loop.
- [x] Step 1a: Add an opt-in approved-plan autopilot mode to the generated workflow instructions and delivery skills: after the approval gate, auto-advance `work-step` -> `review-work` -> `commit-work` per step without prompting, run each gate, commit per step, and pause only on a judgment-call review finding, a verification failure, or an out-of-plan change. Off by default; triggered explicitly per run.
- [x] Step 1b: Make `commit-work` (all profiles) and the generated `AGENTS.md`/`CLAUDE.md` commit guidance forbid AI co-author attribution, with a test asserting no agent `Co-Authored-By` trailer is generated. Steps 1a and 1b are workflow-surface changes independent of the registry work and can ship before Step 2.
- [x] Step 2: Define the v2 registry model (types for `primary_sources`, `related_sources`, `docs`, `depends_on`, optional `risk`, and a preserved `status` vocabulary that is not flattened to `current`) as THE shape, and build a shared registry/docs analyzer that reads only v2. The analyzer returns two separate channels: deterministic coverage ratios (ownership, freshness/drift, dependency, risk) computed against an explicitly defined denominator, and typed lint findings (missing mapped docs/source, generated leakage, high-fanout mappings, empty `depends_on`, unmapped source). Every finding and ratio carries machine-readable counts; all traversal is sorted for stable, reproducible output. Implemented in `src/lib/registry.ts` (v2 + `allSources`/`isMatureEntry`/`isLegacyEntry`) and `src/lib/analyze.ts` (`DEFAULT_EXCLUSION_SPEC`, `discoverSourceFiles`, `analyze`, `rollupScore`); `detect.ts`/`scan.ts` now derive their ignore lists from the shared exclusion spec. The flat/legacy read path is intentionally retained as a transient normalization branch (folding legacy `sources`/`mappings` into v2) and is removed in Step 5; tested in `tests/analyze.test.ts` and the rewritten `tests/registry.test.ts`.
- [x] Step 3: Wire `codument doctor` to the analyzer with warning-only human output and a `--json` mode over a stable contract. Default the coverage denominator to exclude generated/build/test files and prefer feature-level counting. CLI tests for success, missing registry, finding output, and deterministic stability (same inputs -> same numbers). Implemented in `src/commands/doctor.ts` (`buildReport()` pure contract + `doctor()` printing), wired into `src/cli.ts`; tests in `tests/doctor.test.ts` (unit on `buildReport` + CLI smoke through `dist`). Findings never change the exit code (warning-only); `--strict` remains a tracked Open Question.
- [x] Step 4: Expand `doctor` lint coverage with source discovery and doc-size checks: unmapped relevant source files and generated/build-source leakage (landed in Step 2 alongside the shared discovery the ownership denominator needs), plus bloat measured by whole-doc size, oversized sections, and completed-log accumulation (Step 4). Added the Peelmeal-shaped calibration fixture `fixtures/benchmarks/doc-bloat/` (each doc isolates one signal) and conservative CLI-overridable default thresholds (whole-doc 400 lines, section 150 lines, completed-log 15 `[x]` items). The change-control `tasks.md` is flagged by the completed-log signal. Tested in `tests/analyze.test.ts`.
- [x] Step 4a: Roll the coverage ratios into a single deterministic documentation-coverage score using the equal-weight-average-of-defined-ratios rule (zero-denominator ratios excluded, never counted as 0%/100%) — implemented as `rollupScore` in Step 2 and surfaced as `coverage.percent`. `doctor --write` emits `.codument/coverage.json` (deterministic, timestamp-free score artifact) and a no-network README badge `.codument/coverage.svg` (hand-rolled SVG in `src/lib/badge.ts`, `N/A` rather than `0%` when no ratio applies). The score runs in the documented degraded mode on the author's own legacy registries until the Step 5 migration populates real `risk`/`primary_sources` (confirmed by dogfooding: codument's own repo reports risk N/A). A synthetic backtest (`tests/backtest.test.ts`) proves the score drops at drift moments (unmapped source appears, dependency dropped). **Remaining gate before exposing a public README badge: the full Peelmeal git-history backtest (needs a full clone; also exercises freshness/drift) — tracked in Open Questions and Step 9.** The diff-view score-delta lead is wired in Step 7/8.
- [x] Step 5: Provide the one-shot migration that converts the author's existing registries from the legacy `sources`/`mappings` shape into v2 (optional backup), and hand-author `primary_sources`/`related_sources`/`risk` where ownership needs human judgment. Implemented `migrateRegistry`/`registryNeedsMigration` in `src/lib/registry.ts` (the only legacy reader) and the `codument migrate-registry` command (`src/commands/migrate.ts`, with backup + idempotent + `--dry-run`); `adopt` auto-migrates legacy registries via the same path. **The normal read path (`normalizeRegistry`/`readRegistry`) is now v2-only — the legacy fold is removed.** Migrated the author's own registry plus the `quality-app` and `context-routing` benchmark fixtures to v2, and added a genuine `risk: ["data-loss"]` hint to the migration feature so the risk ratio leaves degraded mode (codument now scores 94%: ownership 22/22, dependency 5/6, risk 1/1). Tested in `tests/migrate.test.ts` and the rewritten registry tests. (codument-studio/Peelmeal are external repos migrated by running the same command there.)
- [x] Step 6: Update `scan`, `adopt`, generated docs, and registry templates so all writes emit v2 directly (the legacy shape is never written), with explicit ambiguity markers where ownership cannot be inferred. `scan` now writes v2 registry entries (status `needs-review`) and a scaffold doc carrying the audience layers plus a `codument:ambiguity` marker noting it assumed all files are `primary_sources`; `adopt` writes v2 via the migration path; `init` writes an empty v2-compatible registry; `templates/feature.md` and `templates/concept.md` were converted to v2 frontmatter + audience layers. Decided the doc audience-layer heading convention (`## In plain terms` / `## How it works` / `## Decisions` / machine block) — see `docs/concepts/doc-audience-layers.md`. Tested in `tests/scan.test.ts`.
- [x] Step 7: Add a diff snapshot analyzer for uncommitted git changes using the v2 registry model to identify owners, related impacts, stale docs, docs changed without mapped source changes, unmapped changes, high-fanout files, and dependent features. Implemented `computeChangeState` (`src/lib/change-state.ts`) as a pure function of `(registry, changedFiles, optional planScope)` — also surfacing risk touches and out-of-plan changes — plus the git-native `src/lib/git.ts` (`getWorkingTreeChanges`, `GIT_OPTIONAL_LOCKS=0`) as the separate data source so the analyzer stays pure and is shared by both `review` and `watch`. Verified against the change-control fixture's overlay diff in `tests/change-state.test.ts` (stale-auth/db, clean-tasks control, unmapped cache/ratelimit, db high-fanout + dependents auth/tasks, out-of-plan).
- [x] Step 8: Wire `codument review` to the diff analyzer with deterministic human output and CLI tests against a temporary git repo. Implemented `src/commands/review.ts` (`buildReview` pure contract + `review()` printing + `--json`), wired into `src/cli.ts`, using `getWorkingTreeChanges` + `detectApprovedPlanScope` + `computeChangeState`. Output groups changed files by owner and surfaces stale docs, risk touches, out-of-plan/unmapped changes, high-fanout, and dependents; gracefully handles non-git dirs and a clean tree. Tested in `tests/review.test.ts` against a temporary git repo (clean tree, stale doc + unmapped + risk, out-of-plan with an approved plan, CLI `--json`). Dogfooded on codument's own tree (caught real doc drift).
- [x] Step 8a: Add `codument watch` — the live terminal view over the shared `computeChangeState()` (`src/commands/watch.ts`), with the append-only `.codument/events.jsonl` event log (`src/lib/events.ts`, append/read) which `review --log` feeds. No daemon — a foreground interval loop (`--interval`, default 2000ms) with a pure `renderFrame` and a `--once` mode for CI. **Deviation from the original plan: used a zero-dependency ANSI renderer instead of an Ink TUI** to preserve codument's minimal-dependency stance (runtime deps stay commander/picocolors/prompts) — the architecture (shared analyzer, events log, `GIT_OPTIONAL_LOCKS=0`, foreground loop) is unchanged. Tested in `tests/watch.test.ts` (events append/read, `renderFrame`, CLI `--once` against a temp git repo). Dogfooded on codument's own tree.
- [x] Step 9: Refresh README/product language around Codument as an AI change-control safety layer. The README now leads with the two-sides framing (automatic installed agent workflow + deterministic CLI safety checks), documents `doctor`/`review`/`watch`/`migrate-registry`, and updates the legacy-registry guidance to the v2 model and one-shot migration.
- [x] Step 9a (showcase): Added a shipped `codument demo` command (`src/commands/demo.ts`) — a one-command, click-through walkthrough that materializes the packaged change-control fixture as a throwaway git repo and steps (Enter, or `--auto`) through where the project stands → an AI change → the review of that change, running the real commands in-process. Exposed as `npx codument demo` and `npm run demo`; the README leads with a "Try it in 30 seconds" callout. Tested in `tests/demo.test.ts`.
- [x] Step 9b (HTML report): Added `codument report` (`src/commands/report.ts` + the pure `src/lib/report-html.ts` renderer) — a self-contained HTML review report (inline CSS, no network, no JS) that leads with a plain-language verdict + the coverage delta (read from the last `doctor --write`'s `coverage.json`) and finding cards, with a collapsible per-file breakdown. Writes `.codument/report.html` and opens it in the browser (`--no-open`/`--out`). The demo's finale now shows a compact terminal verdict and opens this report. This is also the natural Studio teaser surface (a deterministic artifact a richer UI re-skins). Tested in `tests/report.test.ts`. Rationale: terminal output buried the value under per-file lists; the report leads with the verdict and hides detail.
- [x] Step 9c (self-explaining report): Made the HTML report explain itself so it can be showcased without narration. Every finding card now carries a clickable "what this checks" note, and `renderReviewReportHtml` accepts an optional `DemoExplainer` (`data.demo`) that renders a collapsible "How this demo works" callout — the throwaway-repo framing, the planted scenario (AI asked to add rate limiting; overreached past the approved plan), and a per-file table of why each change is flagged. `codument demo` passes a fixture-pinned explainer. Tested in `tests/report.test.ts` and `tests/demo.test.ts`. Rationale: the user needs to hand the report to a technical audience and have it answer "how does this work / what is it checking" on its own.
- [x] Step 9d (value framing): Reframed the demo + report around the actual comparison. The numbers were ambiguous (the % reads like a comparison to some external baseline; it is not — it is the same repo before vs after this one change, against the 100%-documented ideal). Both the demo's terminal scene ③ and the HTML report (when there are actionable findings) now lead with **without codument** (this diff merges with none of the findings surfaced) **vs with codument** (the findings), and present the coverage swing as a "health gauge, not the verdict." The clean case keeps the plain "looks clean" verdict and no contrast. Tested in `tests/report.test.ts` and `tests/demo.test.ts`. Rationale: the value is the findings codument surfaces that you'd otherwise merge blind, not the percentage swing.
- [x] Step 9e (live showcase): Made the live `watch` experience smooth enough to demo in one terminal. Added `codument demo --live` (`src/commands/demo.ts`: `demoLive`) — materializes the clean sample repo, renders the `watch` panel on a clean tree, then applies the AI change file-by-file, redrawing the panel in place (ANSI clear) so the counts visibly climb (78% clean → 71% with 2 stale / 2 unmapped / 3 out-of-plan / 2 risk), and finishes by opening the HTML report. Reuses the real `buildFrame`/`renderFrame` from `watch.ts` (exported `buildFrame` + `CLEAR`), so the showcase is the actual tool. Also added `codument watch --dir <path>` to watch any repo without `cd`. `npm run demo:live` script added. Tested in `tests/demo.test.ts` (`--live --auto`) and `tests/watch.test.ts` (`--dir`). Rationale: the previous live path needed a second terminal + `git stash` dance; this is one command, one terminal.
- [x] Step 9f (report visual redesign): Rewrote `renderReviewReportHtml`'s presentation (`src/lib/report-html.ts`) with a dark "control room" theme, chosen by the user from 4 design directions generated + critiqued by a multi-agent design workflow (refined-light / dark-control-room / editorial / status-led). Verdict leads (was buried beside the gauge); conic coverage ring is a secondary gauge whose colour tracks the level; findings triage by severity (risk/warn/info) with per-finding "what this checks" expanders; demo callout + breakdown behind native `<details>`. Applied the critics' fixes: cleaned the type scale (no half-pixel sizes), reserved the glow for the gauge + status dots, stated the coverage delta once. Still self-contained (inline CSS, no JS, no network), deterministic, WCAG-AA contrast. Data interface and all conditional branches (clean verdict, N/A coverage, no-plan, no-demo) preserved; tests updated for the new copy (capitalised labels, typographic minus). Rationale: the user needs a genuinely well-designed artifact to showcase to a technical audience.

## Acceptance Criteria

- A one-shot migration converts the author's own registries (`sources`/old `mappings`) into v2; an optional backup is enough. Permanent dual-read and data-loss-proof migration are out of scope (pre-1.0, single-user).
- The analyzers read only v2 — there is no dual-read or legacy-normalization path in the running code; the legacy shape is read solely by the one-shot migration.
- All registry writes (`scan`, `adopt`, templates) emit v2 directly; the legacy shape is never written.
- Generated workflow instructions make the grill-versus-plan routing decision explicit before planning begins.
- Compact context is offered after every completed step loop once the step is reviewed and committed, not only after a whole feature is finished.
- `codument doctor` runs without network access or an AI model.
- `doctor` defaults to warning-only health findings and documents the difference between findings and runtime failures.
- `doctor` reports actionable warnings on a fixture that resembles Peelmeal's registry/doc bloat failure mode.
- `doctor` distinguishes Codument health issues from application correctness issues.
- `doctor` reports documentation coverage as deterministic ratios (ownership, freshness/drift, dependency, risk) over an explicitly defined denominator that excludes generated/build/test files, kept separate from lint-style warnings. The same exclusion spec is applied to both numerator and denominator and shared across all analyzers (`doctor`, `review`, `watch`, `scan`).
- The freshness/drift ratio uses a repo-state-only window (last N commits from HEAD, or a base..HEAD range; N is a CLI option), never a wall-clock window, so no `now()`/today value enters the score.
- The documentation-coverage score is the equal-weight average of ratios with a non-empty denominator; any zero-denominator ratio is excluded (never counted as 0% or 100%), and the rolled score is invariant to feature-insertion and filesystem-traversal order.
- The score persists to `.codument/coverage.json`, the single artifact a badge, CI, or a future GUI reads.
- Ownership coverage measures registry membership, not doc quality; the numerator filters out generated/test paths even when listed in `sources`, and a lint warning flags features whose `sources` are dominated by trivial/index/generated paths.
- The coverage score is a pure function of repo state: identical inputs produce an identical score, with timestamps used only for trend records, never for the number.
- Bloat is reported as a lint warning measured by whole-doc size, section size, and completed-log accumulation, never folded into the coverage score.
- `doctor` exposes a `--json` mode whose findings carry machine-readable counts, usable by CI, a badge, and a future GUI from one contract.
- The coverage score and README badge are validated against Peelmeal's real git history before any public badge is exposed.
- The coverage and lint features add no new npm package dependencies beyond Node built-ins and the existing `picocolors`/`commander`/`prompts` (badge polish via `badge-maker` optional); they rely on the already-required `git` CLI, and when git is absent or the directory is not a repo, freshness is reported N/A and excluded from the score rather than failing the run.
- The v2 registry model can answer primary owner, related impact, docs, dependencies, and risk hints when present.
- `scan` and `adopt` do not make mature repos noisier by treating every relationship as equal ownership, and they do not preserve the old flat model as a permanent constraint.
- `codument review` can run against an uncommitted git diff and group changed files by known ownership.
- `codument watch` renders a live terminal view from the shared `computeChangeState()` analyzer and the `.codument/events.jsonl` log, with no daemon, working regardless of which agent or host drives the changes.
- `doctor` and `review` separate deterministic evidence from human or agent judgment.
- README explains both sides of Codument: installed agent workflow routing and deterministic CLI safety checks.
- Approved-plan autopilot is opt-in per run, never starts before plan approval, auto-advances steps with per-step commits, and pauses on judgment-call review findings, verification failures, or out-of-plan changes.
- Autopilot runs the same gates and produces the same durable per-step artifacts (a commit and review notes) as the manual loop; machine-readable gate events are deferred to the events-log work.
- The `commit-work` skill and generated commit guidance never attribute the AI agent as a commit co-author in any profile.

## Verification Strategy

- Unit test registry normalization for legacy and new entry shapes.
- Unit test migration from legacy `sources` and old `mappings` into the new ownership-aware shape with backups; assert it writes explicit ambiguity markers and flags entries needing human promotion into `primary_sources`/`related_sources` (ambiguity-preservation machinery is out of scope, so it is not a test target).
- Unit test generated workflow instructions and installed delivery skills for the grill-versus-plan router and post-step compact option.
- Unit test the shared health analyzer with temporary fixture repos.
- CLI-level tests for `doctor` output, option parsing, and warning-only exit behavior.
- Unit test generated/build directory filtering so common outputs are ignored.
- Unit test duplicate/high-fanout mapping reporting.
- Unit test doc-size and build-log-section detection.
- Unit test coverage-ratio computation (ownership, freshness/drift, dependency, risk) against fixtures with a defined denominator, including generated/build/test exclusion.
- Unit test score determinism: the same fixture repo yields the same score across runs, filesystem traversal orders, and two different mocked clock times (the score must not move with the wall clock).
- Unit test the rollup rule: zero-denominator ratios (e.g. risk before Step 5) are excluded from the average rather than counted as 0%/100%, and the freshness window is commit-count-based, not duration-based.
- Unit test `--json` output shape and that findings and ratios carry counts.
- Unit test bloat detection across whole-doc size, per-section size, and completed-log accumulation.
- Backtest the coverage score across Peelmeal's git history (full clone) and confirm it drops at known staleness/drift moments before exposing a badge; bloat is backtested separately as a rising lint-count signal, since bloat is never folded into the coverage score. Where practical, name specific commit SHAs with an expected sign and minimum point drop so the gate is mechanical rather than a judgment call.
- Unit test diff snapshot analysis with a temporary git repo.
- Later CLI-level tests for `review` using a temporary git repo with changed source and docs.
- Unit test that generated workflow instructions and the `commit-work` skill contain the autopilot routing and pause conditions and contain no agent `Co-Authored-By` trailer.
- Run `npm run typecheck`, `npm run build`, and `npm test` for implementation steps.

## Increment: `doctor --strict` (opt-in CI gate)

Status: **approved 2026-06-24; implemented, tested, and reviewed. Not yet committed (held per the user's no-commit instruction).**

Resolves the Open Question on shipping `doctor --strict`. The original deferral was about warning noise; that concern is fully handled by making the gate strictly opt-in, so bare `doctor` keeps its warning-only, exit-0 behaviour unchanged.

### Decision

- Add a boolean `--strict` flag to the `doctor` command only.
- With `--strict`, `doctor` exits **1 iff `report.lint.count > 0`** (actionable `warn`-severity findings), otherwise 0. The exit logic keys off the existing `lint.count`, which already counts only `warn` findings and excludes `info` notes (`buildReport` in [doctor.ts](../../src/commands/doctor.ts)).
- **Notes never fail** (e.g. high-fanout): they are `info`, outside `lint.count` by construction, so a repo can never be made to pass `--strict` by silencing an awareness-only signal.
- **Coverage stays informational** — no coverage gate in v1. A coverage floor, if ever wanted, is a separate `--min-coverage <n>` flag, not bundled into `--strict`: a gradient (coverage) and a discrete count (findings) should not share one exit code.
- **Scope is `doctor` only.** `review` is a diff-time advisory that explicitly does not certify a change as safe; gating a specific diff is a different model and can follow later as `review --strict`.
- **Missing registry fails strict**: `missing-registry` is a `warn` finding, so an uninitialised repo run under `--strict` exits 1, which is correct for CI.
- Name is the canonical `--strict`; no `--fail-on-warn` alias, to avoid extra pre-1.0 surface.
- On failure, print a one-line deterministic summary (no wall clock), e.g. `strict: 2 finding(s) present — failing`.

### Non-goals

- No change to bare `doctor` behaviour or output (regression-guarded).
- No coverage threshold, no `--max-findings`, no `review --strict` in this increment.
- No new runtime dependencies and no new source files: this modifies `src/cli.ts` and `src/commands/doctor.ts`, both already owned by this feature in the registry, so no Feature Map is required.

### Delivery Plan

- [x] Step S1: Implement `--strict` and its tests. Register the boolean `--strict` option on the `doctor` command in `src/cli.ts`; add `strict?: boolean` to `DoctorOptions`, and in `doctor()` set `process.exitCode = 1` with the one-line summary when `options.strict && report.lint.count > 0`. Add CLI tests in `tests/doctor.test.ts` driving `dist/cli.js`: dirty fixture + `--strict` exits 1; dirty fixture without the flag exits 0; clean fixture + `--strict` exits 0; `--strict --json` emits the unchanged contract and still exits 1; missing-registry + `--strict` exits 1.
- [x] Step S2: Document and resolve. Update the `### codument doctor` behaviour note in this doc and the `doctor` sections of `docs/features/cli.md` and `README.md` to describe `--strict` (opt-in, findings-only, exit 1); mark the Open Question resolved; bump `last_reviewed`/`last_updated` on the touched docs and the registry entry. (`src/cli.ts` and `src/commands/doctor.ts` are already mapped to this feature; verify, no new registry entry.)

### Acceptance Criteria

- `doctor --strict` exits 1 when `lint.count > 0` and 0 otherwise.
- Bare `doctor` output and exit code are unchanged (always 0 on findings).
- A run whose only diagnostics are `info` notes exits 0 even under `--strict`.
- `--strict` composes with `--json` and `--write`: output is identical to the non-strict run; only the process exit code differs.
- `doctor --strict` on an uninitialised repo (no registry) exits 1.
- The failure summary is deterministic (no timestamp), so output stays byte-stable for the same repo state.

### Verification Strategy

- New cases in `tests/doctor.test.ts` exercise `dist/cli.js` via `execFileSync` (which throws on a non-zero exit) to assert each exit code above; the `--json` case also asserts the parsed contract is unchanged.
- `npm run lint`, `npm run typecheck`, `npm run build`, and `npm test` all green.

## Open Questions

- (Key) What is the exact canonical exclusion glob list, and what default freshness window N (commits)? The file-vs-feature counting question is now resolved in the design (deduped file-level until `primary_sources` exists, then feature-level; multi-mapped files deduped); what remains open is the precise glob set and N, both to be calibrated against the Peelmeal fixture in Step 4.
- Default bloat thresholds (whole-doc, per-section, completed-log) are calibrated against the Peelmeal fixture in Step 4; what conservative starting values should Step 3 ship before that calibration?
- Score/badge sequencing is decided (Step 3 ships no score; the public badge waits for the Peelmeal backtest). Residual: may an internal coverage score surface in `--json`/`.codument/coverage.json` before the backtest, while only the public badge waits?
- Should the public README badge be the absolute coverage number (familiar, like a coverage badge, but cross-repo-comparable) or a delta/trend badge ("docs coverage -6 this week") that cannot be misused for cross-repo comparison?
- ~~Should `doctor --strict` ship with the first command version, or wait until warning noise is proven low on real repos?~~ Resolved (see Increment: `doctor --strict` above): ship it now as an opt-in boolean that exits 1 iff `lint.count > 0`. The warning-noise concern is moot because the gate is strictly opt-in and bare `doctor` stays warning-only/exit 0.
- ~~Should migration live inside `adopt`, a new `codument migrate-registry` command, or both?~~ Resolved (Step 5): both — `adopt` auto-migrates a legacy registry on adoption, and `codument migrate-registry` is the explicit standalone one-shot (with backup, `--dry-run`, idempotent). Both share `migrateRegistry`, the only legacy reader.
- ~~`watch` refresh: fs-watch-driven, fixed-interval polling, or both?~~ Resolved (Step 8a): fixed-interval polling (default 2000ms, `--interval`) — simple, robust across platforms, safe with `GIT_OPTIONAL_LOCKS=0`; fs-watch immediate redraw is a possible future enhancement. Also decided: a zero-dependency ANSI renderer rather than Ink, to keep runtime deps at commander/picocolors/prompts.
