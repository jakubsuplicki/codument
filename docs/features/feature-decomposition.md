---
title: Feature Decomposition In The Loop
status: approved
type: feature
owner: ""
primary_sources: []
related_sources: []
depends_on:
  - registry-health-and-change-control
  - plan-step-mirroring
  - lib
risk: []
last_updated: 2026-06-22
---

## Summary

A greenfield project built through the Codument loop collapses into **one feature owning all source** (the dogfood plinko build: 1 feature, 6 flat modules, 935 lines). At one feature every Codument signal degrades to a single bit — blast radius is always "1 of 1", "where it went" is binary, docs coverage is one doc — so per-feature attribution, blast, drift, and coverage cannot resolve.

Two verified root causes:

1. The `.claude/rules/documentation.md` rule tells the agent to "*determine the feature name from the file's purpose*". With an umbrella feature already present, the agent lumps every new file into it. work-step lumps because **it has no routing table** it is forced to consult.
2. The only decomposition mechanism, `codument scan`, groups by **top-level `src/` subdirectory** and skips flat files (`_root`). Flat-`src/` greenfield apps (the shape the loop produces) decompose to **zero** features.

The fix turns the decomposition the loop *already articulates in prose* into a first-class, **approvable, machine-readable Feature Map** in the plan doc — **and gives it a deterministic consumer** (a `codument map` command work-step is required to run), so files land in the right feature as they are written, never lumped. This mirrors `plan-step-mirroring`: that feature works because `codument steps --emit` is a deterministic hook the skill *must* run — not because a prose instruction asks nicely.

## Current Decision

**Forward path only.** Make the loop produce correct decomposition for *new* work. Do **not** build auto-heal / `adopt` of already-lumped or imported registries (the user's steer: backward-compat is not a constraint; it's about the future). Existing lumped registries get only the deterministic INFO nudge if they trip it.

**Determinism boundary (hard constraint, verified).** The agent **proposes** the semantic cut (judgment, human-gated at plan approval); the deterministic CLI only **flags shape**, never asserts a cut. `doctor.ts` splits findings: `info` → `notes`, only `warn` counts toward clean — so every shape signal here is `info`, never `warn`. This is load-bearing and preserved everywhere below.

**The Feature Map + its deterministic consumer.** A required fenced block in the plan doc (the source of truth), parsed by a new `src/lib/feature-map.ts`. Columns: `path-or-glob | feature-slug | type (feature|concept) | one-line responsibility`, with an optional `[secondary: a, b]`. Glob matching **reuses** `analyze.ts`'s `globToRegExp` (exported, one globber, no drift); row precedence is **exact-path > longest-literal-prefix glob**, overlap ties are a parse error surfaced as a flag. A new `codument map` command is the consumer: `map route <file> [--plan <doc>]` returns the owning feature(s) as JSON; `map check` emits a flag for an in-scope landed file matching no row, and a plan-time **suspicious-shape** flag (one glob covering all of `src/**`, or a single row when the plan body names N>1 modules). Example for plinko:

```feature-map
src/fairness.ts | fairness    | feature | provably-fair seed/HMAC engine; isolated replacement seam
src/board.ts    | board       | feature | canvas peg/slot render + steered ball-drop animation
src/game.ts     | game        | feature | balance / bet / payout transaction loop
src/payouts.ts  | payouts     | concept | static multiplier tables keyed by (rows, risk)
src/store.ts    | persistence | concept | Store interface + LocalStorageStore seam
src/main.ts     | app-shell   | feature | DOM bootstrap + control wiring  [secondary: game, board]
```

**Materialize lazily and idempotently.** work-step **must run the `codument map` writer** before recording an owned file; it creates a feature's registry entry + doc scaffold the first time the Map's feature key is absent from the registry (order-independent create-or-append, not a stateful one-shot). New entries get status `needs-review` (matching `scan`), so a just-landed entry is not instantly "mature" and does not trip empty-`depends_on`/missing-doc warns before its scaffold is filled.

