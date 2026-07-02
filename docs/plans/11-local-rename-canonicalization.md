---
status: draft
---

# Plan 11: Local-rename canonicalization — kill the #1 measured false-fire

Renaming a local variable currently moves its declaration's fingerprint and fires the gate. It is
the one false-fire the maintainer's own soak demo found in four common refactors, README:214 names
it as a known token-stream limit, and — because the info-only→blocking flip is calibrated on
frictionRate — the single largest friction source is also the single largest obstacle to the
product's own roadmap. Fix it structurally instead of waiting for soak data to justify tolerating it.

## Why

- Soak evidence: of four common refactors exercised in the change-control fixture demo, the only
  false-fire was a local-variable rename (ack-cleared). Every such ack inflates frictionRate.
- A deterministic canonicalization pass removes the false-fire class without touching the
  determinism contract: a pure function of the parsed declaration, same pinned TypeScript parser,
  versioned in `algoStamp`.

## Scope

- `src/lib/ts-adapter.ts`
- `tests/ts-adapter.test.ts`
- `tests/gate-wiring.test.ts`
- `docs/features/change-control-gate.md`

No new source files unless the canonicalizer merits its own module — if so:

```feature-map
src/lib/ts-canonicalize.ts | change-control-gate | feature | per-declaration local-identifier canonicalization before fingerprint hashing
```

(then `codument map materialize src/lib/ts-canonicalize.ts`). Run consecutively with Plan 10 —
both bump `algoStamp`; back-to-back execution means one fingerprint-universe shift for users.

## Non-goals

- No cross-declaration rename detection (renaming an exported symbol stays a remove+add — that is
  contract change, and correct).
- No canonicalization of free/imported/exported identifiers — only names bound *within* the
  declaration.
- No attempt to be clever about comments/strings (already outside the token stream / literal
  content respectively).

## Decisions (settled)

- Approach: per-declaration, resolve identifier bindings with the TypeScript binder over the
  already-parsed SourceFile; every identifier whose declaration site lies within the enclosing
  anchored declaration is rewritten to a positional index (`$0`, `$1`, …) in first-binding order
  (de Bruijn-style) before hashing. Parameters, local `const`/`let`/`var`, inner function names,
  destructured bindings, catch params, type parameters all qualify; anything resolving outside the
  declaration (imports, module-scope, globals, property names) stays literal.
- Property names and object keys stay literal even when they shadow a local name — accessor shape is
  contract-adjacent.
- Fallback if the binder proves unreliable in edge cases (decided fallback, not an open question):
  canonicalize only parameters and directly-declared block-scoped names found by lexical walk, and
  document the narrower guarantee. Attempt the binder first; the fixture suite decides.
- Canonicalizer version folds into `algoStamp` (explicit one-time universe shift; existing acks
  auto-invalidate by construction).

## Delivery Plan

- [ ] Step 1: Canonicalizer with an adversarial fixture suite: shadowing (local shadows import;
      inner shadows outer), destructuring + defaults, closures over sibling locals, `this`/property
      access, generics, labeled statements, catch bindings, computed keys. Assert: rename-local →
      identical canonical stream; rename-param-and-its-uses → identical; renaming a *captured outer*
      name → different (correctly fires).
- [ ] Step 2: Wire into the anchor token stream pre-hash; algoStamp bump (coordinate with Plan 10 if
      unshipped). Gate-wiring test: the soak demo's local-rename scenario now fires nothing;
      a helper-closure body change still fires its exported callers.
- [ ] Step 3: Docs: `change-control-gate.md` limits section (local renames no longer false-fire; what
      still fires and why), README:214 known-limits update, CHANGELOG entry.

## Outcome

The gate stops charging an ack for the most common meaning-preserving refactor, frictionRate drops
structurally rather than statistically, and the gate-flip case strengthens. Renames that change
contract or cross declaration boundaries still fire — this narrows noise, not coverage.

## Acceptance criteria

The fixture suite's rename cases produce identical fingerprints; captured-name and exported renames
still move; the soak-demo scenario is codified as a regression test; determinism tests stay
byte-identical.

## Verification

`npm test`; `npm run typecheck`; live: re-run the four-refactor demo sequence from the soak
validation in a scratch repo — expect zero false-fires and the same true-positives.
