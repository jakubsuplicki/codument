---
title: Core library
status: current
type: concept
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
- One canonical exclusion spec (`DEFAULT_EXCLUSION_SPEC`) is shared by every analyzer, `scan` discovery, AND the editor nudge hook, applied identically to discovery, numerator, denominator, and the live nudge, so coverage, lint, the gate, and the in-editor reminder can never disagree about what counts. The governed families are the module-flavored JS/TS set, Python (`.py`/`.pyi`), Go (`.go`), Rust (`.rs`), and the SFC formats (`.vue`/`.svelte`/`.astro`), with each family's test conventions (`*.test.*`, `test_*.py`/`*_test.py`/`conftest.py`, `*_test.go`) and environment trees (`node_modules`, `.venv`/`venv`, `__pycache__`) outside scope. *(test: `analyze.test.ts` exclusion spec + python conventions)*
- A fingerprint is invariant to cosmetic churn (BOM, CRLF, reformatting, comments) but moves on a real token change, so the gate cannot be cleared by a re-save or a date bump. *(tests: `fingerprint.test.ts` cosmetic-churn; `ts-adapter.test.ts` token-stream reformatting)*
- Side effects are confined to seams: the analyzers never read the clock or the network; git and event-log access live in `git.ts` and `events.ts`. Git access is bounded (a generous subprocess buffer so a large tree's output is never silently truncated), reads git's machine framing so a path outside ASCII is matched byte-exact rather than garbled and dropped, and the change-listing calls raise rather than return empty on failure, so a broken or oversized git invocation fails the gate loud instead of reading "clean." The seam also owns the root-identity assertion the verdict- and score-bearing commands (gate, monitor, health check, report) invoke at startup: a subdirectory working directory is refused loudly, because toplevel-relative git paths can never match a registry keyed below them. *(boundary — per-module invariants live in the owning feature docs)*
- A present-but-unparseable registry is a loud error, never a silent empty default — wherever the content came from, the worktree file or a ref's blob: reads raise rather than return empty, and a write refuses rather than start from empty. No reader proceeds as if the project were unmapped and no writer overwrites a registry it could not first read. *(tests: `registry.test.ts` "fail-loud on a corrupt registry"; `review.test.ts` "a corrupt registry AT THE BASE fails loud")*
- Every state-file write (registry, meta, acks, review and coverage artifacts) goes through the shared atomic writer — a sibling temp file, fsync, then rename over the target — so a crash or a concurrent reader never observes a torn or truncated state file. *(test: `registry.test.ts` "atomic state writes")*

## Decisions

- The registry v2 model these utilities read, with no migration path: [001-registry-v2-model-no-migration](../architecture/decisions/001-registry-v2-model-no-migration.md).
- Determinism and reproducibility as the layer's contract: [003-deterministic-reproducible-gate](../architecture/decisions/003-deterministic-reproducible-gate.md).
- Symbol-grained, derived-first ownership (and the concept-umbrella exception this entry is): [004-symbol-grained-derived-first-ownership](../architecture/decisions/004-symbol-grained-derived-first-ownership.md).

## Key files

Foundation utilities owned here:

- `src/index.ts` — public package barrel; re-exports the registry, analyzer, gate primitives, and agent-profile helpers for programmatic consumers.
- `src/lib/registry.ts` — typed read, write, and single-entry update for the v2 `docs/.registry.json` model every analyzer reads.
- `src/lib/state-io.ts` — the fail-loud state-file primitive: reads config JSON, returning nothing when absent but raising rather than defaulting when present-but-unparseable, so a writer never overwrites what it could not read.
- `src/lib/agent-profiles.ts` — maps the neutral delivery workflow onto agent-specific output (which instruction files, skills, and directories each profile writes) and the ordered core skill list.
- `src/lib/codemod.ts` — the hash-based overwrite/skip/merge strategy behind `codument update`, plus the `.codument-meta.json` round-trip.
- `src/lib/claude-settings.ts` — normalizes `.claude/settings.json` down to one idempotent docs hook without disturbing unrelated hooks.
- `src/lib/detect.ts` — sniffs project language, source directory, and framework from the filesystem and `package.json`.
- `src/lib/markers.ts` — the HTML comment constants that bound the managed instruction section.
- `src/lib/version.ts` — resolves codument's own package root and version in any layout (bundled or not, by package name — never a consumer's manifest); the one root resolver everything test-runner-reachable shares (the version number, the bundled grammar directory), and the source of the scaffold-version skew notice the advisory surfaces print.

Feature modules this umbrella co-documents (behavior lives in the linked feature):

- `src/lib/analyze.ts` — deterministic coverage and lint analyzer and the canonical exclusion spec; its symbol heuristics extract names through the gate's own language adapters and treat a cold adapter as a loud wiring error, never a silently blind reading. ([[registry-health]])
- `src/lib/badge.ts` — no-network static SVG coverage badge renderer. ([[registry-health]])
- `src/lib/change-state.ts` — shared deterministic diff analyzer behind review and watch. ([[change-control-gate]])
- `src/lib/tree-sitter.ts` — lazy bundled-WASM parsing substrate for languages beyond TypeScript, with the grammar-hash manifest the determinism stamp digests. ([[change-control-gate]])
- `src/lib/go-adapter.ts` — precise Go adapter: capitalization rule, receiver-method identity, struct-tag contract calibration. ([[change-control-gate]])
- `src/lib/rust-adapter.ts` — precise Rust adapter: pub-literal rule, trait-qualified impl identities, derive/variant contract calibration. ([[change-control-gate]])
- `src/lib/sfc-adapter.ts` — single-file-component adapter: deterministic block scanner, script delegation to the TS engine, body-grain template/style pseudo-anchors. ([[change-control-gate]])
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
