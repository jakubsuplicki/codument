---
title: Impact Ledger
status: current
type: feature
owner: ""
sources:
  - src/lib/review-events.ts
  - src/lib/impact-ledger.ts
  - src/commands/emit.ts
  - src/commands/review.ts
  - src/lib/git.ts
  - src/cli.ts
  - src/commands/watch.ts
  - src/commands/report.ts
  - src/lib/report-html.ts
depends_on:
  - review-effectiveness-metric
  - complete-cost-capture
  - token-cost-tracking
  - change-control-gate
last_reviewed: 2026-07-01
---

## Summary

Codument's value is a counterfactual — the stale doc you did not ship, the high-risk change you looked at before merging, the scope drift you caught. `watch` already names these for the *current* change, but nothing accumulates them, so the project never shows what the loop has caught over its life. This feature adds a cumulative, all-sessions **Caught ledger** to `watch` (and the shareable `report`), sourced from `.codument/events.jsonl` the same way `cost` is.

The headline split is the whole point: **provable** catches that Codument computes deterministically lead; **agent-self-reported** review-fixes sit on a separate, clearly-labeled line. The two have opposite trust levels and must never blend into one number. This implements the [[review-effectiveness-metric]] concept as concrete behavior.

## Current decision (scope)

Two flow-event types, two write-seams, one cumulative tally rendered in `watch` and `report`.

**Provable line (deterministic, ungameable).** When `review-work` runs `codument review` for a change — *before the loop clears the findings* — a `review --log` flag records a `caught` event with the *identities* of what the analyzer flagged: which docs went stale, which features carry a risk tag, which files fell off-plan — not bare counts. (The capture point is review-time, **not** commit-time: by commit the loop has usually fixed the stale docs, so a commit-time snapshot would be empty — see [[review-effectiveness-metric]]. Resolved 2026-06-22.) Storing identities (already present in the analyzer output) lets the tally count **distinct things caught** across the project rather than re-counting the same nagging doc every run, and lets a later pass derive *flagged-then-fixed* (a doc flagged stale, then updated afterward) from the same events without re-instrumenting. The numbers are Codument's, computed from the diff; the agent only triggers the snapshot, so the line stays provable.

