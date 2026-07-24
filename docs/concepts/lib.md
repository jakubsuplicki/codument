---
title: Core library
status: current
type: concept
last_reviewed: 2026-07-21
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
- One canonical exclusion spec is the shared floor for every analyzer, `scan` discovery, AND the editor nudge hook, applied identically to discovery, numerator, denominator, and the live nudge, so coverage, lint, the gate, and the in-editor reminder can never disagree about what counts. A project widens it (never narrows it) through its own declaration, resolved as described below. The governed families are the module-flavored JS/TS set, Python (`.py`/`.pyi`), Go (`.go`), Rust (`.rs`), C# (`.cs`), the JVM pair Java and Kotlin (`.java`/`.kt`/`.kts`), and the SFC formats (`.vue`/`.svelte`/`.astro`), with each family's test conventions (`*.test.*`, `test_*.py`/`*_test.py`/`conftest.py`, `*_test.go`, the JVM `*Test`/`*Tests`/`*Spec` files and `src/test` source sets) and environment trees (`node_modules`, `.venv`/`venv`, `__pycache__`) outside scope. *(test: `analyze.test.ts` exclusion spec + python conventions)*
- A fingerprint is invariant to cosmetic churn (BOM, CRLF, reformatting, comments) but moves on a real token change, so the gate cannot be cleared by a re-save or a date bump. *(tests: `fingerprint.test.ts` cosmetic-churn; `ts-adapter.test.ts` token-stream reformatting)*
- The git seam answers over a whole workspace, not just one work tree. A tree can contain repositories the outer git cannot see — nested member repos report as a single gitlink, submodules the same — so the seam resolves the members once and aggregates each one's own git answers (tracked, ignored, changed, deleted), prefixed back to workspace-root-relative paths, with a member failure named rather than folded into a partial result. A classic single repo resolves to one member and is byte-identical to the pre-workspace path. The discovery is memoized per root because every git helper wants it and a member walk is a filesystem traversal. *(tests: `git.test.ts` workspace discovery, `repoFor` routing, and aggregation)*
- Side effects are confined to seams: the analyzers never read the clock or the network; git and event-log access live in `git.ts` and `events.ts`. Git access is bounded (a generous subprocess buffer so a large tree's output is never silently truncated), reads git's machine framing so a path outside ASCII is matched byte-exact rather than garbled and dropped, and the change-listing calls raise rather than return empty on failure, so a broken or oversized git invocation fails the gate loud instead of reading "clean." The seam applies the same rule to the path enumerations the *scope* layer reads (the ignore set, the tracked set), which cannot raise because their callers legitimately degrade: each reports either an answer or a reason it has none, so "this repository is unreadable" can never be consumed as "this repository ignores nothing" — the conflation that let a non-repo root score full coverage over build output. Choosing to degrade stays the caller's decision, made explicitly at its own seam. The seam also owns the root-identity assertion the verdict- and score-bearing commands (gate, monitor, health check, report) invoke at startup: a subdirectory working directory is refused loudly, because toplevel-relative git paths can never match a registry keyed below them. *(boundary — per-module invariants live in the owning feature docs)*
- A present-but-unparseable registry is a loud error, never a silent empty default — wherever the content came from, the worktree file or a ref's blob: reads raise rather than return empty, and a write refuses rather than start from empty. No reader proceeds as if the project were unmapped and no writer overwrites a registry it could not first read. *(tests: `registry.test.ts` "fail-loud on a corrupt registry"; `review.test.ts` "a corrupt registry AT THE BASE fails loud")*
- Project-declared scope resolves in one place and is passed down, never re-derived. The layer exposes a single resolution of "what this project counts as documentable" — built-in exclusions widened by the project's own declaration — which every entry point calls once and threads into the pure helpers. The helpers keep their default parameter so a library caller that does not care about project config is unaffected, and the returned spec never shares an array with the built-in default, so one caller's edit cannot rewrite the scope for the rest of the process. Detection reads it too: a build tree the project declared cannot be what codument sniffs a language or framework off. The resolution carries the declaration itself alongside the merged spec, so a surface that both applies the scope and reports it reads the file once. *(tests: `analyze.test.ts` "resolveExclusionSpec widens the defaults, never narrows them" — including the aliasing and caller-mutation cases; the per-command declared-scope suites)*
- Every directory walk reports what it could not read, so a partial answer is never presented as a complete one. The filesystem half of the scope follows the same unknown-is-not-empty rule the git half does: a directory the walk cannot open rides the result alongside what it found, rather than vanishing into a shorter list. This holds for all three trees — source discovery, the docs knowledge base, and workspace member discovery — because fixing one walker and leaving its siblings silent is the per-caller patch this layer's own rule forbids. Absent is not unreadable, and only the second is disclosed. It travels as a returned field rather than an injected callback on purpose — a caller can drop a field it can see in the type, but it cannot forget to pass one, which is how the ignore predicate went missing from the lint. *(test: `analyze.test.ts` "an unreadable directory is reported, never silently skipped")*
- "A test file" has exactly one definition, and the exclusion spec is composed from it rather than repeating it. Two surfaces ask the question — the spec excludes tests from the coverage scope, and the prose-altitude heuristic exempts a cited test path from its file-enumeration count — and a second copy is how they would drift into disagreeing about the same file. Every language family's convention is pinned through the exported predicate itself, not through a surface that happens to call it. *(test: `analyze.test.ts` "one definition of a test file, and the spec is composed from it" — every convention present in the spec, no shared array identity, each family's convention recognized and its near-misses refused)*
- A config value that parses but says something invalid is refused by name, not ignored. Reading project metadata rejects a malformed exclusion block — an unknown key, a non-string entry, an empty entry, or a path where a bare directory name belongs — with an error naming the offending value and the file to edit, because a typo that silently no-ops is indistinguishable from a working setting and reproduces the whole class of scope bugs the exclusion config exists to fix. Validation happens on read rather than at the point of use, so whichever command the user runs next is the one that reports it. *(tests: `codemod.test.ts` "an exclude block is validated on read, never silently ignored")*
- Every state-file write (registry, meta, acks, review and coverage artifacts) goes through the shared atomic writer — a sibling temp file, fsync, then rename over the target — so a crash or a concurrent reader never observes a torn or truncated state file. *(test: `registry.test.ts` "atomic state writes")*

