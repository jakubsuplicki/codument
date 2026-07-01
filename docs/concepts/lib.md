---
title: Core library
status: current
type: concept
owner: ""
primary_sources:
  - src/index.ts
  - src/lib/agent-profiles.ts
  - src/lib/analyze.ts
  - src/lib/badge.ts
  - src/lib/benchmark-context.ts
  - src/lib/benchmark-quality.ts
  - src/lib/benchmark-seeded.ts
  - src/lib/change-state.ts
  - src/lib/claude-feed.ts
  - src/lib/detector-result.ts
  - src/lib/claude-settings.ts
  - src/lib/codemod.ts
  - src/lib/detect.ts
  - src/lib/events.ts
  - src/lib/git.ts
  - src/lib/markers.ts
  - src/lib/emit-producer.ts
  - src/lib/registry.ts
  - src/lib/report-html.ts
  - src/lib/scaffold.ts
  - src/lib/token-cost.ts
  - src/lib/token-report.ts
  - src/lib/verdict.ts
  - src/lib/version.ts
related_sources: []
docs: []
depends_on: []
risk: []
last_reviewed: 2026-07-01
---

# Core library

## In plain terms

The shared foundation layer every command and hook is built on. Nothing here orchestrates a workflow; it provides the deterministic primitives the workflow is made of: registry I/O, the coverage and lint analyzer, the change-control gate engine, project detection, file scaffolding, the install and merge machinery, token accounting, and the watch verdict. The commands stay thin because the reusable logic lives here. This umbrella covers what makes the layer coherent and what each file is for. The behavior of a file that belongs to a feature is documented in that feature's doc, not restated here.

## Design approach

A few principles hold across every module, and they are what make this a layer rather than a folder of helpers.

Determinism is the contract. The analyzers and the gate are pure functions of repo state (filesystem plus git plus registry): no wall clock and no randomness on any scored or gated path, so the same state always yields the same output. Wall-clock time appears only in the live event log, never in a score or a verdict. That is what lets `doctor`, `review`, and `watch` agree, and what makes a coverage figure trustworthy enough to publish.

Side effects are pushed to thin seams. Git access and the event log are isolated so the analyzers stay pure and testable without a repo; the caller wires real git in. Cost is never metered or persisted: producers record raw token counts and a dollar figure is derived at render time, so re-pricing is free and no log can carry a stale number.

The gate is language-agnostic behind an adapter seam. A fingerprint adapter turns file content into a deterministic, cosmetic-churn-proof signature, and adding a language is registering an adapter with no change to the determinism core. Ownership is derived-first: a file in exactly one feature's `primary_sources` owns its symbols with zero authoring, and this `lib` entry is a concept umbrella that co-documents the directory at file grain rather than a per-symbol owner. Coverage and lint stay two separate channels and are never blended into one number.

Each module's behavior, invariants, and decisions live where it is owned. This doc deliberately does not restate them: grep the code for mechanism, and read the owning feature doc for intent.

## Invariants & boundaries

- Every scored or gated path is a pure function of repo state with no wall clock — identical inputs yield identical output. *(tests: `analyze.test.ts` determinism; `change-state.test.ts` "is deterministic")*
- One canonical exclusion spec (`DEFAULT_EXCLUSION_SPEC`) is shared by every analyzer and applied identically to discovery, numerator, and denominator, so coverage, lint, and the gate can never disagree about what counts. *(test: `analyze.test.ts` exclusion spec)*
- A fingerprint is invariant to cosmetic churn (BOM, CRLF, reformatting, comments) but moves on a real token change, so the gate cannot be cleared by a re-save or a date bump. *(tests: `fingerprint.test.ts` cosmetic-churn; `ts-adapter.test.ts` token-stream reformatting)*
- Side effects are confined to seams: the analyzers never read the clock or the network; git and event-log access live in `git.ts` and `events.ts`. *(boundary — per-module invariants live in the owning feature docs)*

## Decisions

- The registry v2 model these utilities read, with no migration path: [001-registry-v2-model-no-migration](../architecture/decisions/001-registry-v2-model-no-migration.md).
- Determinism and reproducibility as the layer's contract: [003-deterministic-reproducible-gate](../architecture/decisions/003-deterministic-reproducible-gate.md).
- Symbol-grained, derived-first ownership (and the concept-umbrella exception this entry is): [004-symbol-grained-derived-first-ownership](../architecture/decisions/004-symbol-grained-derived-first-ownership.md).

## Key files

Foundation utilities owned here:

- `src/index.ts` — public package barrel; re-exports the registry, analyzer, gate primitives, and agent-profile helpers for programmatic consumers.
- `src/lib/registry.ts` — typed read, write, and single-entry update for the v2 `docs/.registry.json` model every analyzer reads.
- `src/lib/agent-profiles.ts` — maps the neutral delivery workflow onto agent-specific output (which instruction files, skills, and directories each profile writes) and the ordered core skill list.
- `src/lib/codemod.ts` — the hash-based overwrite/skip/merge strategy behind `codument update`, plus the `.codument-meta.json` round-trip.
- `src/lib/claude-settings.ts` — normalizes `.claude/settings.json` down to one idempotent docs hook without disturbing unrelated hooks.
- `src/lib/detect.ts` — sniffs project language, source directory, and framework from the filesystem and `package.json`.
- `src/lib/markers.ts` — the HTML comment constants that bound the managed instruction section.
- `src/lib/version.ts` — reads the package version for the CLI and update stamps.

Feature modules this umbrella co-documents (behavior lives in the linked feature):

- `src/lib/analyze.ts` — deterministic coverage and lint analyzer and the canonical exclusion spec. ([[registry-health]])
- `src/lib/badge.ts` — no-network static SVG coverage badge renderer. ([[registry-health]])
- `src/lib/change-state.ts` — shared deterministic diff analyzer behind review and watch. ([[change-control-gate]])
- `src/lib/git.ts` — thin git-native data source: working-tree changes and author, run with `GIT_OPTIONAL_LOCKS=0`. ([[change-control-gate]])
- `src/lib/events.ts` — append-only `.codument/events.jsonl` flow-event log the watch view tails. ([[change-control-gate]])
- `src/lib/report-html.ts` — self-contained HTML review report renderer (verdict, coverage delta, finding cards). ([[change-control-gate]])
- `src/lib/scaffold.ts` — package-root resolution, template copying, and the marker-bounded managed instruction section. ([[project-charter-gate]])
- `src/lib/verdict.ts` — pure classification of a change state into the plain-words watch verdict; cost is shown alongside but never drives severity. ([[complete-cost-capture]])
- `src/lib/benchmark-context.ts` — deterministic context-routing benchmark scorer. ([[proof-benchmarks]])
- `src/lib/benchmark-quality.ts` — quality-fixture init and deterministic final-state scorer. ([[proof-benchmarks]])
- `src/lib/benchmark-seeded.ts` — planted-bug catch-rate init and scorer. ([[proof-benchmarks]])
- `src/lib/detector-result.ts` — pure caught/survived classifier for a detector run. ([[proof-benchmarks]])
- `src/lib/claude-feed.ts` — reads a Claude session transcript into vendor-neutral token events. ([[token-cost-tracking]])
- `src/lib/emit-producer.ts` — producer side of the token protocol: appends a raw-count `tokens` event, never a cost. ([[token-cost-tracking]])
- `src/lib/token-cost.ts` — cost math: an estimated dollar figure derived from a rate table at render time, never persisted. ([[token-cost-tracking]])
- `src/lib/token-report.ts` — pure reducer folding the event stream into per-feature, per-step, and per-model token totals. ([[token-cost-tracking]])
