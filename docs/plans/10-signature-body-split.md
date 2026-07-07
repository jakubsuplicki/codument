---
status: shipped
---

# Plan 10: Signature/body anchor split — a public-signature change is not ackable

Close the widest remaining laundering channel through the gate: today a public API signature change
can be acked away exactly like a whitespace-adjacent body tweak.

## Why

- ADR 006 already states signature-ineligibility as the decided stance, and
  `docs/features/change-control-gate.md` admits it is "not yet enforced… untested — deferred". This
  plan implements a decision the ADRs already made.
- Anchors are body-inclusive today: one fingerprint per symbol, so the gate cannot distinguish "the
  contract changed" from "the implementation moved". A contract change *must* wake its doc with no
  ack relief — that is the product's core promise.
- Soak telemetry benefit: the sig-moves vs body-moves ratio is a far better gate-flip calibration
  signal than the current blended count (the flip decision is explicitly soak-data-dependent).

## Scope

- `src/lib/ts-adapter.ts`
- `src/lib/fingerprint.ts`
- `src/lib/drift.ts`
- `src/lib/change-state.ts`
- `src/commands/ack.ts`
- `src/commands/review.ts`
- `src/lib/review-events.ts`
- `src/lib/impact-ledger.ts`
- `tests/ts-adapter.test.ts`
- `tests/gate-wiring.test.ts`
- `tests/ack.test.ts`
- `docs/features/change-control-gate.md`

No new source files — no feature map. Coordinate with Plan 11: both change the fingerprint universe
(algoStamp bump); run them consecutively so users see ONE universe shift, not two.

## Non-goals

- No semantic API-compatibility analysis (co/contravariance, overload resolution) — the signature is
  a token span, judged by the same fingerprint mechanics as everything else.
- No change for coarse (non-TS) files — they stay file-grain where acks already behave
  conservatively.
- No retroactive migration of existing acks: the algoStamp bump auto-invalidates them by
  construction (that is the designed behavior, not a migration task).

## Decisions (settled)

- Signature span for TS: the declaration's tokens from its start (modifiers, name, type parameters,
  parameters, return/type annotations) up to the body opener; body = the rest. Arrow-function
  consts: the declarator up to the `=>` body. Type aliases/interfaces: the whole declaration is
  signature (no body).
- Each anchor's fingerprint becomes `{sigHash, bodyHash}` using the same length-prefixed token
  framing. A change where `sigHash` moved refuses `ack <path>::<symbol>` with "the symbol's
  signature changed — the owning doc's contract needs an update, not an ack" (mirror the existing
  added/removed refusal tone, and name the doc). Body-only moves keep today's ack path unchanged.
- File-grain acks do NOT clear a sig-moved symbol either (conservative, consistent with ADR-012's
  additive-residue stance): the stale-doc verdict for that entry persists until the doc changes.
- `DriftTally` records `sigMoves` and `bodyMoves` separately; the `watch` soak line shows both.
- Fold a fingerprint-format version into `algoStamp` so the universe shift is explicit and one-time.

## Delivery Plan

- [x] Step 1: `ts-adapter.ts` emits per-declaration signature/body token spans; `{sigHash, bodyHash}`
      in the anchor fingerprint; algoStamp bump. Fixture tests: rename-param vs rename-local,
      return-type change, modifier change, arrow consts, interfaces/type aliases, overloads.
- [x] Step 2: Thread the pair through `fingerprint.ts`/`drift.ts`/`change-state.ts`; classification
      of a change as sig-moved vs body-only lands on the drift finding (rendered in `review`'s
      symbol-drift section).
- [x] Step 3: Ack refusal (per-symbol AND file-grain) for sig-moved anchors with the decided message;
      golden gate-wiring tests: sig move → stale until doc update; body move → ack clears as today.
- [x] Step 4: Telemetry split in `review-events.ts`/`impact-ledger.ts` + soak line; tests.
- [x] Step 5: Update `change-control-gate.md` invariants (enforced now, pinned to the new tests) and
      the ADR 006 cross-reference; CHANGELOG entry under Unreleased.

## Outcome

A public-contract change can no longer be laundered past the gate by any ack; implementation-only
churn keeps its cheap relief; and the soak data starts separating the signal the gate-flip decision
actually needs. One-time cost: the algoStamp bump invalidates existing acks (by design).

## Acceptance criteria

The golden table covers: sig-only move, body-only move, both, sig move + attempted symbol ack
(refused), sig move + attempted file ack (refused, verdict persists), doc update (clears). Soak line
shows the split. Dogfood `review --strict` on this repo stays green.

## Verification

`npm test`; `npm run typecheck`; live scratch-repo walkthrough of the acceptance table via the CLI.
