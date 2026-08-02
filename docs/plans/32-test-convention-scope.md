---
status: shipped
---

# Plan 32: "test file" means what a language's own convention means

This repository documents `tests/adapter-conformance.ts` as a primary source of
[change-control-gate](../features/change-control-gate.md), while
[registry-health](../features/registry-health.md) promises the built-in exclusion spec removes
"generated, build, and test files (test suites and fixture trees alike)" and [plan
30](30-registry-authoring-contract.md) states there is "no legitimate case for a test file in
`primary_sources`". Read literally, this repo's own registry breaks its own shipped rule — and the
write guard plan 30 shipped does not fire on it, because the guard asks a narrower question than the
prose does.

The guard is right and the prose is wrong. `TEST_CONVENTIONS` excludes a file that a **language's own
test convention names** — `*.test.*`, `_test.go`, `test_*.py`, Maven's `src/test`. It does not
exclude "anything living near tests", because a directory name is not a convention. The conformance
battery is a first-party library with a documented contract that seven test files depend on; it is
not a test, and governing it is correct.

An earlier attempt fixed this the other way round — a bare, unanchored `tests` entry in
`TEST_CONVENTIONS.dirs`, so the file would fall out of scope and the prose would come true. It was
reverted. It silently swallowed any nested first-party directory named `tests` (the exact hazard the
`fixtures/**` entry three lines below it is root-anchored to avoid), it dropped a documented
contract out of the gate entirely, and — contrary to how it was pitched — it can *lower* a project's
coverage rather than raise it, because an owned file leaving scope leaves the numerator as well as
the denominator.

But that attempt had a real kernel. There is one language where a `tests/` **directory** genuinely
is the convention, as hard a law as Go's `_test.go`: Cargo defines `<crate-root>/tests/*.rs` as
integration-test binaries and `<crate-root>/benches/*.rs` as benchmarks. The spec currently carries
**no Rust test rule at all**, so a Rust project's integration tests read as undocumented first-party
source: `review --strict` fails on them as unmapped changes, and a project that registered them to
silence that gets no `generated-leakage` warning telling it not to. That is the defect worth fixing,
and it is fixable anchored — precisely, by Cargo's law, without touching anything a directory name
alone would have swept up.

(The coverage *percentage* is not part of this: `doctor`'s walk is scoped to `srcDir`, which defaults
to `src/` when one exists, and Cargo requires `src/lib.rs` or `src/main.rs` — so `tests/` and
`benches/` are siblings that were never in the denominator. Only the diff-driven gate and the lint
were wrong.)

## Why

- The prose and the mechanism disagree about what "a test file" is, and the prose is the one users
  and agents read when authoring a registry. A contract nobody can satisfy by reading it is worse
  than a narrow one stated plainly: the agent that wrote three test files into demo-1's
  `primary_sources` was following the authoring rules, and the agent reading today's wording would
  conclude this repo is in violation and "fix" it by un-mapping a documented contract.
- Cargo's `tests/` hole is a live false nag with real blast radius. Every Rust user is currently told
  their integration tests are undocumented source; the language matrix already claims Rust support,
  and the exclusion list already honors Go's and the JVM's equivalent laws.
- Both halves are the same correction, not two changes bolted together: the built-in spec follows
  each language's own law, and everything short of a law is the project's own additive declaration.
  Writing that down is what stops the next attempt from reaching for a bare directory name again.

## Scope

- `src/lib/exclusion-spec.ts` — Cargo's integration-test and benchmark trees, root-anchored, beside
  the existing `fixtures/**` anchoring rationale
- `docs/features/registry-health.md` — the denominator paragraph's "test files" wording and the
  Rust entry in the governed-families list
- `rules/documentation.md` — the authoring contract's statement of what may not be a `primary_source`
- `tests/analyze.test.ts`, `tests/change-state.test.ts` — the new exclusions, and the boundary that
  keeps a non-test module under a test directory governed
- `CHANGELOG.md`

No new source files, so no Feature Map and no `map materialize`. No independent plan pass runs on a
plan that introduces no source files.

## Non-goals

- **No bare directory-name exclusion, for any language.** `tests`, `test`, and `spec` are ordinary
  English words a diagnostics, exam, or lab-assessment product legitimately uses for domain code.
- **No C# test rule.** Java's `*Test.java` is Surefire's default include pattern — an ecosystem
  default with a runner behind it. C#'s equivalent does not exist: xUnit, NUnit and MSTest all
  discover by attribute, never by filename, so `*Tests.cs` is style rather than law. Excluding on
  style is exactly the move this plan rejects.
- **No `examples/**` exclusion.** Cargo example code is user-facing sample code a project may
  legitimately want documented; unlike a test binary it has readers.
- **No un-mapping of `tests/adapter-conformance.ts`.** It stays a registered, gated primary source —
  that is the conclusion of this plan, not an exception to it.
- **No change to the additive-only constraint**, the extension list, or the `generated-leakage` lint.
- **No cargo-workspace member detection.** See the honest bound in Decisions.

## Decisions (settled)

