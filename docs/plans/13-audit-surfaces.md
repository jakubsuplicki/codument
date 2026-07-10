---
status: shipped
---

# Plan 13: Audit surfaces — visible acks + machine-readable impact ledger

The gate's honesty argument for undecidable semantic claims is "honesty rests on the visible
ack-rate and the durable audit trail" (README:232, ADR 006). Make both actually visible.

## Why

- The audit trail has almost no surface today: `ack --list` is human-only (no `--json` — the one
  natural machine query), the HTML report has no ack section, `watch` shows a single soak line. An
  agent can self-ack its own contract changes and the human never sees a consolidated picture.
- The deferred second-signer independence check is already implemented —
  `isIndependent` (`src/lib/acknowledgment.ts:119`) — with no CLI switch wiring it. ADR 006 names an
  independent-signer strict mode; every primitive exists, nothing is connected.
- The Impact Ledger — the designated #1 marketing feature — has no machine-readable or standalone
  surface either; it renders only inside report/watch. One plan, because both are the same product
  claim: the trust story is auditable, not asserted.

## Scope

- `src/commands/ack.ts`
- `src/commands/review.ts`
- `src/commands/report.ts`
- `src/cli.ts` (flag wiring)
- `src/lib/report-html.ts`
- `src/lib/acknowledgment.ts`
- `src/lib/fingerprint.ts` (recomputed ack validity — adapter-dependent, so it lives with the fingerprint engine, not the deliberately-pure acknowledgment protocol)
- `src/lib/impact-ledger.ts`
- `tests/ack.test.ts`
- `tests/review.test.ts`
- `tests/report.test.ts`
- `docs/features/adversarial-review-gate.md`
- `docs/features/change-control-gate.md` (owns ack.ts + fingerprint.ts — the `ack --list --json` audit surface)
- `docs/features/impact-ledger.md`

No new source files — no feature map.

## Non-goals

- No identity/authentication for signers — signer is the recorded name, as today; independence is
  "a different recorded signer than the change author", exactly what `isIndependent` implements.
- No new ledger event kinds; surfaces only.
- No default behavior change: without the new flag, ack handling is unchanged.

## Decisions (settled)

- `ack --list --json`: versioned contract; each ack with anchor id, path/symbol, transition
  (from→to), signer, reason, recorded-at ref, and current validity (still-covering vs auto-invalidated).
- "Acknowledgments in this change" card in `review` human output and the HTML report: anchor,
  signer, reason, self-vs-independent badge, one line each — rendered whenever the change set has
  any covering ack, so over-acking is loud where the human already looks.
- `review --require-review --require-independent-ack`: an ack whose signer is not independent of
  the change author simply does not count as clearing its finding under this flag (the finding
  stays open/advisory exactly as if unacked); no new blocking semantics beyond what the gate already
  does with an uncleared finding. Flag documented as the ADR 006 strict mode.
- `report --json`: machine surface for the report's existing sections — impact ledger (provable
  lines, drift tallies, frictionRate) and the acks card — version-tagged like `doctor --json`.

## Delivery Plan

- [x] Step 1: `ack --list --json` + validity recomputation on render (never trust stored status);
      tests incl. an auto-invalidated ack showing as such. Validity is base-independent (`covering` /
      `invalidated` / `indeterminate`), computed by `ackValidity` in `fingerprint.ts` (adapter-dependent)
      and surfaced in both the human list (a dim tag) and the versioned `--json` contract.
- [x] Step 2: Acks card in `review` output + `report-html.ts`; tests assert self vs independent
      badges from fixture acks.
- [x] Step 3: `--require-independent-ack` wiring `isIndependent` into the gate's ack-filtering step;
      golden tests: self-ack ignored under the flag (finding persists), independent ack clears,
      no-flag behavior byte-identical to today.
- [x] Step 4: `report --json` (ledger + acks), versioned; byte-identical determinism test; docs
      updates in both feature docs + CHANGELOG.

## Outcome

The ack-rate the trust model depends on becomes something a human or CI can actually look at: every
adjudication is one visible line with its signer and validity, self-review is distinguishable from
independent review (and optionally insufficient), and the marketing-flagship ledger is scriptable.
It does NOT authenticate signers or change any default gate behavior.

## Acceptance criteria

`ack --list --json` round-trips fixture acks with validity; a change with a self-ack shows the card
in review + report; under `--require-independent-ack` that self-ack no longer clears; `report
--json` carries ledger + acks and is byte-identical across runs.

## Verification

`npm test`; `npm run typecheck`; live scratch-repo walkthrough: record self + independent acks,
inspect all three surfaces, run the gate with and without the flag.