**Unmapped = the existing lint, not new prose.** An in-scope landed file matching no Map row **is** the existing `unmapped-source` finding (`analyze.ts`, severity `warn`) — that lint already blocks clean, so it is the deterministic anti-lumping backstop. `doctor` is expected clean only **at step boundaries** (after a step's files are all materialized), not mid-step when files 2–6 of a step are written but not yet routed.

**Anti-bloat is the responsibility-seed, not doctor's lints (corrected).** There is **no** thin-doc/empty-layer lint today — `computeBloat` only fires on over-size. So decomposition's bloat guard is: (a) the `concept` channel absorbs leaf utilities without inflating the feature count, and (b) work-step **seeds each materialized doc's `## In plain terms` layer from the Map's already-authored responsibility string**, so scaffolds are non-empty at birth. Optionally a thin `info`-only empty-scaffold finding; we do not claim existing lints police this.

**File-grain resolution graft (forward win, every repo).** The model has only files and features (not "modules"). Add a **file-grain blast** carrier — *files touched of N in-scope files* — to `BlastRadius` (numerator from change-state `changedSources`, denominator from `coverage.inScopeSourceCount`, both already in `watch`'s frame; no feed/schema change). Surface the already-computed `StaleDoc.changedSources` as per-file drift rows. Gives real resolution at low feature counts (which every project hits early), before any re-mapping.

## Non-goals

- **No doc bloat.** Decomposition *partitions* content into focused per-feature docs; it must not *multiply* it. Out: stub-feature proliferation, empty scaffolds (mitigated by the responsibility-seed), and plan↔feature-doc content duplication.
- No auto-heal / re-cut of existing lumped or imported registries.
- No cost-at-module/step grain (token events carry no step/file today; separate feed-rework).
- No import-graph parsing. `depends_on` stays hand-authored (declared once in the Map). Parsed imports are at most a future advisory note.
- No new approval gate — the Map is approved at the existing plan-approval gate.
- The CLI never decides or performs a split; it routes a human-approved Map and flags shape.

## Delivery Plan

Status: approved. Re-ordered to remove a dependency inversion (the consumer/format must exist before the rule routes by it).

- [ ] Step 1: `src/lib/feature-map.ts` — parser + types for the `feature-map` fenced block (rows → primary feature, optional secondaries, type, responsibility). Export `globToRegExp` from `analyze.ts` and reuse it; implement row precedence (exact-path > longest-literal-prefix; ties = surfaced parse error). Red-green-refactor tests: valid blocks, secondary routing, glob precedence/overlap, malformed input.
- [ ] Step 2: `codument map` command (the deterministic consumer) — `map route <file> [--plan <doc>]` → owning feature(s) as JSON; `map check` → unmapped-file flag + plan-time suspicious-shape flag; and an idempotent writer (`updateRegistryEntry` + a shared scaffold seeded from the Map's responsibility string) keyed on "Map feature key not yet present in the registry". Wire into `cli.ts`. Tests against a fixture Map + landed-file set → expected registry entries.
- [ ] Step 3: `skills/plan-with-docs/SKILL.md` — emit the required `feature-map` block derived from the plan's named module responsibilities; teach "each module is a candidate feature; leaf utilities → concept"; render the Map inline in the Approval Summary and run `codument map check` so a suspicious (too-coarse) Map surfaces at the human gate.
- [ ] Step 4: `.claude/rules/documentation.md` — **additive** rewrite: *if an approved Feature Map exists, route via `codument map route`; else keep the legacy purpose-based naming* (do not delete the fallback, so out-of-loop ad-hoc edits with no Map still work). Fix the rule's embedded registry template from legacy flat `sources:[...]` to the v2 shape (`primary_sources`/`related_sources`/`type`/`docs`/`depends_on`/`status`).
- [ ] Step 5: `skills/work-step/SKILL.md` — **require** running the `codument map` route/writer before recording each owned file; route via primary/secondary; materialized entry status = `needs-review`; an unmapped in-scope file is left to surface as the existing `unmapped-source` warn (the backstop), expected clean at step boundaries.
- [ ] Step 6: `src/lib/analyze.ts` + `src/lib/registry.ts` — two `info`-only findings with **numeric, field-grounded** predicates: under-decomposition = exactly one mature `feature`-type entry owning ≥80% of `inScopeSourceCount` with `inScopeSourceCount` ≥ 4 (drop "flat-sibling"; no per-entry directory concept exists); over-decomposition = a mature `feature`-type entry whose sole primary is a barrel/index/types/re-export file (the only mechanically-safe case; the broader "small leaf" case is left to the concept channel + human judgment, and the nudge is **cut** if it cannot pass the negative fixture). Register ids in `LintFindingId`/`FINDING_ORDER` with an exhaustiveness test. Add `cohesive?: boolean` to `RegistryEntry` **and** parse it in `parseEntry`, default-preserve it in `ensureEntryDefaults`, with a round-trip test that normalize→write→normalize and `updateRegistryEntry` do not drop it.
- [ ] Step 7: `src/lib/verdict.ts` (+ change-state) and `src/commands/watch.ts` — add the file-grain field to `BlastRadius`, compute it in `classifyVerdict` from `changedSources`/`inScopeSourceCount`, and when feature count ≤ 1 render file-grain blast + per-file drift (existing `StaleDoc.changedSources`) instead of "1 of 1"; surface the new info notes.

## Acceptance Criteria

- Replaying a flat-`src/` greenfield build (plinko) through the loop yields **multiple coherent features** (~5: fairness, board, game, payouts/concept, persistence/concept, app-shell) — coherent, not ~10 thin one-file features.
- work-step routes a landed file by running `codument map route` (a required, deterministic call — not prose); an **unmapped** in-scope file surfaces as the existing `unmapped-source` warn, not a silent lump.
- The two INFO shape findings fire on their numeric predicates and **provably do not** false-fire on codument's own registry — asserted explicitly against `project-charter-gate`, `hooks`, and `lib` as a committed negative fixture; under-decomposition is muted by `cohesive` (round-trip-tested as persisted).
- Materialized scaffolds are **non-empty at birth** (the `## In plain terms` layer carries the Map's responsibility string); the bloat guard is the responsibility-seed + concept channel, not a claim that doctor's size lint catches empty docs.
- `watch` shows file-grain blast + per-file drift at ≤ 1 feature instead of "1 of 1".
- `cohesive` survives a normalize→write→normalize round trip and an `updateRegistryEntry` touch.

## Verification Strategy

Deterministic unit tests over a fixture (the loop is agent-driven and cannot be unit-tested end-to-end):

1. `feature-map.ts`: parse, secondary routing, glob precedence/overlap, malformed input.
2. `codument map` router + writer: a fixture Map + landed-file set → expected registry entries; idempotent re-run; unmapped file → flag.
3. The two `analyze.ts` findings + the file-grain blast denominator, including the **false-fire guard** against a committed `fixtures/` snapshot of codument's own registry (not the live, moving `docs/.registry.json`).
4. `cohesive` round-trip test (Step 6).
5. Manual dry-run: replay the plinko build through the updated loop; confirm the materialized registry has the coherent feature set and an injected unmapped file flags.

## Open Questions

Resolved into the steps above. Two accepted residual risks to flag at approval:

- **Too-coarse Map at plan time** remains a human-gate dependency: `map check`'s suspicious-shape nudge mitigates but cannot *assert* a cut is wrong (that's the agent's judgment) — the same gate that approved plinko could approve a one-row Map.
- **Over-decomposition may be deterministically uncomputable.** If the barrel/index predicate cannot pass the negative fixture, that nudge is cut entirely and over-decomposition relies on the concept channel + human judgment.