## Decisions

- The registry v2 model these utilities read, with no migration path: [001-registry-v2-model-no-migration](../architecture/decisions/001-registry-v2-model-no-migration.md).
- Determinism and reproducibility as the layer's contract: [003-deterministic-reproducible-gate](../architecture/decisions/003-deterministic-reproducible-gate.md).
- Symbol-grained, derived-first ownership (and the concept-umbrella exception this entry is): [004-symbol-grained-derived-first-ownership](../architecture/decisions/004-symbol-grained-derived-first-ownership.md).

## Key files

Foundation utilities owned here:

- `src/index.ts` — public package barrel; re-exports the registry, analyzer, gate primitives, agent-profile helpers, and the language-support manifest (`LANGUAGE_MATRIX`) for programmatic consumers — external surfaces render support claims against the installed release, never a hand-copied list.
- `src/lib/registry.ts` — typed read, write, and single-entry update for the v2 `docs/.registry.json` model every analyzer reads.
- `src/lib/state-io.ts` — the fail-loud state-file primitives: reads config JSON, returning nothing when absent but raising rather than defaulting when present-but-unparseable, so a writer never overwrites what it could not read; and the sibling error for a file that parses but carries an invalid value, kept distinct because a corrupt file and a typo'd setting need different things from the user.
- `src/lib/agent-profiles.ts` — maps the neutral delivery workflow onto agent-specific output (which instruction files, skills, and directories each profile writes) and the ordered core skill list.
- `src/lib/codemod.ts` — the hash-based overwrite/skip/merge strategy behind `codument update`, plus the `.codument-meta.json` round-trip and the semantic validation of the project-declared settings it carries.
- `src/lib/claude-settings.ts` — normalizes `.claude/settings.json` down to one idempotent docs hook without disturbing unrelated hooks.
- `src/lib/detect.ts` — sniffs project language, source directory, and framework from the filesystem and `package.json`.
- `src/lib/markers.ts` — the HTML comment constants that bound the managed instruction section.
- `src/lib/version.ts` — resolves codument's own package root and version in any layout (bundled or not, by package name — never a consumer's manifest); the one root resolver everything test-runner-reachable shares (the version number, the bundled grammar directory), and the source of the scaffold-version skew notice the advisory surfaces print.

Feature modules this umbrella co-documents (behavior lives in the linked feature):

- `src/lib/exclusion-spec.ts` — the canonical exclusion spec and its matchers, plus the one definition of "a test file" that the spec itself is composed from. A leaf module so the git seam can prune its member walk on the same directory list the analyzers score by, without importing the analyzer.
- `src/lib/analyze.ts` — deterministic coverage and lint analyzer over that spec; its symbol heuristics extract names through the gate's own language adapters and treat a cold adapter as a loud wiring error, never a silently blind reading. ([[registry-health]])
- `src/lib/badge.ts` — no-network static SVG coverage badge renderer. ([[registry-health]])
- `src/lib/change-state.ts` — shared deterministic diff analyzer behind review and watch. ([[change-control-gate]])
- `src/lib/tree-sitter.ts` — lazy bundled-WASM parsing substrate for languages beyond TypeScript, with the grammar-hash manifest the determinism stamp digests. ([[change-control-gate]])
- `src/lib/go-adapter.ts` — precise Go adapter: capitalization rule, receiver-method identity, struct-tag contract calibration. ([[change-control-gate]])
- `src/lib/rust-adapter.ts` — precise Rust adapter: pub-literal rule, trait-qualified impl identities, derive/variant contract calibration. ([[change-control-gate]])
- `src/lib/csharp-adapter.ts` — precise C# adapter: member-grain anchors under type chains, partial folding, accessor/record calibration. ([[change-control-gate]])
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
