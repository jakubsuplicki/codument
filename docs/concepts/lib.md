---
title: Core library
status: current
type: concept
last_reviewed: 2026-09-10
---

# Core library

## In plain terms

The shared foundation keeps commands and hooks consistent: ownership, analysis, installation,
change control and token accounting reuse the same rules. This page owns the layer's boundaries;
individual feature docs own their behavior.

## Design approach

Deterministic analysis sits behind thin filesystem, Git and event seams. Coverage and lint remain
separate signals. Producers retain raw token counts; estimated cost is derived when displayed, so
rates can change without rewriting history. Language adapters supply cosmetic-stable fingerprints
without adding language decisions to the gate's core.

Ownership is derived from an unambiguous feature's primary sources. This concept co-documents the
library at file grain; it does not compete for symbol ownership. Read the owning feature for intent
and source for mechanism. Programmatic consumers can read the installed release's language-support
manifest rather than copy a support list. Specialized parsing, verdict and benchmark contracts live
in [[change-control-gate]], [[complete-cost-capture]] and [[proof-benchmarks]] respectively; token
producer and pricing contracts live in [[token-cost-tracking]].

Package version and bundled grammar assets resolve from Codument's own named package in bundled
and unbundled layouts, never from a consumer's manifest. The same resolution serves the version
and grammar consumers.

Snapshot consumers use selected source, policy and documentation throughout. Staged delivery and
complete branch review through the index retain distinct boundaries. Portable review and final
approval share a strictly validated manifest exclusion but remain separate authorities; see
[[adversarial-review-gate]] and [[plan-approval]].

Installed instructions preserve one delivery discipline across hosts: stage the slice, review and
verify it, then commit those bytes. Permission, interruption, readiness and delivered work remain
separate. Tracked approval survives final compaction; local recovery context supplies no authority.
Control records have bounded reads, atomic writes and exclusive revision-checked transitions.

Telemetry readers retain valid events alongside explicit empty, partial or unavailable input state.
Existing event-only consumers keep their compatibility view; capture-aware consumers can disclose
what that view could not read. [[token-cost-tracking]] owns availability and summary privacy.

## Invariants & boundaries

- Explicit repository views keep history refs, registry and blob reads together, including roots with nested members. The view is isolated across concurrent calls and restored after failure; normal workspace discovery and caches retain their meaning. *(test: `history-audit-selection.test.ts`)*

- Event producers and feed rebuilds share an exclusive local transaction; concurrent capture cannot inflate usage, and rebuilding one host preserves other hosts and manual events. Captured identity anchors replay across cursor loss; writer conflicts and incomplete ledgers remain visible. *(test: `codex-feed.test.ts`)*

- Workflow skill mirrors preserve handoffs, and reports display saved interruptions. Host compliance remains untested. *(tests: `agent-profiles.test.ts`, `work.test.ts`)*
- Approval writers refuse an existing lock or stale revision and preserve the last valid record. *(test: `plan-approval.test.ts`)*
- Scored and gated results depend on repository state, never wall clock or randomness; identical inputs produce identical output. *(tests: `analyze.test.ts`, `change-state.test.ts`)*
- Every presentation carries the shared change facts and blocking findings, including gate, monitor, report and machine views. Adding an analyzer finding includes its projections. *(boundary: per-surface enforcement in [[change-control-gate]])*
- Discovery, coverage numerator and denominator, lint, change control and editor reminders share one additive exclusion floor. Governed families include module-flavored JS/TS, Python including stubs, Go, Rust, C#, Java/Kotlin and Vue/Svelte/Astro; JS/TS declaration artifacts, language-defined tests and environment trees stay excluded. *(test: `analyze.test.ts`)*
- Fingerprints ignore BOM, line endings, formatting and comments but change with real tokens; re-saving or changing a date cannot clear drift. *(tests: `fingerprint.test.ts`, `ts-adapter.test.ts`)*
- Workspace Git answers aggregate each member's own tracked, ignored, changed, deleted and moved paths with workspace-relative prefixes and named member failures. Moves require the origin to be gone, excluding copies and splits with surviving origins; all base readers share that origin mapping. A single repository preserves ordinary results, and discovery is reused per root. *(test: `git.test.ts`)*
- The index uses the same member routing and exact Git content identities. Filesystem/index overlap on a selected path is refused before analysis; Git resolves receipt locations correctly for linked worktrees. *(tests: `change-set.test.ts`, `verify.test.ts`)*
- Snapshot-bound consumers read approval, exclusion policy, base text and doc pointers from the selected snapshot, never concurrent worktree content. Pure seams accept those selected inputs. *(tests: `change-state.test.ts`, `review-boundary.test.ts`)*
- Analysis has no clock or network side effects. Git reads preserve machine-framed Unicode paths and refuse truncated or failed change listings. Scope enumerations return an answer or a named unknown so degradation is an explicit caller decision. Verdict and score commands refuse a repository subdirectory whose paths cannot match the registry. *(boundary: enforcement in owning feature docs)*
- An unreadable or corrupt existing registry is a loud refusal, whether read from the worktree or a historical blob; it never becomes an empty default or gets overwritten from one. *(tests: `registry.test.ts`, `review.test.ts`)*
- Project exclusions resolve once and only widen defaults; declaration and resolved scope travel together through detection and other consumers. Library defaults remain available, and returned arrays cannot mutate shared defaults. *(test: `analyze.test.ts`; command coverage in owning docs)*
- Source, documentation and workspace walks return unreadable directories alongside valid results. Missing directories are not unreadable, and partial discovery is never presented as complete. *(test: `analyze.test.ts`)*
- Exclusions and prose citation exemptions share one definition of a test file. Directory conventions are anchored where the language applies them; generic domain directories remain governed. Nested Cargo member helpers outside the root convention require explicit project exclusions. *(test: `analyze.test.ts`)*
- Invalid semantic metadata is refused by name on read, including malformed exclusions. Optional runner declarations are instead validated where consumed so their errors cannot break unrelated commands; fallback always discloses the refusal. *(tests: `codemod.test.ts`, `review-confirm.test.ts`)*
- Stored registry paths normalize across authoring platforms; input paths preserve the running platform's meaning, including literal POSIX backslashes. Shared matching strips leading slash and dot-slash forms consistently across callers. *(tests: `registry.test.ts`, `context-pack.test.ts`)*
- State writes share atomic replacement with a synced sibling temporary file, preventing readers or crashes from observing torn registry, metadata, acknowledgment, review or coverage records. *(test: `registry.test.ts`)*

## Decisions

- Registry representation: [001-registry-v2-model-no-migration](../architecture/decisions/001-registry-v2-model-no-migration.md).
- Reproducible analysis: [003-deterministic-reproducible-gate](../architecture/decisions/003-deterministic-reproducible-gate.md).
- Derived ownership and concept umbrellas: [004-symbol-grained-derived-first-ownership](../architecture/decisions/004-symbol-grained-derived-first-ownership.md).

## Key files

- `src/lib/registry.ts` — shared ownership and registry boundary.
- `src/lib/git.ts` — repository identity, snapshots and workspace routing.
- `src/lib/change-state.ts` — shared change analysis; [[change-control-gate]] owns its contract.
- `src/lib/analyze.ts` — documentation health analysis; [[registry-health]] owns its contract.
- `src/lib/scaffold.ts` — managed installation surfaces; [[commands]] owns lifecycle behavior.
