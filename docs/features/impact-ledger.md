---
title: Impact Ledger
status: draft
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
last_reviewed: 2026-06-22
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
  soak        9 symbol move(s) · 4 reconciled · 4 acked   (friction 50% · info-only)
```

It renders under the existing cost block, after the per-feature spend. On a project with no logged catches yet, the whole section is omitted (empty = absent, matching the verdict's empty-findings behavior). The `Reported` line is omitted independently when no `review` events exist, so a repo that never emits self-reported fixes shows only the provable line.

**Soak line (drift calibration, info-only).** A `caught` event also carries a `DriftTally` — the per-symbol drift outcome for that snapshot: how many owned anchors moved, how many had their doc's symbol-scoped lines reconcile (`coMoved`), how many were cleared by a recorded acknowledgment, and how many are still unreconciled. Summed across snapshots by `summarizeImpact` into a `DriftLedger`, this is the **soak signal** for the freshness gate: `frictionRate = acknowledged / (acknowledged + coMoved)` — the fraction of *resolved* fires that turned out to need no doc change. It is the number that calibrates whether the deterministic stale-doc verdict is quiet enough to become a required CI check (the info-only → blocking flip). It never blends into the provable/reported headline and is always labeled info-only.

**Ack audit events (change-control, not part of the ledger).** `review-events.ts` also defines `emitAck`/`emitAckRemove`, which append identity-bearing `ack` / `ack-remove` records to the same `events.jsonl` when the change-control gate records or retracts an acknowledgment — carrying the anchor, its `from`→`to` fingerprint, the reason, the signer, and self-vs-independent. They are the durable audit trail that makes an agent's self-resolved drift auditable from the log alone (see [[change-control-gate]]); they share the log and this module, never the Caught tally.

### Honesty rules

- **Provable leads; reported is labeled.** The two lines are never summed into a single "Caught: N." The `Reported` line always carries the `agent self-reported` label.
- **Provable is computed, not claimed.** `caught` events store Codument's own analyzer output for a committed diff. The agent triggers the snapshot but cannot set the numbers.
- **Count distinct things caught, not repeats.** Because `caught` events store identities, the headline counts distinct docs/areas flagged across the project — a doc stale across ten commits is one catch, not ten. Per-commit detail stays recomputable from the events, and *flagged-then-fixed* (the stronger "caught a problem you then resolved" framing) is derivable from the same data as a fast-follow.
- **Flagged is not prevented.** A flag the developer overrode and committed anyway is a warning, not a save. The provable line says "flagged," never "prevented"; the resolved framing, once derived, is the only one that may claim a thing was caught *and fixed*.
- **Count fixes, not findings.** A `review` event is only headline-counted when `resolution=fixed` — a verifiable change before commit. Raised-and-dismissed counts for nothing.

## Non-goals

- No new top-level command. The ledger lives in `watch`; the shareable copy lives in `report`. (`emit review` and `review --log` are a subcommand and a flag on existing commands, not new commands.)
- No blending of provable and reported into one number.
- No claim of "prevented production bugs." The reported line is "changed before commit, tiered."
- No fine-grained tier taxonomy yet — `correctness` vs `minor` only; finer tiers are a later additive change.
- No networking, sync, or sharing — entirely local, like the rest of the events log.
- No change to how the deterministic findings themselves are computed (reuses the `review`/`verdict` analyzer unchanged).

## Delivery plan

Status: implemented 2026-06-22 — all 5 steps done, 406 tests pass, typecheck + build green. **Uncommitted** (left in the working tree at the user's instruction; part of a build-all-then-release set). PR-comment surface (#3) parked. The Step-5 `report` attribution footer is intentionally **not** built — pending user confirm.

- [x] Step 1: Define the two flow events and their write-seams — `codument emit review` (self-reported fix, coarse tier) and `codument review --log` (deterministic catch snapshot storing finding *identities* at the commit boundary) — with a stable JSON shape and unit tests for each seam.
- [x] Step 2: Add a pure all-sessions aggregator in `lib` that tallies `caught` and `review` events into the provable/reported ledger — counting *distinct* things caught (per-commit detail recomputable) and a fixes-only/correctness-only reported headline — with unit tests for the counting semantics.
- [x] Step 3: Render the `Caught (all sessions)` section in the `watch` frame — provable line leads, reported line labeled and omitted when empty — with render tests for present/absent/reported-only states.
- [x] Step 4: Wire the loop — `review-work` runs `codument review --log` during its initial review (snapshots provable catches *while findings are present*) and emits one `codument emit review` per resolved finding. `commit-work` is unchanged (the snapshot moved to review-time; see the capture-point note above). Update both the bundled `skills/` and the `.claude/skills/` copies.
- [x] Step 5: Shareable surface + docs — add the `Caught` section to the `report` HTML, then write this feature's durable content, register new sources in `docs/.registry.json`, and set `last_updated`.

## What was built in Step 1

- New event-contract module `src/lib/review-events.ts`: `emitReview` (writes a `review` event — self-reported fix, validates tier/resolution and **throws** rather than logging malformed input) and `emitCaught` (writes a `caught` event — deterministic, stores deduped identity arrays + commit provenance), plus `isReviewEvent`/`isCaughtEvent` guards that the aggregator will read.
- **Repurposed the existing `review --log`**: it previously wrote a generic `review` count-event (consumed only cosmetically by the `watch` tape, no test locked it); it now writes a `caught` snapshot of the deterministic findings (stale-doc paths, risk feature names, off-plan file paths). `review` is now reserved for the self-reported line.
- New `codument emit review` subcommand (`--tier`/`--resolution` required, optional `--feature`/`--step`/`--summary`); invalid tier/resolution exits nonzero without writing.
- Added `getHeadSha` to `src/lib/git.ts` for `caught` commit provenance (null on a fresh/non-git repo).
- Tests: `tests/review-events.test.ts` (producers, guards, validation, dedup, null-commit) and a `review --log` CLI wiring test in `tests/review.test.ts`. Full suite 393 pass, typecheck + build green.

## What was built in Steps 2–5

- **Step 2 — aggregator.** `src/lib/impact-ledger.ts`: pure `summarizeImpact(events)` + `buildImpactLedger(root)`. Counts **distinct** identities across snapshots (union of Sets — a doc flagged in ten snapshots is one catch), splits `reported` into fixed/deferred × tier with `headline = fixed×correctness`, and exposes `hasProvable`/`hasReported` (a clean snapshot that caught nothing does not light up the line). Tests in `tests/impact-ledger.test.ts`.
- **Step 3 — watch.** `renderFrame` gains a `caught (all sessions)` section (from the all-sessions `events`, like cost): provable line leads, reported line labeled `agent self-reported · correctness`, whole section hidden when empty. Render tests added to `tests/watch.test.ts`.
- **Step 4 — loop wiring.** `review-work` (both `skills/` and `.claude/skills/` copies) now runs `codument review --log` in its review step (snapshot while findings are present) and emits `codument emit review` per resolved finding, tiered. `commit-work` unchanged (capture point moved to review-time — see the capture-point note).
- **Step 5 — report.** `report` threads `buildImpactLedger(root)` into `ReportData`; `report-html.ts` renders a "Caught across this project" panel (provable/reported, themed, omitted when empty). Tests in `tests/report.test.ts`. The attribution footer is deliberately deferred pending user confirm.

## Acceptance criteria

- `watch` shows a `Caught (all sessions)` section with the provable line leading and the reported line labeled "agent self-reported"; the two are never one blended number.
- The provable counts equal Codument's own deterministic analyzer output, summed per commit from `caught` events — reproducible from the same `events.jsonl`.
- The reported headline counts only `resolution=fixed` at `tier=correctness`; minor and deferred do not inflate it.
- A repo with no `caught`/`review` events shows no Caught section; a repo with only `caught` events shows only the provable line.
- `report` HTML carries the same ledger for sharing.
- `emit review` and `review --log` are stable enough for the planted-bug benchmark to consume the same events, and for any later consumer (e.g. a PR-comment surface, if ever built) without a schema change.

## Verification strategy

- Unit: `emit review` and `review --log` append the documented event shapes; malformed input is rejected, not silently logged.
- Unit: aggregator tallies — per-commit summing of provable counts, fixes-only/correctness-only headline, deferred/minor excluded from headline but visible.
- Unit/snapshot: `watch` frame render for clean (no section), provable-only, and provable+reported states.
- Integration: a fixture `events.jsonl` with mixed `caught`/`review`/`token` events produces the expected ledger and leaves cost/verdict output unchanged.
- Manual: dogfood — emit a few review/caught events on this repo and confirm the `watch` section reads honestly.

## Open questions

- **Flagged-then-fixed timing.** Identities are stored from Step 1, but the cross-commit *flagged-then-fixed* derivation (the strongest framing) is a fast-follow after the distinct-count shape proves out in dogfooding — not in the first cut.
- **Report parity.** Whether the `report` HTML ledger ships in Step 5 with `watch`, or is deferred to a follow-up once the `watch` shape is settled.
- **Tier taxonomy.** Whether `correctness` should split (security / data-loss / logic) later; additive, deferred until the coarse shape proves out.
