---
status: shipped
---

# Plan 23: JVM adapter — Java + Kotlin, where enterprise agent adoption actually is

One plan, two grammars, one set of decisions: Java and Kotlin share the class-shaped world and the
enterprise segment where agent PRs meet mandatory review gates. Depends on Plan 18; executes
against `tree-sitter-java` and `tree-sitter-kotlin`.

## Why

- Enterprise teams are the heaviest users of required CI checks and the most doc-governed segment
  in the industry — the gate's CI-authority posture (ADR 013) was built for exactly them.
- Java and Kotlin interop in the same repos; shipping one without the other would leave mixed
  codebases half-gated, which is worse than ungated (a false sense of coverage).

## Scope

- `grammars/java.wasm`, `grammars/kotlin.wasm` (vendored), `src/lib/jvm-adapter.ts` (new; two
  `matches` entries, one anchor model)
- `src/lib/fingerprint.ts`, `src/lib/analyze.ts` (`.java`, `.kt`, `.kts` into the source spec)
- `tests/jvm-adapter.test.ts`, `tests/review.test.ts` (e2e)
- `docs/features/change-control-gate.md`, `README.md`, `CHANGELOG.md`, `docs/.registry.json`

```feature-map
src/lib/jvm-adapter.ts | change-control-gate | feature | Java/Kotlin anchors: types + members via tree-sitter, per-member class split
```

## Non-goals

- No Scala/Groovy/Clojure (different declaration models; separate plans if demand shows).
- No annotation-processor / codegen awareness beyond the generated-banner rule.
- No Gradle/Maven build-file intelligence (`build.gradle.kts` anchors as ordinary Kotlin script —
  which, notably, plan 17's expression-grain philosophy already calibrates).

## Decisions (settled)

- **Public rule:** Java — `public` and `protected` members anchor (protected is inheritance
  contract); package-private and `private` are the closure pool. Kotlin — default visibility IS
  public, so every non-`private`/`internal`-modified top-level declaration and member anchors;
  `internal` counts as public within the repo (the `pub(crate)` decision, restated).
- **Anchors:** types → `Name#`; methods/functions → `Name#method().` (Java) or top-level
  `name().` (Kotlin); fields/properties → `Name#field.` / top-level `name.`. Nested types chain
  descriptors (`Outer#Inner#`). One-public-type-per-file Java convention means file-keying stays
  natural.
- **Signature/body split — per-member class composite** (the plan-19 Python decision, restated as
  the JVM default): class signature = annotations + modifiers + name + type params + extends/
  implements + every public member's signature; body = method bodies + initializers. Annotations
  are signature (they are framework wiring: `@Transactional`, `@GetMapping` ARE contract).
  Kotlin data classes: the primary constructor parameter list is signature in full.
- **Overloads** fold into one anchor per name with every overload signature hashed in source
  order — the TS overload-run machinery's rule, applied to a language where overloading is
  routine.
- **E2e arc:** a method body refactor acks; an annotation added to a controller method refuses
  the ack; a Kotlin default-visibility function is gated without any modifier present.

## Delivery Plan

- [x] Step 1: grammars + extraction for Java (types/members/nesting, overload folding);
      battery 1, 5–8.
- [x] Step 2: Kotlin extraction on the shared anchor model (default-public, top-level decls,
      data-class constructors); battery for both grammars.
- [x] Step 3: per-member split + closure + annotation calibration; battery 2–4 + JVM cases.
- [x] Step 4: registration + extension specs + e2e arcs + audit e2e; docs — matrix, README,
      CHANGELOG, registry.

## Grammar sourcing (settled during execution)

Java rides the already-pinned `@vscode/tree-sitter-wasm@0.3.1` pack (same source
as Go/Rust/Python/C#). Kotlin has NO grammar in that pack; the two candidates
both load against the pinned runtime (ABI 14) and parse realistic ktlint-style
code identically clean. The choice was `@tree-sitter-grammars/tree-sitter-kotlin@1.1.0`
over `fwcd/tree-sitter-kotlin@0.3.8` on provenance: the former ships its `.wasm`
inside a pinnable npm package (extractable by `npm install`, matching every other
grammar's "pure function of a pinned package version" story per ADR-015), while
fwcd only offers a loose GitHub release asset. Both grammars share Kotlin's
inherent newline-sensitivity — a single-line `{ member }` body produces a false
parse error — which is why compact single-line bodies classify unevaluable
(fail-loud) rather than mis-anchor; production multi-line Kotlin is unaffected.

## Outcome

Mixed Java/Kotlin repos get one coherent gate: framework annotations and public surfaces are
contract, implementations are ackable, and the required-check CI story lands in the segment that
already mandates it.

## Acceptance criteria

Battery green on BOTH grammars; annotation/overload/data-class cases pinned; e2e + audit e2e
green; suite green; strict green per commit.
