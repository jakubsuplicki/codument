---
title: Proof benchmarks
status: current
type: feature
last_reviewed: 2026-06-29
---

# Proof benchmarks

## In plain terms

A package-native way to show that docs-backed delivery helps, without a private repo, a human judge, or a hidden evaluation. Three deterministic benchmarks ship with Codument. The context benchmark asks whether registry-guided context routing selects a smaller, more relevant working set than a naive whole-project scan. The quality benchmark ships a fixture task, lets any agent attempt it, and scores the final repo state with tests and rule-based checks. The catch-rate benchmark ships a diff that carries planted bugs and measures how many the review step catches before commit, comparing a review loop against shipping the diff straight to commit. All run with no network and no AI model, so a skeptic can rerun them and get the same numbers. The honest boundary: Codument can deterministically score context selection and final state, but the agent's path between is not deterministic, so the benchmark never claims universal token savings or deterministic agent behavior.

## Design approach

Proof lives in a `benchmark` command family kept separate from `scan`/`adopt`/the delivery loop, so measurement never tangles with normal work. The surface stays three subcommands: `benchmark context`, `benchmark init <dir>` (the quality task, or the catch-rate scenario with `--seeded`), and `benchmark score <dir>` (with `--mode` and `--baseline` for catch-rate runs).

The **context benchmark** runs over a fixed fixture with relevant, adjacent, and irrelevant areas and a registry mapping each task to its docs and sources. For a task it compares a naive context (everything a broad scan would pull) against the registry-guided context (the task feature's docs and sources plus declared dependencies), estimating tokens with a stable local character-count heuristic — the heuristic's exact value matters less than its consistency, since the benchmark compares two strategies over the same fixture. It reports token reduction alongside relevance coverage (required docs found, required sources found, irrelevant files included) and can emit schema-versioned JSON.

The **quality benchmark** ships a dependency-free fixture app with a constrained, realistic task. `init` copies the fixture, installs the agent profile assets, writes the task prompt to disk, and prints it; the agent does the work; `score` evaluates the final directory with deterministic checks — tests pass, typecheck, black-box behavior, the registry still maps touched sources, required docs updated, source boundaries respected, locked fixture files untouched, and forbidden shortcuts absent. The score is a transparent evidence bundle plus a numeric summary; the bundle is the real proof, the number is for a README screenshot.

What it deliberately is not: it never claims Codument always cuts raw tokens (a tiny task spends more on workflow than it saves), never needs network, model, or hosted telemetry, never calls a model to benchmark, never uses an agent or human as the primary judge, and never times wall-clock (too variable across agents and machines).

The **catch-rate benchmark** is the ground-truth proof behind the review gate (see [[review-effectiveness-metric]]). It ships a fixed buggy diff — an agent's "completed" feature branch carrying planted, documented bugs — laid as uncommitted working-tree changes over a committed baseline. The user runs their agent two ways: a *no-loop* run commits the diff as-is, a *loop* run reviews the diff and fixes what it catches. Scoring runs one hidden detector per bug (a test that passes iff that bug is fixed) and reports a catch rate plus the loop-vs-no-loop delta. The load-bearing choice is that the diff is *fixed*, not agent-authored: the planted bugs are reliably present and the score is reproducible. The answer key (the bug manifest and the detectors) lives only in the published package, never in the initialized scenario, and the buggy diff carries no markers naming the planted bugs, so the agent must find them by reviewing the diff rather than read them off the page; `init` lays the baseline as a real git commit so `review` has a base to diff against. The honest boundary on this benchmark: a no-loop baseline is ~0% by construction (no review, no catch), so the comparison is "0% vs X%" — proof that review catches X% that would otherwise ship, not a natural-catch-rate baseline; an agent-implements-the-task variant is a possible later iteration. False-positive rate is out of scope until decoy bugs exist, and a single run is not statistically definitive — the harness scores whatever runs happen and the user can repeat.

## Invariants & boundaries

- `benchmark context` is deterministic and runs with no network and no model: the same package version and fixture always yield the same token and relevance numbers. *(tests: `benchmark.test.ts` "runs the deterministic context benchmark", "scores the context fixture deterministically", "estimates tokens with a stable local heuristic")*
- The context benchmark works from packed package contents, not only the source repo, and emits stable schema-versioned JSON. *(tests: `benchmark.test.ts` "runs the context benchmark from a packed package", "declares benchmark fixtures as packaged files", "prints the context benchmark as stable JSON")*
- `benchmark score` exits success only when every required check passes, and tampering with locked benchmark metadata fails the score. *(tests: `benchmark.test.ts` "scores a completed quality benchmark as passing", "scores an incomplete initialized quality benchmark as failed", "fails quality scoring when locked benchmark metadata changes")*
- The quality score is an evidence bundle, not a single opaque number; the benchmark never calls a model or uses a judge. *(boundary — see ADR 008; enforced by the deterministic-scoring tests above)*
- The catch-rate scorer is deterministic given the final file state (no clock, network, or model; detectors run in an isolated env and a non-completing detector errors rather than counting as a miss): the raw buggy diff scores 0%, a fully fixed solution scores 100%, and a partial fix scores the exact fraction. *(tests: `benchmark-seeded.test.ts` "scores the raw buggy diff as 0% caught", "scores a fully fixed solution as 100% caught", "scores a partial fix as the correct fraction", "is deterministic — scoring twice yields the same result", "ignores ambient NODE_OPTIONS when running detectors"; `classifyDetectorRun` unit cases)*
- Neither the bug manifest, the detectors, nor any naming of which bugs are planted is copied into an initialized scenario, so the agent has to find the bugs by reviewing the diff, not by reading an answer key. *(tests: `benchmark-seeded.test.ts` "never copies the answer key into the scenario", "never reveals which bugs are planted inside the scenario")*
- `init --seeded` lays the feature work as an uncommitted diff over a committed baseline; tampering with the locked scenario identity fails the score and records no comparable result. *(tests: `benchmark-seeded.test.ts` "lays a seeded scenario as an uncommitted feature diff", "fails the score when the locked scenario identity is tampered")*
- A loop run compares only against a baseline directory that was already scored; an unscored baseline is a clear error, not a silent zero. *(tests: `benchmark-seeded.test.ts` "compares a loop run against a no-loop baseline", "errors clearly when a baseline directory was never scored")*

## Decisions

- The benchmark proof model: a deterministic, package-native `benchmark` command family that never uses a judge: [008-benchmark-proof-deterministic-not-judge](../architecture/decisions/008-benchmark-proof-deterministic-not-judge.md).

## Key files

- `src/commands/benchmark.ts` — the `benchmark` command family wiring the `context`, `init <dir>`, and `score <dir>` subcommands.
- `src/lib/benchmark-context.ts` — the deterministic context-routing scorer: naive vs registry-guided selection, the token estimator, and relevance coverage.
- `src/lib/benchmark-quality.ts` — the quality-fixture lifecycle: `init` copies the fixture and writes the task; `score` runs the deterministic final-state checks and the evidence bundle. Also owns the shared scaffolding helpers (target guard, agent-asset install, meta) the seeded benchmark reuses.
- `src/lib/benchmark-seeded.ts` — the catch-rate lifecycle: `init --seeded` lays the buggy diff over a committed baseline; `score` runs the hidden per-bug detectors, reports the catch rate and per-bug breakdown, and compares loop vs no-loop runs.
- `src/lib/detector-result.ts` — the dependency-free rule that turns a detector's process result into caught / survived, and refuses to score a run that did not complete.
