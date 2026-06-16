---
title: Proof Benchmarks
status: in-progress
type: feature
owner: ""
sources:
  - src/commands/benchmark.ts
  - src/lib/benchmark-context.ts
  - src/lib/benchmark-quality.ts
depends_on:
  - cli
  - commands
  - lib
last_reviewed: 2026-06-16
---

## Summary

Codument should include a self-contained way to demonstrate that docs-backed delivery can reduce context waste and improve output quality. The proof should be runnable from the package without relying on a private project, a human judge, or a hidden evaluation process.

The proof has two layers:

- A deterministic context benchmark that compares naive whole-project context against Codument's registry-guided working set.
- A deterministic quality benchmark that ships a fixture project, lets any coding agent attempt the same task, and scores the final repo state with tests and rule-based checks.

The benchmark should be honest about what it proves. Codument can deterministically score context selection and final repo state, but the agent's implementation path remains nondeterministic.

## Current Decision

Add a `benchmark` command family to Codument rather than folding proof into `scan`, `adopt`, or the normal delivery loop.

The README-facing command sequence should stay small:

```bash
codument benchmark context
codument benchmark init /tmp/codument-bench
codument benchmark score /tmp/codument-bench
```

`benchmark context` should run without an AI agent and produce deterministic token-estimate and relevance numbers from a fixture repo. This is the strongest package-native proof that Codument can save tokens by routing agents to a smaller, relevant working set.

`benchmark init` should copy a fixture app into a target directory and print the task prompt for the user to give to their agent. `benchmark score` should evaluate the resulting directory deterministically after the agent finishes.

## Non-goals

- Do not claim that Codument always reduces raw token usage. Tiny tasks may spend more tokens on workflow than they save.
- Do not require network access, model APIs, or hosted telemetry.
- Do not make Codument call an AI model directly for benchmarking.
- Do not use a human or agent judge as the primary benchmark score.
- Do not add persistent usage tracking to normal Codument commands as part of this feature.
- Do not make the quality benchmark depend on timing; wall-clock speed varies too much across agents, machines, and user review habits.

## Benchmark Model

### Context Benchmark

The context benchmark should ship a fixed fixture project with:

- source files that include relevant, adjacent, and irrelevant areas
- feature docs, concept docs, and ADR-like decisions
- a `docs/.registry.json` mapping touched source areas to docs
- one or more benchmark tasks with known required docs and source files

For each task, the scorer compares:

- naive context: all candidate source and docs files that a broad scan might include
- Codument context: registry-guided docs and source files for the task's declared feature area

The score should report estimated token counts using a deterministic local heuristic. The default estimate can be character-count based, with one token approximated as four characters. The exact heuristic matters less than consistency because the benchmark compares two local strategies over the same fixture.

The report should include:

- estimated naive tokens
- estimated Codument tokens
- percentage reduction
- required docs found
- required source files found
- irrelevant files included
- fixture name and task name

### Quality Benchmark

The quality benchmark should ship a fixture app with a deliberately constrained task. The task should be realistic enough to exercise docs, tests, and architecture boundaries, but small enough for README reproduction.

The benchmark should:

1. copy the fixture to a target directory
2. initialize the fixture with Codument docs and skills
3. print a task prompt that can be run with Codex, Claude, or another agent
4. score the final directory after the agent edits it

The scorer should use deterministic checks such as:

- expected tests pass
- typecheck passes, if the fixture has TypeScript
- required behavior exists through black-box tests
- docs registry still maps touched source files
- required docs were updated
- forbidden shortcuts are absent
- expected source boundaries were respected
- generated output does not modify locked fixture files

The score should be a transparent evidence bundle plus a numeric summary. The numeric summary is useful for README screenshots, but the evidence bundle is the real proof.

## Delivery Plan

Status: approved, Step 5 implemented and awaiting review.

- [x] Step 1: Add the benchmark command shell and fixture packaging strategy, including package `files` updates so fixtures ship in npm tarballs.
- [x] Step 2: Implement `codument benchmark context` with a deterministic fixture, context strategies, token estimator, and tests for stable scoring.
- [x] Step 2.5: Add context-benchmark proof hardening for packed-package execution and machine-readable JSON output.
- [x] Step 3: Implement `codument benchmark init` to copy the quality fixture into a target directory and print the agent task prompt.
- [x] Step 4: Implement `codument benchmark score` with deterministic quality checks, a transparent evidence bundle, and tests for pass/fail scenarios.
- [x] Step 5: Update README and feature docs with honest benchmark claims, sample output, and guidance for comparing baseline vs Codument runs.

## What was built in Step 1

