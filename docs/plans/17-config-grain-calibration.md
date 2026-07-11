---
status: draft
---

# Plan 17: config-file grain + coarse-ack signposts + ungated-source visibility

Dogfooding the website build surfaced where the gate's noise actually lives, and it is not where
the folklore said. Three verified facts drive this plan:

1. `export default defineNuxtConfig({...})` — the shape of nearly every modern config file — yields
   **zero precise anchors**: an `ExportAssignment` has no `export` modifier, so the extractor drops
   it, the file classifies **coarse**, and every byte change (including a comment) wakes the owning
   doc at file grain with no token-stream invariance.
2. A coarse stale doc gets **no ack signpost anywhere**: the ready-made `codument ack` line is
   printed only in the Symbol drift block, which coarse files never reach, and the `--strict`
   epilogue suggests only doc updates. The honest resolution (`codument ack <path>`) exists but is
   invisible at exactly the moment of pressure — which is how "token mirror edits to clear the
   gate" happen, the anti-pattern our own contract warns against.
3. The inverse hole: changed files that the registry names as primary sources but that fall outside
   the source-extension list (`.vue`, `.css`, `.json`, …) land in `otherChanged` **silently** — the
   registry says "this file matters to this doc" and the gate says nothing at all when it changes.

## Why

- Fix 1 kills the observed noise at the root: config files get a real `default.` anchor, comments
  and reformatting stop firing entirely (token-stream hash), local-rename canonicalization applies,
  and content edits become a single, ackable, named finding instead of an unresolvable file wake.
- Fix 2 is the anti-mirror-edit fix: at the moment the gate creates pressure, it must present both
  honest exits with equal weight, exactly as the Symbol drift block already does.
- Fix 3 follows the fail-loud house rule (ownershipLints precedent): the gate may be unable to
  judge a file, but it may not be silent about a file the registry explicitly declared load-bearing.

## Scope

- `src/lib/ts-adapter.ts` (ExportAssignment anchors; body span for default-export expressions)
- `src/lib/two-ref.ts` (`ALGO_VERSION` 3 → 4)
- `src/lib/change-state.ts` (+ ungated-registered surface)
- `src/commands/review.ts` (stale-doc ack signpost; strict epilogue; info section)
- `tests/ts-adapter.test.ts`, `tests/change-state.test.ts`, `tests/review.test.ts` (extend)
- `docs/features/change-control-gate.md`, `docs/architecture/decisions/014-*.md` (new),
  `CHANGELOG.md`, `docs/.registry.json`

No new source files; no `map materialize` needed. Run after Plan 16.

## Non-goals

- No SFC/Vue adapter. An SFC's public contract (props/emits/slots) is a real design question; the
  `LanguageAdapter` seam is ready for it and it gets its own plan when demand is proven. Fix 3
  makes the gap visible in the meantime instead of silent.
- No per-property config anchors (`default.modules`, `default.nitro`, …). The `default.` anchor
  plus token invariance already removes the observed noise; property grain is complexity without a
  demonstrated need.
- No standing per-source noise-tolerance / "low-doc-impact" registry field. ADR-012's rejection of
  ride-forward exemptions stands; every ack remains bound to one transition.
- No `.js`/`.jsx` precise routing (the TS parser could, but that recalibrates every JS repo at once
  — separate plan, own soak).
- Fix 3 is info-only: it never flips `--strict` red. Blocking on `.vue`-heavy repos in the same
  release that makes config files quieter would trade one noise complaint for another; the notice
  plus the ledger measure first.

## Decisions (settled)

- `export default <expr>` (and `export = <expr>`) produce one precise anchor named `default`
  (descriptor `default.`), matching the naming that anonymous `export default function/class`
  already gets. Classification of a config file flips coarse → precise.
- Signature/body split for it: when the expression is a call (`defineNuxtConfig({...})`), the
  signature covers the `export default` frame plus the callee name — swapping the wrapper is a
  contract-grade, non-ackable change; everything inside the arguments is **body**, ackable. For any
  other expression (object literal, identifier, ternary…), the frame alone is signature and the
  whole expression is body. Rationale: a config file's importable contract is "there is a default
  export produced by X"; its contents are exactly the judgment call acks exist for.
- `ALGO_VERSION` 3 → 4 (extraction changed). Same invalidation semantics as the Plan 10 bump:
  per-symbol composite acks invalidate; file-grain and module-residual acks survive. Stated in the
  CHANGELOG.
- Ack signpost: a stale-doc entry whose changed sources include coarse-classified files prints both
  routes under it, symmetric with the Symbol drift block — "doc impact → update <doc> at intent
  altitude / no doc impact → codument ack <path> --reason \"...\"" — and the `--strict` failure
  epilogue names the file-grain ack as a resolution alongside doc updates and materialize. HTML
  report gains the same line; SARIF messages unchanged (rule ids are stable).
- Ungated-registered surface: `computeChangeState` returns the changed files that are registered
  (primary or related) but handled by no adapter-gated path, with their owning docs;
  `printHuman` renders an info section ("registered sources changed outside the gate's reach — the
  registry names these load-bearing; verify their docs by hand"); `--json` gains the field
  additively (no version bump; the contract allows additive fields).
- Dogfood proof: a fixture repo with a `nuxt.config.ts`-shaped file asserts the full arc — comment
  edit → gate silent; value edit → one named `default` body finding with a printed ack line; callee
  swap → signature finding, ack refused.

## Delivery Plan

- [ ] Step 1: ts-adapter — ExportAssignment anchors with the call-aware signature/body split;
      `ALGO_VERSION` 4; classification tests (defineNuxtConfig fixture precise, `export =`, object
      literal, anonymous default fn unchanged); ack eligibility + invalidation tests across the
      bump.
- [ ] Step 2: review ergonomics — coarse-file ack signpost in the stale-docs section, strict
      epilogue naming the file-grain ack, HTML report line; tests on printed output both ways (a
      coarse-only stale doc shows both routes; a precise-only one is unchanged).
- [ ] Step 3: change-state — ungated-registered field + printer info section + additive `--json`
      field; golden tests (a registered `.vue` change surfaces with its doc; an unregistered `.vue`
      change stays in otherChanged; strict exit code unaffected).
- [ ] Step 4: docs — change-control-gate invariants (config-file grain promise; both-routes
      signpost; ungated-source notice), ADR-014 (default-export expressions are body-grain by
      design), CHANGELOG (ALGO bump + invalidation note), dogfood fixture arc as an e2e.

## Outcome

The exact friction from the dogfood dies at the root: a comment in `nuxt.config.ts` fires nothing,
a real config edit fires one named, ackable finding with the honest exit printed next to it, and
the files the gate cannot judge are named instead of silently ignored. The mirror-edit pressure
loses its mechanism.

## Acceptance criteria

The dogfood fixture arc passes as an e2e; every existing golden updates only where the plan says it
should (config-file classification and the new info section); ALGO bump invalidation is
test-pinned; full suite green; `review --strict` green at every commit of this plan.
