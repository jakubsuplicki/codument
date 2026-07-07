---
status: shipped
---

# Plan 12: `doctor --verify-invariants` — executable invariants

The doc standard binds every invariant to a test pointer, but nothing ever RUNS those tests from the
doc side — a doc can cite a test that is skipped, rotted, or permanently red, and the "invariants
surfaced before edit, linked to their test" promise degrades to prose.

## Why

- The 0.7.0 link-rot lint checks pointer *existence* only. The hardened runner the review adversary
  already uses (`makeTestRunner` in `src/lib/review-confirm.ts`: TAP-evidenced red/green,
  containment-checked paths, symlink-safe) is exactly what's needed — this plan reuses it, it does
  not build a runner.
- This extends verify-don't-trust from diffs to the docs themselves, and it is the only mechanical
  answer available to the born-wrong/already-drifted-doc gap README honestly declares out of scope.
  A doc the agent doesn't trust it routes around; a doc whose invariants provably run green is a doc
  worth trusting.

## Scope

- `src/lib/invariant-check.ts` (new)
- `src/lib/review-confirm.ts` (export/reuse only)
- `src/commands/doctor.ts`
- `src/lib/analyze.ts`
- `tests/invariant-check.test.ts` (new)
- `docs/features/registry-health.md`
- `docs/concepts/doc-audience-layers.md`

```feature-map
src/lib/invariant-check.ts | registry-health | feature | parse invariant test pointers from docs; re-run via the hardened runner; classify green/red/missing/untested
```

Run `codument map materialize src/lib/invariant-check.ts`. Execute AFTER Plan 05 (shares the runner
seams being hardened there).

## Non-goals

- Never default-on: test runs are slow and environment-dependent; bare `doctor` stays instant and
  deterministic. `--verify-invariants` is explicitly the opt-in, environment-touching mode, and the
  output labels itself accordingly (results depend on the local toolchain, unlike core doctor).
- No test *selection* cleverness — the pointer names a file (and optionally a test name); run
  exactly that.
- No auto-editing of docs.

## Decisions (settled)

- Pointer grammar: the standard's existing `*(test: <path>[#<name>])*` markers inside
  `## Invariants & boundaries` sections of registered docs, plus the honest `*(untested)*` marker.
- Classification per invariant: `green` (TAP pass), `invariant-broken` (warn finding: named test ran
  red), `invariant-unpinned` (warn finding: pointer's file missing — subsumes link-rot when this
  mode runs), `unrunnable` (info: runner could not execute — same named-condition honesty as
  Plan 05), `untested` (info tally).
- A scored honesty ratio in the verify-mode output: invariants with green pointers / total
  invariants (untested counts against; unrunnable excluded from the denominator like doctor's
  zero-denominator rule).
- `--test-command` passthrough identical to `review`'s quoted-string contract.

## Delivery Plan

- [x] Step 1: Pointer parser over registered docs (fixtures: multiple invariants, named tests,
      untested markers, malformed pointers surfaced not skipped).
- [x] Step 2: Runner wiring via the exported `makeTestRunner`; classification + findings; dedupe
      identical pointers so a shared test runs once.
- [x] Step 3: Doctor flag, human rendering (per-entry table + honesty ratio), `--json` extension
      (versioned), `--strict` interaction (broken/unpinned are warn findings → strict fails). Tests
      end-to-end on a fixture project with one red invariant. Also root-fixed `makeTestRunner` to
      strip `NODE_TEST_CONTEXT` (a spawned `node --test` child inheriting the parent context read a
      red test as green — a false-clean the confirm gate shared).
- [x] Step 4: Docs: registry-health.md gains the mode invariant; doc-audience-layers.md's test-pointer
      note updated; CHANGELOG. Dogfood over this repo, then an adversarial review (4 confirmed
      false-clean holes, all fixed): the marker parser now recognizes a test cited through ANY prose
      (not just a `test:` prefix — codument writes `pinned by … x.test.ts`), scans ALL `*( … )*` spans
      so a trailing aside cannot shadow a real citation, drops the unenforceable `#name` (whole file
      runs), and documents the non-TAP-runner fail-open as an honest limit. Final dogfood: 138 green /
      17 untested / 4 honest, 0 broken, 0 unpinned.

## Outcome

"This doc's invariants are enforced" becomes a checkable claim: a rotted or red invariant pointer is
a named finding instead of silent decoration, with an honesty ratio that rewards pinning. Bare
doctor is unchanged. It does NOT run on every doctor invocation and does not make docs *complete* —
only makes the pins they claim verifiable.

## Acceptance criteria

Fixture: red-test pointer → `invariant-broken` warn + strict exit 1; missing file →
`invariant-unpinned`; `(untested)` → info tally; green run → clean with a correct ratio; bare
`doctor` output byte-identical to before this plan.

## Verification

`npm test`; `npm run typecheck`; live dogfood `node dist/cli.js doctor --verify-invariants` on this
repo, all green (or fixed).
