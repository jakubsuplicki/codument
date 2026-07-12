---
status: shipped
---

# Plan 18: language-adapter substrate — tree-sitter WASM runtime + adapter conformance suite

Per-symbol staleness is codument's moat and it is TypeScript-only. Every language after the first
should be "write an adapter," not "solve parsing again." This plan builds the two things all of
plans 19–24 ride on: a deterministic multi-language parsing substrate, and a conformance battery
that makes "precise" mean ONE verifiable thing regardless of language.

## Why

- The `LanguageAdapter` seam (`fingerprint.ts`) was designed for this — "adding a language is
  registering an adapter, with ZERO changes to the determinism core" — but the seam has no parsing
  substrate behind it. The TS adapter got one for free (the TypeScript compiler ships as a dep);
  no other language does.
- The determinism contract decides the mechanism. Shelling out to an ambient toolchain
  (`python -m ast`, `gofmt`) makes the verdict a function of whatever the machine happens to have
  installed (version-skewed ASTs, or nothing at all) — the exact failure the TS adapter avoids by
  bundling its parser. Tree-sitter grammars compiled to WASM are the only option that is
  simultaneously bundled, byte-deterministic across machines, dependency-light (no native
  compilation), and shared across every language we will ever add.
- Without a conformance suite, six adapters written at different times drift into six subtly
  different meanings of "signature," "body," and "silent." The battery is the contract.

## Scope

- `package.json` (dependency: `web-tree-sitter`; vendored grammar `.wasm` files under `grammars/`,
  shipped via `files`; exact-pinned `@vscode/tree-sitter-wasm` devDependency as the tests' real
  grammar binary until plan 19 vendors one)
- `src/lib/tree-sitter.ts` (new: pinned runtime loader, lazy per-language init)
- `src/lib/version.ts` (the layout-safe package-root walk-up becomes the shared root resolver the
  grammar directory rides)
- `src/lib/two-ref.ts` (algoStamp gains the adapter-manifest segment)
- `tests/adapter-conformance.ts` (new: the parameterized battery), `tests/tree-sitter.test.ts`
- `docs/concepts/lib.md`, `docs/features/change-control-gate.md`,
  `docs/architecture/decisions/015-*.md` (new), `CHANGELOG.md`, `docs/.registry.json`

```feature-map
src/lib/tree-sitter.ts | change-control-gate | feature | pinned WASM runtime + lazy grammar loader
tests/adapter-conformance.ts | change-control-gate | feature | the battery that defines "precise" for every adapter
```

## Non-goals

- No language adapter ships here (plans 19–24). No extension-spec change: a language becomes
  "source" only in the plan that makes it judgeable.
- No native tree-sitter binding, ever (native deps break the zero-compilation install).
- No ambient-toolchain parsing, ever — the same stance ADR 013 lineage takes for the verdict path.
- The TS adapter does NOT migrate to tree-sitter. The TypeScript compiler is already bundled,
  battle-tested, and fingerprint-stable; rewriting it would bump ALGO for zero user value.

## Decisions (settled)

- **Runtime:** `web-tree-sitter` (WASM). Grammar `.wasm` binaries are built once, committed under
  `grammars/`, and shipped in the package — the parse is a pure function of (content bytes,
  grammar bytes), both pinned by the package version. Loading is lazy per language: a TS-only repo
  never pays a WASM init.
- **Determinism identity:** `algoStamp()` gains one sorted segment derived from the bundled
  adapter manifest (language → grammar content hash). Same package version → same stamp on every
  machine; a grammar upgrade is an algo-visible event exactly like a TS version bump. Per-symbol
  acks under a bumped grammar invalidate naturally (fingerprint mismatch); file-grain acks survive
  (coarse hashes never derive from parsing) — the plan-17 precedent, restated per language.
- **The conformance battery** is a parameterized suite every precise adapter must pass, pinning
  the eight behaviors that define "precise" (each already test-pinned for TS, now generalized):
  1. comment/whitespace/format edits move NO fingerprint;
  2. a body edit moves the fingerprint but not the signature (ackable);
  3. a declared-contract edit moves the signature (never ackable);
  4. a referenced module-private helper's change moves its public referencer (closure);
  5. content no anchor covers lands in the `<module>` residual, in source order;
  6. a parse error classifies `unevaluable` (fail-loud), never silently coarse;
  7. anchor identity is position-independent (reordering declarations moves nothing);
  8. byte-determinism: same content, same anchors, every run, CRLF/BOM-normalized.
- **Proof the battery bites:** step 2 runs the EXISTING TS adapter through it. A battery the
  known-good adapter fails is a battery bug; a battery too weak to catch a seeded mutation
  (mutation-test one rule) is theater.
- **Descriptor discipline:** every adapter maps to the same SCIP-shaped descriptors
  (`name().` / `Name#` / `name.` / `default.` / `<module>`), so acks, ownership, drift output, and
  SARIF stay byte-identical in shape across languages.

## Delivery Plan

- [x] Step 1: `tree-sitter.ts` — runtime init, grammar registry keyed by language id, lazy load,
      grammar-hash manifest; determinism tests (same bytes → identical S-expression across two
      fresh loads; a corrupted `.wasm` fails loud, never falls back).
- [x] Step 2: `adapter-conformance.ts` battery + the TS adapter run through it green; one seeded
      mutation proves the battery rejects a broken adapter.
- [x] Step 3: algoStamp adapter-manifest segment + invalidation tests across a simulated grammar
      bump; ADR-015 (WASM-only, bundled-parser determinism, battery-as-contract); docs, CHANGELOG,
      registry.

## Outcome

Adding a language becomes a bounded, testable exercise: vendor a grammar, map nodes to anchors,
pass the battery. Plans 19–24 each shrink to their genuinely language-specific decisions.

## Acceptance criteria

Battery green on the TS adapter and red on the seeded mutant; WASM parse byte-deterministic across
processes; TS-only repos pay zero WASM cost (lazy-load test); full suite green; `review --strict`
green at every commit.
