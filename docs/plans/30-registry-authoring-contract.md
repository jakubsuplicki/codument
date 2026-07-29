---
status: approved
---

# Plan 30: the authoring path obeys the registry contract

A throwaway project (`~/Projects/demos/demo-1`) built end to end by an agent following codument's own
scaffolded loop produced a registry that codument's own `doctor` rejects. Seven warn findings across
four entries, and **every one of them is correct** — the registry really is wrong:

```
⚠ generated-leakage money: out-of-scope file listed as source ... src/money.test.js
⚠ generated-leakage settlement: ...                                src/settlement.test.js
⚠ generated-leakage trip-persistence: ...                          src/storage.test.js
⚠ empty-depends-on  expense-splitter · money · settlement · trip-persistence
```

The lint is not the defect. The defect is that codument's own loop authored the thing its own lint
flags, twice over, in cases where a surface already held the answer and did not use it.

**1. The exclusion spec governs what codument reads, never what it writes.** `isExcluded` is
consulted by `analyze.ts`, `change-state.ts`, and `review.ts` — every read path. Nothing that *writes*
a registry entry consults it: `feature-map.ts`, `commands/map.ts`, and `scaffold.ts` hold zero
references. The contract is already settled and unambiguous in [registry-health](../features/registry-health.md):
the built-in spec removes "generated, build, and test files (test suites and fixture trees alike)",
and configuration is additive-only precisely so that "no project can quietly re-admit test files".
There is therefore **no legitimate case** for a test file in `primary_sources` — and no guard against
writing one. The agent that wrote three of them was following `rules/documentation.md`, which
describes hand-authoring an entry and never states the contract it must satisfy.

**2. `depends_on` is nagged for, never derived.** `src/lib/import-graph.ts` exports
`harvestImports`, `importedFiles`, and `resolveSpecifier` — pure first-party resolution — and is
exported from the public barrel with **no internal consumer**. Meanwhile `empty-depends-on` fired on
all four demo-1 entries, whose real edges are plain in the source: `app.js` imports `money.js`,
`settlement.js`, and `storage.js`; `settlement.js` imports `money.js`; `storage.js` imports
`settlement.js`. Deriving those edges clears all four findings — two entries gain dependencies, and
`money` and `trip-persistence` gain inward edges that make them foundations, which the existing
foundation rule already exempts.

## Why

- A tool whose own loop produces output its own lint rejects is teaching the user that the lint is
  noise. That is the exact failure ADR-002's honest-signal framing exists to prevent: findings the
  user learns to scroll past are worse than no findings, because they discredit the true ones beside
  them.
- Both fixes are *reuse*, not new machinery. The exclusion predicate and the import graph both exist,
  are both tested, and are both already resolved from one place. Neither item adds a concept to the
  product; each connects a surface to an answer the codebase already computes.
- The `empty-depends-on` nag currently asks the user to hand-maintain a graph codument can read.
  Every hand-maintained derivative drifts, and the registry's dependency edges are load-bearing —
  change review fans impact out along them.

## Scope

- `src/lib/registry.ts` — the write seam only (see Decisions: the read path must keep tolerating a
  bad registry, or the lint could never report it)
- `src/lib/feature-map.ts`, `src/commands/map.ts` — `map materialize` refuses an excluded path by
  name, pointing at the rule that fired
- `rules/documentation.md` and the registry-entry template it carries — state the exclusion contract
  at the point of authoring
- `src/lib/import-graph.ts` — gains its first internal consumer (no signature change expected)
- `src/lib/analyze.ts` — `empty-depends-on` carries derived edges as evidence
- `tests/analyze.test.ts`, `tests/registry.test.ts`, `tests/map.test.ts`
- `docs/features/registry-health.md`, `docs/features/feature-decomposition.md`, `CHANGELOG.md`

No new source files, so no `map materialize` needed. Independent of plans 26–29.

## Non-goals

- **No auto-writing of `depends_on`.** Phase B reports derived edges as evidence; it does not edit
  the registry. Writing follows only once the derivation has soaked, matching how `prose-altitude`
  shipped info-only pending a false-fire soak.
- No change to the exclusion spec itself, its additive-only constraint, or the extension list.
- No new escape hatch for documenting a test file. The additive-only spec deliberately forbids one,
  and an invariant already links its enforcing test *in prose* — which is the sanctioned way to point
  a doc at a test, and needs no registry mapping.
- No change to the foundation exemption, the scaffold exemption, or `depends_on_confirmed`.
- No cross-language import resolution beyond what `import-graph.ts` already does.

## Decisions (settled)

- **The guard lives on the write path, not in `normalizeEntry`.** Read and write share
  normalization, and a guard there would make an existing bad registry unreadable — so `doctor`
  could never report the finding it exists to report. Reading stays tolerant; authoring gets strict.
  This is the same split the tool already draws between reporting a bad state and producing one.
