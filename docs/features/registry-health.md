---
title: Registry health
status: current
type: feature
last_reviewed: 2026-09-10
---

# Registry health

## In plain terms

`codument doctor` exposes gaps between source, registry and documentation. It reports coverage
separately from integrity and readability findings. The result is local, repeatable evidence about
what may be missing or stale; it does not certify good prose or correct software.

## Design approach

Coverage measures registry membership and dependency declarations. Lint names discrete problems
such as stale ownership, broken links and documentation that mirrors code. Combining them would
make one number answer incompatible questions, so they remain separate.

Scope is part of every coverage claim. All consumers share built-in language and test conventions,
Git ignore rules where available, and the project's additive exclusions. Projects can widen the
exclusions but cannot replace their floor or configure new supported languages. Configuration is a
reviewable repository artifact rather than a per-run scope switch. Language-defined directory
conventions are anchored; ordinary domain code under a generic test-like name stays governed.

The headline averages only applicable ratios. Foundation entries need no outgoing dependencies;
isolated entries may indicate missing wiring. Scores use repository state, never elapsed time.
Missing scope evidence is disclosed beside the score rather than converted into confidence.

Bare health reporting is advisory. `--strict` gates actionable findings introduced by the working
change; inherited debt remains visible. Explicit invariant execution asks a broader whole-repository
question and retains its own runner limitations. Mechanical repair removes only ownership claims
already contradicted by project facts, leaving decisions to the author.

A badge represents coverage, with no meaningful absolute comparison across projects. It must be
backtested against real history before public exposure and renders locally without a network or
required dependency. [[change-control-gate]] owns change readiness; [[doc-audience-layers]] owns the
writing standard. Neither a high score nor a clean diff substitutes for knowledge quality.

## Invariants & boundaries

