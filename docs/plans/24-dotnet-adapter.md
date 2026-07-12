---
status: shipped
---

# Plan 24: .NET adapter — C# for the other half of the enterprise

C# closes the enterprise pair with Java: the segments most likely to mandate a required doc-drift
check, and a large Copilot-native developer population. Depends on Plan 18; executes against
`tree-sitter-c-sharp`.

## Why

- The JVM plan's argument, verbatim, for the Microsoft-stack half of the market.
- C#'s partial classes and property-heavy style stress the anchor model in ways worth pinning
  once, early, in conformance tests rather than discovering in the field.

## Scope

- `grammars/c-sharp.wasm` (vendored), `src/lib/csharp-adapter.ts` (new)
- `src/lib/fingerprint.ts`, `src/lib/analyze.ts` (`.cs` into the source spec)
- `tests/csharp-adapter.test.ts`, `tests/review.test.ts` (e2e)
- `docs/features/change-control-gate.md`, `README.md`, `CHANGELOG.md`, `docs/.registry.json`

```feature-map
src/lib/csharp-adapter.ts | change-control-gate | feature | C# anchors: types + members via tree-sitter, partial-class folding
```

## Non-goals

- No F#/VB.NET (different declaration models; demand-gated).
- No Razor/`.cshtml` (that is plan 20's block-format problem, revisited there if demand shows).
- No MSBuild/`.csproj` intelligence (XML config is registered-and-surfaced, not judged).

## Decisions (settled)

- **Public rule:** `public` and `protected` anchor; `internal` counts as public within the repo
  (the established repo-audience rule); `private` is the closure pool.
- **Anchors:** the JVM descriptor model verbatim — types `Name#`, members `Name#member().` /
  `Name#property.`, nested chains. **Partial classes fold**: every `partial class Foo` fragment
  in ONE file contributes to that file's `Foo#` anchor; fragments across files stay file-keyed
  (ownership already handles shared surfaces) with the partial-ness itself part of the signature,
  so a member moving between fragment files is visible, never laundered.
- **Signature/body split:** the per-member composite (plans 19/23). C# specifics: attributes are
  signature; a property's declared accessors (`get; set;` vs `get; init;` vs expression-bodied)
  are signature, accessor BODIES are body; primary constructors (C# 12) parameter lists are
  signature in full; `record` positional parameters are signature (they are the equality
  contract).
- **Top-level statements** (Program.cs minimal hosting) land in the `<module>` residual,
  order-hashed — the file still gates without a single declared type.
- **E2e arc:** an accessor body edit acks; `set` → `init` refuses the ack; an attribute added to
  an endpoint refuses the ack; a minimal-API Program.cs edit wakes at residual grain.

## Delivery Plan

- [x] Step 1: grammar + extraction (types/members/nesting, partial folding, top-level
      statements); battery 1, 5–8.
- [x] Step 2: per-member split + closure + attribute/accessor/record calibration; battery 2–4 +
      C# cases.
- [x] Step 3: registration + extension spec + e2e arcs + audit e2e.
- [x] Step 4: docs — matrix, README, CHANGELOG, registry.

## Outcome

C# repos get the same per-symbol loop as everyone else, with the language's contract-bearing
surfaces (attributes, accessors, records, partials) classified deliberately instead of by
accident.

## Acceptance criteria

Battery green; partial-fold/accessor/record cases pinned; e2e + audit e2e green; suite green;
strict green per commit.