- Added a `benchmark` command family with planned `context`, `init <dir>`, and `score <dir>` subcommands.
- Added `fixtures/benchmarks` with a manifest and reserved fixture homes for context routing and quality scoring.
- Added `fixtures` to package `files` so benchmark fixtures ship in npm tarballs.
- Added CLI tests for the benchmark command shell and fixture packaging declaration.

## What was built in Step 2

- Added a deterministic `context-routing` fixture with source files, docs, registry metadata, and a task manifest.
- Implemented a local token estimator based on character count.
- Implemented naive context selection from all fixture source/docs files.
- Implemented Codument context selection from the fixture registry, including declared feature dependencies.
- Made `codument benchmark context` print token estimates, reduction percentage, required-doc coverage, required-source coverage, and irrelevant-file inclusion.
- Added tests for the CLI output, token estimator, selected context files, and stable scoring properties.
- Hardened the benchmark against fake positives by validating fixture file references, stale registry entries, missing transitive dependencies, irrelevant-file over-inclusion, cyclic dependencies, and larger irrelevant context.

## What was built in Step 2.5

- Added `codument benchmark context --json` so README examples and future dashboards can consume a schema-versioned machine-readable report that names the file-context token heuristic.
- Added a packed-package smoke test that runs `codument benchmark context` from an extracted `npm pack` tarball, proving the command works from package contents and not only from the source repo.

## What was built in Step 3

- Added a dependency-free `quality-app` fixture project with source files, tests, docs, a registry, and a locked benchmark metadata file.
- Implemented `codument benchmark init <dir>` so it copies the fixture into an empty target directory, installs selected Codument agent profile assets, writes benchmark metadata, and writes `BENCHMARK_TASK.md`.
- Made the init command print the same task prompt it writes to disk, so users can hand the task to Codex, Claude, or another coding agent.
- Added tests proving the initialized fixture is self-contained, its existing tests pass, and non-empty target directories are not overwritten.

## What was built in Step 4

- Implemented `codument benchmark score <dir>` for the quality fixture.
- Added a transparent evidence bundle with deterministic checks for benchmark metadata, locked files, package tests, black-box skip-day behavior, updated tests, docs registry coverage, docs updates, source boundaries, and benchmark-specific shortcuts.
- Made the score command exit successfully only when every required check passes.
- Added tests for incomplete fixture failure, completed fixture success, and locked benchmark metadata tampering.

## What was built in Step 5

- Added README benchmark usage for `benchmark context`, `benchmark init`, and `benchmark score`.
- Added the current context benchmark sample output and named the token heuristic.
- Documented that the benchmark proves fixture-local context routing and deterministic final-state scoring, not universal token savings or deterministic agent behavior.
- Added guidance for comparing a direct baseline run against a Codument-guided run with the same quality fixture and scorer.

## Acceptance Criteria

- The package exposes a benchmark command family from the main `codument` CLI.
- `codument benchmark context` runs without network access or an AI agent.
- The context benchmark produces stable output for the same package version and fixture.
- The context benchmark reports both token-estimate reduction and relevance coverage.
- The context benchmark can emit a stable JSON report.
- The context benchmark works from packed package contents, not only from the source repo.
- `codument benchmark init <dir>` creates a self-contained fixture repo in the requested directory.
- The quality fixture includes enough tests and docs to evaluate an agent's final output deterministically.
- `codument benchmark score <dir>` can score the fixture after an agent modifies it.
- The quality score reports evidence, not only a single opaque number.
- README language distinguishes deterministic scoring from nondeterministic agent generation.
- Tests cover the command parser, fixture copying, token estimator, context scoring, and quality scoring.

## Verification Strategy

- Unit test the token estimator against fixed strings so the heuristic remains stable.
- Unit test context scoring with a fixture manifest that declares required and irrelevant files.
- Smoke test the context benchmark from an extracted packed tarball.
- Unit test fixture copying into a temporary directory.
- Unit test quality scoring against known passing and failing fixture states.
- Add CLI-level tests for `benchmark context`, `benchmark init`, and `benchmark score`.
- Run `npm run typecheck`, `npm test`, `npm run build`, and `npm pack --dry-run` so fixture files are proven to ship.

## Open Questions

- Should the command be named `benchmark` or `proof`? `benchmark` is more precise for deterministic scoring, while `proof` is stronger product language.
- Should the context benchmark support scoring the user's current repo later, or stay fixture-only for the first version?
- Should quality fixtures include both a baseline task and a Codument task, or should Codument only provide the scorer and let users run each mode manually?
- Should the score file be written to `.codument/benchmark-results.json`, printed only, or both?
- Planned extension: add a review-loop catch-rate benchmark — seed fixtures with known injected bugs and measure whether the `review-work` step catches them (catch rate + false-positive rate), comparing loop vs no-loop. This is the ground-truth proof behind the per-repo review-effectiveness scorecard. See `docs/concepts/review-effectiveness-metric.md`.