- With invariant execution off, identical repository inputs produce identical reports and scores regardless of traversal order, run or wall clock; no network or AI model is used. *(tests: `analyze.test.ts`, `doctor.test.ts`)*
- Excluded generated or test paths contribute to neither coverage numerator nor denominator, even when registered as sources. *(test: `analyze.test.ts`)*
- Coverage, lint, gate, audit, scan, detection and editor reminders share exclusions resolved from built-ins plus project additions. Selected-snapshot configuration is supported; absent declarations preserve defaults, extensions are not configurable, and returned arrays do not alias defaults. *(tests: `analyze.test.ts`, `review-boundary.test.ts`, `scan.test.ts`, `doctor.test.ts`, `review.test.ts`, `hooks.test.ts`)*
- A workspace headline names its member repositories, and JSON carries that aggregate scope. *(test: `workspace-refusals.test.ts`; ADR-016)*
- Unreadable source, doc and workspace directories are returned with valid discoveries and disclosed together in human and JSON output. Missing directories are not unreadable; discovery failures cannot silently shrink the denominator. *(tests: `analyze.test.ts`, `doctor.test.ts`, `scan.test.ts`, `git.test.ts`)*
- Declared exclusions appear beside the score and in JSON; scan names them too. An undeclared scope adds no notice. *(tests: `doctor.test.ts`, `scan.test.ts`)*
- Semantically invalid exclusion declarations refuse the run by name. Unreadable or unparseable metadata falls back to built-ins with an explicit scope caveat in human and JSON output; advisory callers do not silently treat unknown configuration as absent. *(tests: `analyze.test.ts`, `doctor.test.ts`, `hooks.test.ts`)*
- Unavailable Git ignore evidence produces a named scope caveat beside the score and in JSON. It is disclosure, not a warning or exit-code input; a clean lint alone cannot establish verified scope. *(test: `doctor.test.ts`)*
- Generated leakage checks Git ignores first, then declared and built-in exclusions, naming the actual rule. Authoring refusals share that attribution. Unknown ignore rules never produce an invented Git claim. *(test: `analyze.test.ts`)*
- Health notes include control-plane problems the delivery loop needs to see, including dead acknowledgments; filesystem-dependent evidence stays outside pure analysis. Explicit repair also sweeps dead acknowledgments. *(test: `doctor.test.ts`; lifecycle in [[change-control-gate]])*
- Human notes group only exact repeated messages after removing their subject. Every subject remains visible without truncation, lone messages retain their subject, and groups preserve first-arrival order. JSON remains per-subject and unchanged. *(test: `doctor.test.ts`)*
- Lint, including bloat, never changes the coverage score. *(tests: `analyze.test.ts`, `doctor.test.ts`)*
- The headline equally averages non-empty ratios; zero denominators are omitted, and an all-inapplicable repository yields a null score. *(test: `analyze.test.ts`)*
- Freshness windows are commit-count based, never wall-clock based. The health freshness/drift ratio remains N/A until sourced from the change-control gate. *(honest boundary: structural, untested)*
- `--strict` fails on actionable warnings attributed to this working change, never inherited debt or informational notes. If attribution is unavailable it considers all warnings. Explicit invariant execution remains whole-repository and fails strict mode on broken or unpinned invariants. *(test: `doctor.test.ts`)*
- `--verify-invariants` runs each cited test file once through the project runner and reports green, broken, unpinned, unrunnable, untested or honest boundaries. Any parenthetical test citation counts, including prose citations; trailing asides do not hide it. The honesty ratio excludes unrunnable and deliberate non-testable boundaries. Bare output and JSON have no invariant block. TAP evidence is required to classify a red test as broken; a non-TAP failure remains unrunnable, so reporter gaps must be disclosed. Runner refusal and undecidable counts appear in human and JSON output; timeouts are named separately and point to the clock. Project command/timeout declarations and per-run overrides share the review gate's resolution and diagnostics. *(tests: `adversarial-review-testcommand-parity.test.ts`, `invariant-check.test.ts`, `doctor.test.ts`, `review-confirm.test.ts`)*
- A Git subdirectory is refused with both roots named and a discriminated JSON error; a genuine repository root or standalone non-Git directory still scores. *(test: `doctor.test.ts`)*
- A badge shows N/A when no ratio applies, never a misleading zero. *(test: `badge.test.ts`)*
- A scaffold version older than the running package produces one human-only advisory naming both versions and the update remedy; a downgrade produces no notice. Corrupt metadata produces a repair pointer; neither affects findings, JSON or exit status. *(test: `doctor.test.ts`)*
- Human output explicitly identifies coverage as registry membership and dependencies, not quality. *(honest boundary: output disclaimer; no semantic test)*
- Reported gate languages use the same support manifest parity-tested against the README and registered adapters. *(test: `language-matrix.test.ts`)*
- Path enumeration counts distinct non-test paths. Built-in test citations are exempt anywhere in prose, while line anchors still apply to tests. Project-only test exclusions do not extend this exemption; literal JVM test source sets are exempt across languages. *(test: `prose-altitude.test.ts`)*
- Registered-doc altitude checks are deterministic, lexical and informational: exported-symbol prose mirrors, file line anchors, and path lists or role-less Key files entries. They never gate strict mode; warning promotion requires separate false-fire evidence. They use the gate's language adapters, with required grammar initialization; malformed source may yield no symbols, but wiring failures cannot silently erase a language's reading. *(tests: `prose-altitude.test.ts`, `doctor.test.ts`)*
- Fenced mirrors name declarations of owned symbols, not usage calls. Named shapes qualify directly; value declarations need an export marker. Each fence produces at most one informational finding at its first declaration, including an unclosed fence; unrelated names, output and configuration examples stay silent. *(test: `prose-altitude.test.ts`)*
- New-versus-inherited attribution is derived from each finding's own subject file in the working change, never a feature-wide rule or stored baseline. Subjectless findings stay inherited. Non-repositories have no attribution split, not an empty one. *(test: `doctor.test.ts`)*
- `doctor --fix` only removes source claims contradicted by missing paths, unmatched patterns, Git ignores or explicit project exclusions. Built-in heuristics, new ownership, manifest routing and doc edits require judgment and remain untouched. Fixability follows each finding's evidence; remaining kinds are always named, and the report reflects the post-fix state. Repeating repair is harmless. *(tests: `doctor.test.ts`, `analyze.test.ts`)*
- Owned dependency manifests are named with an impact-only alternative, never rewritten automatically: changing ownership changes what wakes. The ecosystem name list is explicit, real source is not guessed to be packaging, and deliberately retained ownership remains possible. *(test: `analyze.test.ts`)*
- Tree registrations own matching in-scope files like literal registrations. Unmatched patterns inspect their own literal-prefix tree, including content outside source coverage. A literal claim shadowed by its own entry's tree is named in either source field; another entry's refinement stays valid. Out-of-scope content never enters the coverage denominator merely because it is governed. *(test: `analyze.test.ts`)*
- A fully checked delivery checklist is named for author-led compaction, never rewritten automatically. Any unfinished step keeps the doc in flight; compacted docs stay silent. *(test: `analyze.test.ts`)*
- All document parsers treat CRLF and LF identically, including section-scoped lint, bloat, invariant extraction, review and plan scope. An unsourced Decisions layer receives one informational finding; any link, wiki-link, numbered ADR or test citation in that section suffices, and empty layers are exempt. *(tests: `prose-altitude.test.ts`, `crlf-parity.test.ts`)*
- Empty-dependency findings may include import-derived edges as a partial floor, never a complete dependency claim or registry write. Unowned, self or nonexistent targets are dropped; when nothing is derivable the original wording and JSON remain unchanged. *(test: `analyze.test.ts`)*
- A foundation with inward edges and no outgoing dependencies is excluded from the dependency denominator and empty-dependency findings; an isolated entry remains suspicious. *(test: `analyze.test.ts`)*
- In-flight `needs-review` entries are exempt from empty-dependency findings and the dependency ratio; a reviewed leaf may explicitly confirm no dependencies. Mature isolated unconfirmed entries still warn. Scaffolds remaining after source counts move beyond the recorded scan are disclosed beside the score, never scored or gated; fresh scan parity stays quiet and unavailable scan metadata stays unknown. *(tests: `analyze.test.ts`, `scan.test.ts`, `doctor.test.ts`)*
- A current doc without narrated orientation receives a thin-doc information note; draft and needs-review scaffolds are exempt. *(test: `analyze.test.ts`)*
- Dangling local links and wiki-links anywhere under docs warn; valid/external links and fenced examples are ignored. Only file existence is checked, not anchors. *(test: `analyze.test.ts`)*
- Dependency edges naming no registry entry warn and point to registering the missing target or correcting its slug. *(test: `analyze.test.ts`)*
- Every primary-owned file no adapter reads and no owner risk protects is named with the declaration that restores blocking. This is informational; excluded and impact-only files are absent, and declared risk silences it. *(test: `analyze.test.ts`)*
- Feature/concept pages absent from every registry primary or supporting doc list are informational orphans. Deliberately unowned pages are legitimate; pages outside those trees are exempt. *(test: `analyze.test.ts`)*

## Decisions

- Deferred: clearer ownership debt alongside aggregate health and compaction of overloaded pages at their owners. A clean diff gate does not certify repository-wide ownership. Context budgets retain selected contracts; changing that policy requires a separate decision. Private source retention and exclusions remain explicit adopting-project choices. See [[context-pack]] and [[change-control-gate]].
- Registry representation: [001-registry-v2-model-no-migration](../architecture/decisions/001-registry-v2-model-no-migration.md).
- Separate coverage and lint with opt-in gating: [002-doctor-is-documentation-coverage](../architecture/decisions/002-doctor-is-documentation-coverage.md).
- Tree ownership: [018-a-registry-entry-can-govern-a-tree](../architecture/decisions/018-a-registry-entry-can-govern-a-tree.md).

## Key files

- `src/commands/doctor.ts` — health reporting and opt-in repair, strict gating and invariant execution.
- `src/lib/analyze.ts` — shared deterministic coverage and integrity analysis.
- `src/lib/badge.ts` — local coverage badge rendering.
- `src/lib/prose-altitude.ts` — documentation altitude heuristics.
- `src/lib/invariant-check.ts` — cited-test evidence for documented invariants.