- **A built-in exclusion follows a language's law or its default test-runner include pattern, never
  a directory name on its own.** This is the rule the `fixtures/**` entry was already applying
  without stating it, and stating it is what makes the Rust rule safe and the `tests` rule
  impossible. A project whose test helpers are unconventionally named declares them itself; that is
  what additive declaration is for, and the declared scope is disclosed beside the score so the
  narrowing stays visible.
- **A first-party module that lives under a test directory but is not itself a test stays governed.**
  Registration is an explicit human claim, and the built-in spec only removes what a convention
  names. `tests/adapter-conformance.ts` is the worked example: a documented contract seven adapters
  must satisfy, correctly registered and correctly gated.
- **Cargo's trees are root-anchored, and a workspace member's are not covered.** `tests/**/*.rs`
  matches the crate root, which is where Cargo's law actually applies. A workspace's
  `crates/*/tests/*.rs` stays governed, because the spec is a pure glob matcher with no view of
  where `Cargo.toml` files sit, and guessing would re-introduce the unanchored hazard. A workspace
  declares its own pattern — the same answer the docs already give for an unguessable monorepo
  layout. This is an honest bound, stated in the doc, not a silent gap.
- **The widening moves a registered project's coverage down, not up, and the changelog says so.** A
  project that never registered its cargo tests sees no coverage change at all — `doctor`'s walk is
  `srcDir`-scoped and those trees are siblings of `src/`, so they were never in the denominator; what
  it gains is a `review --strict` that stops failing on them as unmapped. A project that *did*
  register them sees the ratio fall, because an owned file leaves numerator and denominator together
  and a ratio below 100% can only drop, and it gains a `generated-leakage` warning naming the file —
  the correct signal, telling it to un-map. Pitching a spec widening as a one-directional improvement
  is what made the reverted attempt look safe.
- **The reverted attempt's regression tests are rewritten as positive invariants, not kept as
  absence checks.** A test asserting "the bad change is not present" decays into noise the moment
  someone reads it without the history; the same facts stated as "a nested first-party `tests`
  directory stays governed" and "the conformance battery still produces gate signal" hold their
  meaning on their own.

## Delivery Plan — test-convention scope (2026-08-02)

Status: shipped 2026-08-02. Benchmarks shipped alongside integration tests.

- [x] Step 1: Add Cargo's integration-test and benchmark trees to `TEST_CONVENTIONS.globs`,
      root-anchored, with the anchoring rationale folded into the existing `fixtures/**` comment so
      one explanation covers both. Pin all four cases: a crate-root integration test and benchmark
      excluded; a `src/**/tests/*.rs` module and a workspace member's `crates/*/tests/*.rs` still
      governed.
- [x] Step 2: Pin the boundary the spec actually draws, replacing the two absence-checking
      regression tests with positive invariants — a nested first-party directory named `tests` stays
      in scope, and this repo's own `tests/adapter-conformance.ts` still surfaces in change-state
      when it changes.
- [x] Step 3: Correct the over-broad wording at both authoring surfaces — `registry-health.md`'s
      denominator paragraph and governed-families list, and `rules/documentation.md`'s registry-entry
      contract — so both say a file the language's test convention names, and both name the
      project's own `exclude` declaration as the route for an unconventional test helper. Verify a
      scaffolded project carries the updated text.
- [x] Step 4: Record the scope change in `CHANGELOG.md`, naming both directions coverage can move
      and the `generated-leakage` findings a project with registered cargo tests will newly see.

## Outcome

A Rust project stops being told its integration tests are undocumented source: `tests/*.rs` and
`benches/*.rs` at the crate root leave the coverage denominator and the unmapped-source signal, the
same way `_test.go` and `src/test/**` already do for Go and the JVM.

The authoring contract becomes one an agent can actually satisfy by reading it. It says a file a
language's test convention names is never a `primary_source`, which is what the shipped write guard
enforces — so the two can no longer disagree, and this repository's registration of its conformance
battery reads as correct rather than as a violation to be "fixed".

What it deliberately does not do: it does not exclude everything under a `tests/` directory. A
JavaScript, Python, or TypeScript helper under `tests/` that carries no conventional suffix stays in
scope and still counts against coverage; a project that wants it out declares it. It does not cover
cargo-workspace members. And it moves real numbers — a project that registered its cargo tests will
see coverage fall and new `generated-leakage` findings, which is the correct signal rather than a
regression.

## Acceptance criteria

- `tests/api.rs` and `benches/bench.rs` are excluded; `src/exams/tests/model.rs`,
  `crates/foo/tests/bar.rs`, and `tests/adapter-conformance.ts` are not.
- A change to `tests/adapter-conformance.ts` still produces gate signal in this repo's own
  change-state, and `codument doctor` still reports 100% with no lint findings.
- The authoring wording, read cold by an agent with no history, does not imply that a non-test module
  under a test directory must be un-mapped.
- A project that declares nothing and uses no Rust gets a byte-identical verdict, coverage number,
  and lint set.
- The changelog states the direction coverage can move for a Rust project that registered its
  integration tests.

## Open questions

- **Should `benches/**/*.rs` ship alongside `tests/**/*.rs`, or wait?** Settled at approval: ship
  both. Same Cargo law, same anchoring, and a benchmark has no more claim to be documented source
  than a test binary does — splitting it would only mean reviewing an identical decision twice.