- **Refuse, do not silently strip.** A dropped source is invisible in the diff, and the user is
  left believing a file is documented when it is not. `map materialize` errors and names the rule,
  consistent with "a declaration that cannot be understood stops the run".
- **Derived edges are evidence attached to the existing finding, not a new finding id.** The user's
  question when they see `empty-depends-on` is "which ones?" — answering it in place is strictly
  better than a second line to correlate. Soak data for the existing id stays comparable.
- **A derived edge that resolves to no registry entry is dropped, not reported.** That case is
  already covered by the `dangling` lint from the other direction, and surfacing an import of an
  unregistered file here would duplicate the unmapped-source signal `review` owns.
- **Derived edges are a floor, not the dependency set.** Import resolution finds only the edges that
  happen to be expressible as an import; runtime coupling, a shared data shape, and CLI orchestration
  all produce real dependencies with no import between the files. Because review fans impact along
  these edges, a graph the user believes is complete is worse than one that still nags — the user
  who accepts a partial set stops looking, and the missing edge fails silently at the moment it
  matters. So the evidence is worded as the edges codument *could derive*, never as the feature's
  dependencies, and accepting them does not discharge the obligation to add the rest.
- **End-to-end coverage is a self-contained fixture, not a rebuild of the field project.** Per-seam
  tests leave author → refuse → lint → derive unexercised as a whole, but reproducing the external
  throwaway project would tie the suite to something no CI host has. A fixture inside `tests/`
  closes the integration gap and stays runnable anywhere.

## Delivery Plan — registry authoring contract (2026-07-28, rev. 2026-07-29)

Status: approved 2026-07-29 — end-to-end coverage settled as a self-contained fixture (Step 7).

- [x] Step 1: State the contract where entries are authored — `rules/documentation.md` and its
      registry-entry template say that generated, build, and test files are never `primary_sources`,
      and that an invariant links its enforcing test in prose instead. Verify a scaffolded project
      carries the updated text.
- [x] Step 2: Guard the write seam in `registry.ts` against a source the resolved exclusion spec
      covers, leaving the read path tolerant. Pin both halves: authoring refuses, and an existing
      bad registry still loads so `doctor` can lint it.
- [x] Step 3: `codument map materialize` refuses an excluded path, naming which rule fired
      (built-in heuristic vs the project's own declaration), reusing `declaredRuleFor`'s wording
      split so the two call for the responses they already call for elsewhere.
- [x] Step 4: Derive first-party dependency edges from the import graph — registry entries plus
      `importedFiles` resolved through `primary_sources` ownership — as a pure, tested function.
- [x] Step 5: `empty-depends-on` carries the derived edges as evidence, info-only, with no change to
      when the finding fires or to the exit code. The wording presents them as the edges codument
      could derive — a floor the user extends, never the feature's dependency set.
- [x] Step 6: Update `registry-health.md` and `feature-decomposition.md` at intent altitude and add
      the CHANGELOG entry.
- [ ] Step 7: A self-contained fixture under `tests/` walks the guarded path end to end on one
      registry — an excluded test file refused at authoring time, and a two-hop import chain whose
      edges derive — with no reference to any project outside this repo.

## Outcome

An agent following the scaffolded loop can no longer author a registry entry that codument's own
lint rejects: the authoring surfaces refuse what the contract forbids, and say which rule forbade it.
Where the registry is merely incomplete rather than wrong, `doctor` answers its own question — a
missing `depends_on` arrives with the edges codument already resolved from the imports, instead of a
nag to go and find them.

What it deliberately does not do: it does not make `depends_on` correct. The derivation reports a
floor — the import-expressible subset — and never writes it, so a feature whose real coupling is at
runtime still needs a human edge, and `empty-depends-on` still fires until one is added.

## Acceptance criteria

- A registry entry naming a test file is refused at authoring time, by both `map materialize` and the
  write seam, with a message naming the rule that fired.
- An existing registry that already names a test file still loads, and `doctor` still reports
  `generated-leakage` on it — the lint's reporting power is unchanged.
- An entry whose sources import another entry's sources gains that edge in the derivation, and
  `empty-depends-on` reports it as evidence. An entry whose only real coupling is non-import reports
  an empty derivation and keeps nagging — the derivation never fabricates an edge to clear a finding.
- The `empty-depends-on` wording, read cold, does not let a user conclude the derived set is the
  feature's dependencies.
- Bare `doctor` exit codes and `--json` shape are unchanged for a project with no derived edges.
- `import-graph.ts` has an internal consumer, and the derivation is a pure function with no wall
  clock and no network, so `doctor` stays deterministic.

## Open questions

None outstanding — the end-to-end coverage question was settled at approval (see Decisions) and is
carried by Step 7.
