---
status: draft
---

# Plan 21: Go adapter — the cleanest public-surface semantics of any target

Go is the third ecosystem where agent-led backend work concentrates, and it is the EASIEST honest
target: visibility is syntactic (capitalization), declarations are flat, and there is no dynamic
layer to bound around. Depends on Plan 18; executes against `tree-sitter-go`.

## Why

- Agent-heavy infra/backend teams are disproportionately Go; `audit` on a Go monorepo's history is
  a strong adoption wedge in exactly the segment that already believes in required CI checks.
- Go's conventions map onto the anchor model with almost no judgment calls, so this plan buys a
  third proof that the substrate + battery genuinely made languages cheap.

## Scope

- `grammars/go.wasm` (vendored), `src/lib/go-adapter.ts` (new)
- `src/lib/fingerprint.ts`, `src/lib/analyze.ts` (`.go` into the source spec)
- `tests/go-adapter.test.ts`, `tests/review.test.ts` (e2e)
- `docs/features/change-control-gate.md`, `README.md`, `CHANGELOG.md`, `docs/.registry.json`

```feature-map
src/lib/go-adapter.ts | change-control-gate | feature | Go anchors: package-level decls + receiver methods via tree-sitter
```

## Non-goals

- No cross-file package intelligence: anchors stay file-keyed (`path::symbol`) like every other
  language, even though a Go package spans files — ownership already handles shared files.
- No generated-code heuristics beyond the existing generated-banner rule (which already matches
  `// Code generated … DO NOT EDIT.`).
- No cgo comment-block semantics (`import "C"` preambles land in the residual, stated).

## Decisions (settled)

- **Public rule:** exported = capitalized identifier — Go's own law, zero convention-hedging.
  Unexported declarations form the private-helper closure pool.
- **Anchors:** package-level `func` → `name().`; methods anchor under their receiver type as
  `Type#method().` (pointer and value receivers normalize to one identity — receiver kind is part
  of the SIGNATURE, not the identity); `type` → `Name#`; `var`/`const` → `name.` (per declarator,
  including inside grouped `( … )` declarations — editing one const in a block moves only it).
- **Signature/body split:** func/method signature = name + receiver + type params + params +
  results; block = body. Types: a struct's exported fields and an interface's method set are
  signature; struct tags are signature too (they are wire contract). Unexported struct fields are
  body — the one Go-specific calibration call, mirroring the "internal representation is ackable"
  stance.
- **`init()` functions and package-level side effects** are `<module>` residual (order-hashed);
  multiple `init`s fold in source order.
- **E2e arc:** an exported handler's body refactor is ackable; adding a param or changing a
  result is a signature move refused by ack; a struct-tag edit is a signature move (wire contract).

## Delivery Plan

- [ ] Step 1: grammar + extraction (public rule, receiver-method descriptors, grouped decls);
      battery 1, 5–8.
- [ ] Step 2: signature/body split (struct-tag and unexported-field calibration) + closure;
      battery 2–4 + Go-specific cases.
- [ ] Step 3: registration + extension spec + e2e arc + audit-on-go-history e2e.
- [ ] Step 4: docs — matrix, README, CHANGELOG, registry.

## Outcome

Go repos get per-symbol drift where their culture already lives (small exported surfaces, required
checks), with receiver methods named the way Go developers read them.

## Acceptance criteria

Battery green; struct-tag and receiver-normalization cases pinned; e2e + audit e2e green; suite
green; strict green per commit.
