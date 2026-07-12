---
status: shipped
---

# Plan 22: Rust adapter — visibility-literal anchors for the most contract-conscious ecosystem

Rust developers already think in public surfaces and semver breakage; per-symbol drift detection
speaks their language natively. Depends on Plan 18; executes against `tree-sitter-rust`.

## Why

- Rust's culture (cargo semver discipline, `pub` as a deliberate act) makes the gate's core claim
  — "a public contract moved and its doc did not" — land with zero explanation.
- Agent adoption in Rust is smaller than Python/Go but growing fastest where correctness matters
  most, which is codument's exact pitch.

## Scope

- `grammars/rust.wasm` (vendored), `src/lib/rust-adapter.ts` (new)
- `src/lib/fingerprint.ts`, `src/lib/analyze.ts` (`.rs` into the source spec)
- `tests/rust-adapter.test.ts`, `tests/review.test.ts` (e2e)
- `docs/features/change-control-gate.md`, `README.md`, `CHANGELOG.md`, `docs/.registry.json`

```feature-map
src/lib/rust-adapter.ts | change-control-gate | feature | Rust anchors: pub items + impl/trait members via tree-sitter
```

## Non-goals

- No macro expansion. A `macro_rules!`/proc-macro definition is one all-signature anchor (a macro
  IS contract); macro *invocations* at item position land in the residual — stated as the honest
  bound, since expansion without rustc is fiction.
- No cross-crate or workspace intelligence; file-keyed anchors as everywhere.
- No cfg-evaluation: `#[cfg(...)]` variants of one item fold into one anchor in source order.

## Decisions (settled)

- **Public rule:** any `pub` visibility (`pub`, `pub(crate)`, `pub(super)`, `pub(in …)`) makes an
  anchor — conservative on purpose: `pub(crate)` is invisible outside the crate but load-bearing
  inside the repo, which is the audience docs serve. Non-pub items are the closure pool.
- **Anchors:** `fn` → `name().`; `struct`/`enum`/`trait`/`type`/`union` → `Name#`;
  `const`/`static` → `name.`; `impl Type` members → `Type#method().`; trait impls
  (`impl Trait for Type`) → `Type#Trait::method().` so a trait-impl swap is visible as its own
  identity. Attributes (incl. `#[derive(...)]`) are signature — derives are contract.
- **Signature/body split:** fn signature = visibility + name + generics + params + return +
  where-clauses; block = body. Struct: pub fields signature, private fields body (the Go
  calibration, restated); enum variants are all signature (they are the type's surface).
- **E2e arc:** a pub fn body refactor acks; adding a where-clause refuses the ack; a derive
  added/removed refuses the ack; a private helper edit wakes its pub referencer via closure.

## Delivery Plan

- [x] Step 1: grammar + extraction (visibility rule, impl/trait descriptors); battery 1, 5–8.
- [x] Step 2: signature/body split (fields/variants/derives calibration) + closure; battery 2–4 +
      Rust-specific cases.
- [x] Step 3: registration + extension spec + e2e arc + audit e2e.
- [x] Step 4: docs — matrix, README, CHANGELOG, registry.

## Outcome

Rust repos get drift findings phrased exactly at the altitude their culture already polices, with
macros bounded honestly instead of pretended at.

## Acceptance criteria

Battery green; derive/where-clause/trait-impl cases pinned; e2e + audit e2e green; suite green;
strict green per commit.
