---
status: accepted
date: 2026-07-12
---

# 015 — Languages beyond TypeScript parse through bundled WASM grammars; the battery defines "precise"

## Context

Per-symbol staleness is the gate's moat and it is TypeScript-only. The `LanguageAdapter` seam was
designed so adding a language means registering an adapter with zero changes to the determinism
core — but the seam had no parsing substrate behind it. The TS adapter got one for free (the exact
TypeScript compiler ships as a pinned dependency); no other language does. The gate's flagship
invariant — the verdict is a pure function of `(base, head, codument version, algoStamp)`,
byte-reproducible across machines — decides what a substrate may look like: shelling out to an
ambient toolchain (`python -m ast`, `gofmt`, a JVM) makes the verdict a function of whatever the
machine happens to have installed (version-skewed ASTs, or nothing at all), and native parser
bindings break the zero-compilation install.

A second failure mode is subtler: adapters written at different times drift into subtly different
meanings of "signature", "body", and "silent", so "precise" degrades from a contract into a
per-language vibe.

## Decision

1. **Tree-sitter grammars compiled to WASM, loaded through the pinned `web-tree-sitter` runtime,
   are the only parsing substrate for languages beyond TypeScript.** Grammar binaries are built
   once, committed under `grammars/`, and shipped in the package: a parse is a pure function of
   (content bytes, grammar bytes, runtime bytes), all pinned by the installed version. Native
   tree-sitter bindings are ruled out permanently (native compilation on install); ambient-
   toolchain parsing is ruled out permanently on the verdict path (the ADR 003 lineage).

2. **The substrate is lazy and fail-loud.** Importing it evaluates no WASM; the runtime
   initializes on the first grammar load, so a TypeScript-only repo never pays a WASM init. A
   missing, corrupt, or duplicate grammar binary raises; it never silently degrades a precise
   language to a coarse whole-file verdict (the false-fresh hole the TS classification work
   closed). Precise / coarse / unevaluable remains each ADAPTER's decision; the substrate only
   refuses to lie about being able to parse.

3. **The bundled grammar set is part of the determinism identity.** `algoStamp()` carries one
   sorted segment digesting (language → grammar content hash); a grammar upgrade changes the
   stamp exactly like a TS version bump — an algo-visible event, a clean re-baseline, never
   cross-version reuse. The stamp is the auditable NAME of that event (surfaced via
   `codument audit --json`), not the mechanism: live invalidation flows through the content
   fingerprints themselves — a bumped grammar moves its language's per-symbol fingerprints, so
   per-symbol acks invalidate naturally (fingerprint binding) with no stamp comparison involved;
   file-grain acks survive (coarse hashes never derive from parsing). The segment is omitted
   while no grammar ships, so existing TS-only installs cross no stamp shift before the first
   adapter release.

4. **The conformance battery is the contract for "precise".** Every per-symbol adapter must pass
   the shared eight-behavior battery (format invariance; ackable body vs never-ackable signature;
   helper closure; module residual; parse errors classify unevaluable; position-independent
   identity; byte-determinism incl. raw CRLF/BOM; SCIP-shaped descriptors) — and the battery is
   itself proven to bite by a seeded mutant it must reject. A battery the known-good adapter
   fails is a battery bug; a battery too weak to catch the mutant is theater.

5. **The TypeScript adapter does NOT migrate to tree-sitter.** The TS compiler is already
   bundled, battle-tested, and fingerprint-stable; rewriting it would bump ALGO for zero user
   value. It does, however, answer to the same battery as everyone else.

## Consequences

- Adding a language becomes a bounded, testable exercise: vendor a grammar, map nodes to the
  shared anchor/descriptor shapes, pass the battery. The per-language plans carry only genuinely
  language-specific decisions (visibility rules, member splits, macro bounds).
- Package weight grows per shipped grammar (hundreds of KB to a few MB each); a language becomes
  "source" — and its grammar ships — only in the plan that makes it judgeable, never
  speculatively. Until then the battery exercises a real grammar through an exact-pinned dev
  dependency, so no binary blob enters the repo.
- The pinned runtime and grammars mean a parse cannot drift under a user silently; the flip side
  is that grammar fixes arrive only with a codument release. That is the deliberate trade: the
  gate prefers stale-but-reproducible over fresh-but-machine-dependent.
- Grammar ABI compatibility is pinned by construction (runtime and binaries ship together), and a
  determinism test pins the parse output itself, so a dependency bump that changes parses fails
  the suite instead of shipping quietly.