**Reported line (self-reported, labeled).** A `review` event records a review finding the agent resolved before commit, with a coarse tier. Emitted by a new `codument emit review` subcommand (parallel to the existing `emit tokens`) that `review-work` shells once per resolved finding. The `watch` headline counts only `resolution=fixed` at `tier=correctness`; minor and deferred are tallied but kept out of the headline, and the line is always labeled "agent self-reported." Credibility for this number comes from the planted-bug benchmark (#2), not from the per-repo figure itself.

Both lines are cumulative across all sessions, read from `events.jsonl` (consistent with `cost`); the tally is a pure function in `lib`, like `verdict`/`token-report`.

### Event shapes

```jsonc
// Deterministic — emitted by `codument review --log` when review-work runs,
// before the loop clears the findings. Stores identities, not bare counts, so
// distinct-count and flagged-then-fixed are both derivable at tally time.
{ "ts": "…", "type": "caught",
  "data": { "commit": "<sha|null>",
            "staleDocs": ["docs/features/recipe-list.md"],
            "riskTouches": ["subscription-paywall"],
            "offPlan": ["src/utils/currency.ts"] } }

// Self-reported — emitted by `codument emit review`, once per resolved finding
{ "ts": "…", "type": "review",
  "data": { "tier": "correctness", "resolution": "fixed",
            "feature": "auth", "step": 3, "summary": "off-by-one in token expiry" } }
```

### The watch section

```
Caught (all sessions)
  Provable    23 stale docs flagged · 4 high-risk touches · 2 off-plan changes
  Reported    11 review issues fixed before commit   (agent self-reported · correctness)
  soak        9 symbol move(s) · 4 resolved by doc update · 4 acked · 1 file-acked   (friction 56% · info-only)
```

It renders under the existing cost block, after the per-feature spend. On a project with no logged catches yet, the whole section is omitted (empty = absent, matching the verdict's empty-findings behavior). The `Reported` line is omitted independently when no `review` events exist, so a repo that never emits self-reported fixes shows only the provable line.

**Soak line (drift calibration, info-only).** A `caught` event also carries a `DriftTally` — the per-symbol drift outcome for that snapshot: how many owned anchors moved, how many were **resolved by a doc update** (the owning doc changed in the diff — the same verdict-derived resolution the gate uses), how many were cleared by an **acknowledgment** — split into per-symbol refactor acks and file-grain additive acks (`ack <path>`), both of which owe no doc change — and a separate co-movement breakdown kept only as info-only telemetry for calibrating co-movement itself. Summed across snapshots by `summarizeImpact` into a `DriftLedger`, this is the **soak signal** for the freshness gate: friction is the share of *resolved* fires that owed no doc change (either ack kind) rather than a real doc update. Counting a file-grain ack on the ack side, never as a doc update, is what keeps friction honest (see [[change-control-gate]] / ADR 012). It calibrates whether the deterministic stale-doc verdict is quiet enough to become a required CI check (the info-only → blocking flip). Co-movement is never a resolution input (see [[change-control-gate]] / ADR 010); the soak never blends into the provable/reported headline; and it is always labeled info-only.

**Ack audit events (change-control, not part of the ledger).** `review-events.ts` also defines `emitAck`/`emitAckRemove`, which append identity-bearing `ack` / `ack-remove` records to the same `events.jsonl` when the change-control gate records or retracts an acknowledgment — carrying the anchor, its `from`→`to` fingerprint, the reason, the signer, and self-vs-independent. They are the durable audit trail that makes an agent's self-resolved drift auditable from the log alone (see [[change-control-gate]]); they share the log and this module, never the Caught tally.

### Honesty rules

- **Provable leads; reported is labeled.** The two lines are never summed into a single "Caught: N." The `Reported` line always carries the `agent self-reported` label.
- **Provable is computed, not claimed.** `caught` events store Codument's own analyzer output for a committed diff. The agent triggers the snapshot but cannot set the numbers.
- **Count distinct things caught, not repeats.** Because `caught` events store identities, the headline counts distinct docs/areas flagged across the project — a doc stale across ten commits is one catch, not ten. Per-commit detail stays recomputable from the events, and *flagged-then-fixed* (the stronger "caught a problem you then resolved" framing) is derivable from the same data as a fast-follow.
- **Flagged is not prevented.** A flag the developer overrode and committed anyway is a warning, not a save. The provable line says "flagged," never "prevented"; the resolved framing, once derived, is the only one that may claim a thing was caught *and fixed*.
- **Count fixes, not findings.** A `review` event is only headline-counted when `resolution=fixed` — a verifiable change before commit. Raised-and-dismissed counts for nothing.
- **The soak line is idempotent under re-review.** Each snapshot carries the drift fires as transition identities (the anchor plus its exact content transition — the same binding an acknowledgment uses), and the ledger counts each transition once no matter how many snapshots observed it, settling it in its LAST-observed class (flagged, then resolved, counts once as resolved). Re-logging an unchanged diff cannot inflate `frictionRate` — the number the info-only→blocking gate flip is calibrated from. Snapshots written before identities existed carry counts only and sum as recorded (an accepted bound on old logs, not a silent one). *(test: impact-ledger.test.ts "transition-identity dedup" — re-log idempotence, re-move accumulates, last-observation settles, legacy sums)*

## Non-goals

- No new top-level command. The ledger lives in `watch`; the shareable copy lives in `report`. (`emit review` and `review --log` are a subcommand and a flag on existing commands, not new commands.)
- No blending of provable and reported into one number.
- No claim of "prevented production bugs." The reported line is "changed before commit, tiered."
- No fine-grained tier taxonomy yet — `correctness` vs `minor` only; finer tiers are a later additive change.
- No networking, sync, or sharing — entirely local, like the rest of the events log.
- No change to how the deterministic findings themselves are computed (reuses the `review`/`verdict` analyzer unchanged).
- No attribution footer on the `report` HTML — deliberately not built, pending user confirmation; everything else in the original cut shipped.

## Open questions

- **Flagged-then-fixed timing.** Identities are stored from Step 1, but the cross-commit *flagged-then-fixed* derivation (the strongest framing) is a fast-follow after the distinct-count shape proves out in dogfooding — not in the first cut.
- **Tier taxonomy.** Whether `correctness` should split (security / data-loss / logic) later; additive, deferred until the coarse shape proves out.
