---
status: shipped
---

# Plan 19: Python adapter — per-symbol staleness for the second-biggest agent ecosystem

Python is the highest-leverage language after TypeScript: it is where the other half of agent-led
development happens, and a Python adapter lights up not just the live gate but `codument audit`
on Python history — the zero-commitment adoption wedge — for that entire audience.

Depends on Plan 18 (substrate + conformance battery). Executes against `tree-sitter-python`.

## Why

- Agent-written Python drifts from its docs exactly like agent-written TS; today codument gives a
  Python repo the workflow layer (plans, registry, docs standard, adversarial review) but zero
  deterministic staleness — `.py` files are not even "source."
- Per-symbol grain matters MORE in untyped code, not less: with no type-checker to catch a contract
  slip, "this documented function moved and its doc did not" is often the only mechanical signal a
  Python repo gets.

## Scope

- `grammars/python.wasm` (vendored), `src/lib/py-adapter.ts` (new)
- `src/lib/fingerprint.ts` (register the adapter), `src/lib/analyze.ts` (`.py` joins the
  source-extension spec — in this plan, never before it)
- `tests/py-adapter.test.ts` (conformance battery + language-specific cases), `tests/review.test.ts`
  (e2e arc)
- `docs/features/change-control-gate.md`, `README.md` (language-support matrix row),
  `CHANGELOG.md`, `docs/.registry.json`

```feature-map
src/lib/py-adapter.ts | change-control-gate | feature | Python anchors: module defs/classes/assignments via tree-sitter
```

## Non-goals

- No local-rename canonicalization in v1 (plan-11 equivalent). TS shipped without it too; the
  false-fire class it leaves is exactly what acks absorb, and the soak ledger tells us when it
  earns building. Named follow-up, not smuggled in.
- No notebook support (`.ipynb` is JSON, not Python source).
- No type-stub intelligence (`.pyi` files anchor like any module; no cross-file stub matching).
- No import-graph/ownership seeding changes — descriptors slot into the existing machinery.

## Decisions (settled)

- **Public rule:** when a module declares `__all__`, that list IS the public surface (its
  assignment is itself contract — part of the `<module>` residual's signature side). Without
  `__all__`, every top-level `def`/`class`/assignment not underscore-prefixed is public —
  Python's own convention, stated in the doc as convention, not enforcement. Underscore-prefixed
  declarations are the private-helper closure pool.
- **Anchors:** top-level functions → `name().`; classes → `Name#`; assignments → `name.` (one
  anchor per target, mirroring the TS multi-declarator rule). Module docstring changes are body
  of the `<module>` residual.
- **Signature/body split:** a function's decorators + name + parameters (defaults included) +
  return annotation = signature; the suite = body. **Classes split per member** — signature =
  decorators + name + bases + every method's signature + class-level assignments; body = the
  method suites folded together. This deliberately IMPROVES on the TS adapter's all-signature
  classes (where far less code lives in classes); if soak proves it out, backporting to TS is a
  named candidate, on its own ALGO bump.
- **Dynamic reality, honestly bounded:** module-level executable statements (side effects,
  monkey-patching, conditional defs) land in the `<module>` residual — order-hashed, since
  execution order is semantic. A `try/except ImportError` re-export module classifies coarse with
  the plan-17 signpost, same as a TS re-export barrel.
- **Conformance first:** the plan-18 battery must pass wholesale; language-specific tests add
  decorators-are-signature, default-value changes are signature, docstring-only edits are body
  (they ARE content — but comment `#` edits move nothing), `__all__` edits wake the residual.
- **E2e arc (dogfood analog):** a Django-style `settings.py` — comment edit silent; a setting
  value edit is one named ackable finding; renaming a documented function refuses the ack path
  when its signature moved.

## Delivery Plan

- [x] Step 1: grammar vendored + `py-adapter.ts` anchor extraction (nodes → anchors, public rule,
      descriptors); classification precise|coarse|unevaluable; battery behaviors 1, 5–8 green.
- [x] Step 2: signature/body split incl. the per-member class composite + private-helper closure;
      battery behaviors 2–4 green + the language-specific signature cases.
- [x] Step 3: registration — adapter registered, `.py` into the extension spec, ungated-notice
      retirement for `.py`, e2e settings-arc + audit-on-python-history e2e.
- [x] Step 4: docs — gate doc language matrix, README row, CHANGELOG, registry.

## Outcome

A Python repo gets the full loop: per-symbol drift with pasteable acks, config-file-calibrated
grain, retroactive `audit`, SARIF annotations — same output shapes, zero new concepts.

## Acceptance criteria

Full plan-18 battery green; the settings-arc e2e green; `audit` over a scripted Python history
names drifted symbols; suite green; `review --strict` green at every commit.
