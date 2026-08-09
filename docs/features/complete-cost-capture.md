---
title: Complete Cost Capture
status: current
type: feature
last_reviewed: 2026-06-19
---

## Summary

The feed and the `watch` view currently follow only the **newest** agent transcript per repo, and present cost through a cryptic strip. This plan makes local capture **complete** (all sessions, including historical) and the `watch` view **legible** — led by a plain-words verdict (`clean` / `drifting` / `at risk` / `off-plan`) over a true, feature-attributed cost total, so a stranger looking at one screenshot understands what the agent is doing, what it's costing, and what's at risk.

This is built as **one complete, tested piece** — correctness (multi-session + backfill) and legibility (the verdict frame) land together. There is no intermediate ship; commits are held until the whole piece is done, tested, and the user says go.

## Background: one assumption, three symptoms

A single design choice — *pump only the newest transcript* (`resolveSessionLog` returns one file; `resetFeed` rebuilds only cursor-touched + active sessions) — is the root cause of three observed problems:

1. **Jumping figure.** The live total swaps between concurrent windows as focus moves.
2. **Under-count.** Total spend reflects only one of several concurrent sessions (~23% undercount measured on the dogfood repo).
3. **No retroactive pickup.** Sessions never observed live are not ingested, though the agent's transcripts persist on disk regardless of the watcher.

The underlying data is sound: per-turn usage is the agent's own API usage, copied verbatim, priced by a rate table verified to the cent against a real log. Only **discovery** and **presentation** are wrong.

## Current decision (scope)

- Replace "newest transcript only" with **"all transcripts whose recorded `cwd` matches the repo root"** in both live pumping and rebuild.
- Add a **backfill** that ingests every matching historical transcript from offset 0, idempotent by per-turn `uuid`, with visible feedback ("+N sessions backfilled").
- Replace the cryptic strip + total-first block with a **verdict-led frame**: a plain-words verdict headline over a true all-sessions total, the active plan step, change scope, the named findings, and per-feature spend.

**Non-goals**

- No change to how token counts are obtained — still verbatim from the agent transcript.
- No networking, sync, or sharing — entirely local.
- No change to the rate-table mechanism or pricing source.

## Locked design — the `watch` frame

The finished frame, "at risk" state (the state that proves the tool catches things). Column widths illustrative; tuned in code.

```
┌─ codument watch · peelmeal · main ─────────────────────── live · 14:32 ─┐
│  ■ AT RISK    payments touched with no test · 2 docs now behind code    │
│               · 2 files off-plan                                        │
│  Cost         $1,857.55  ·  4 sessions  ·  164h         +$42 this session│
│  Now          step 3 of 6 — subscription-paywall: implement entitlement │
│  Touched      7 features · 23 files               blast radius 7 of 64  │
│  ■ risk       subscription-paywall   payments · 3 files · no test yet   │
│  ▲ drift      recipe-list            code changed, doc 4d behind        │
│               recipe-extraction      code changed, doc 2d behind        │
│  ⊘ off-plan   utils/currency.ts, lib/proration.ts  (not in any step)   │
│  Where it     ingredient-catalog     $599.97  ████████████░░░░░░  32%   │
│  went         subscription-paywall   $237.56  ████░░░░░░░░░░░░░░  13%   │
│               + 18 more                                                │
├─ docs 96%         r review this change     p pause     q quit ──────────┤
```

Calm baseline: same layout; verdict reads `✓ CLEAN — N features touched · docs current · in plan`; the findings rows simply vanish (empty = clean).

Eye-path: **verdict → true total → activity → scope → named findings → where the money went → actions.** Verdict leads; cost is the strong second line.

### Verdict grammar

Headline = the single highest-severity status (ALL-CAPS word + symbol); the gloss enumerates every active finding in severity order.

| Symbol | Status | Color | Means | Fires when |
|---|---|---|---|---|
| `✓` | CLEAN | green | nothing needs you | every touched feature has a current doc, no risk tags, all changes inside approved plan steps |
| `▲` | DRIFTING | amber | look when you can | source changed but its mapped doc did not (doc now behind) |
| `■` | AT RISK | red | look now | a touched feature carries a registry `risk` tag, **or** a shared file fans out past the threshold |
| `⊘` | OFF-PLAN | amber | scope creep | changed files map to no active plan step (in autopilot, a hard pause) |

The **symbol carries the meaning**; color only reinforces (survives screenshots, light/dark, colorblindness). Verdict glyphs (`▲`/`■`) are never reused on the cost line — the live delta reads `+$42 this session`, no arrow-glyph.

### Chosen thresholds (defaults; revisable)

1. **Drift** = source changed without a same-change doc touch (the untouched doc is the trigger; "Nd behind" is context, not the trigger).
2. **Risk** = touching a `risk`-tagged feature is `■` **always**; "no test yet" is an aggravator note, not the trigger.
3. **Shared-infra → `■`** when a file maps to **> 5** features (`highFanout`).
4. **"this session" delta** = cost accrued since `watch` started (not since last commit).

### Honesty rules

- **Cost provenance** — the headline number is the all-sessions total; `· 4 sessions · 164h` is the proof it is complete. The span unit scales with magnitude (minutes → hours → days), so a multi-week project reads `· 31 sessions · 20d`, not `· 487h`. If capture is partial, the label degrades to `$X captured · N of M sessions` with a dim "run backfill to complete" — never a silently-wrong total. (The span is the **calendar range** the sessions cover — first→last captured event, wall-clock elapsed — so it reads as "31 sessions over 30 days" and never exceeds real elapsed time. It is deliberately *not* summed session time, which would double-count overlapping sessions and inflate idle.)
- **Blast radius ≠ coverage** — `blast radius 7 of 64` (features *this change* touches, live) sits on the Touched line; `docs 96%` (registry ownership, the `doctor` number) sits in the footer. Different scope, different place, never the same number.
- **Clean ≠ empty tree** — a `✓ CLEAN` verdict means nothing codument *governs* (source or docs) changed, not that the working tree is empty. When only config/asset files change (e.g. `app.json`, an image), the gloss reads `"N files changed · not source or docs"` — never "working tree clean". The partition is `sources ∪ docs ∪ other ∪ excluded`, so the verdict cannot silently imply an empty tree while real files sit uncommitted — including the last bucket, which is the same false-clean one step further out: a step that edited only its tests has a working tree that is not clean, and the change set had no name for those files until the buckets were made to add up. (Caught dogfooding the verdict frame against a real repo, 2026-06-19; the excluded half a field session later.)
- **Clean ≠ passing, either** — the severity ladder grades whether the DOCS are behind the code, which is a narrower question than whether the gate will let the change through. A finding that blocks `--strict` without being doc drift therefore stays off the ladder and stays *in the gloss*: `unmapped` set that shape, and a registry entry left naming a path the change removed follows it. The verdict model must carry every blocking finding for the same reason the tree partition is exhaustive — a summary omits by nature, so anything it can drop, it eventually will. The costly shape is the quiet one: a deletion whose owning doc was updated leaves nothing else to narrate, so the frame reads as a tidy little change over a tree the gate is refusing. (Caught by the adversarial pass on plan 41, 2026-08-08 — one analyzer is what keeps `review` and `watch` agreeing, but only if the projection carries what the analyzer found.)

## Delivery plan

Status: delivered (2026-06-19).

- [x] Step 1: Live completeness — the feed pumps **all** repo-matching transcripts (not just newest) via `resolveSessionLogs` (per-file `cwd` cache), each from its own byte offset. Fixes the jumping figure and the under-count.
- [x] Step 2: Historical completeness — `backfillFeed` (`codument feed --backfill`) ingests every matching transcript from offset 0, idempotent by turn `uuid` (a `parseSession` skip hook), preserving manual emits and review notes; `--reset` now also discovers all matching sessions. Fixes no-retroactive-pickup.
- [x] Step 3: Verdict model — `src/lib/verdict.ts`: a pure, fully unit-tested `classifyVerdict` mapping `ChangeState` into a verdict + findings per the grammar above (severity selection, the four thresholds, blast-radius vs coverage), plus `costProvenance`/`formatCost`/`isTestFile`.
- [x] Step 4: Verdict-led frame — `renderFrame` in `watch.ts` renders the locked mockup from the verdict model (headline + gloss, all-sessions total + `this session` delta, Now, Touched + blast radius, named findings, where-it-went bars, footer); the cryptic strip and total-first block are gone.
- [x] Step 5: Docs + registry — `token-cost-tracking` updated, `verdict.ts` registered, `last_updated` set, status flipped.

## Acceptance criteria

- With N concurrent sessions in one repo, the total reflects all N and does not change with which window was last active.
- A repo with never-watched historical transcripts can be backfilled to a complete picture in one pass; re-running never double-counts (idempotent by `uuid`).
- No token count is altered relative to the source transcript (verbatim).
- `watch` leads with a plain-words verdict: the highest-severity status as headline, every active finding enumerated in the gloss, named nouns (which docs, which features).
- Cost is a true all-sessions total with provenance (`N sessions · Hh`) and a separate `this session` delta.
- Blast radius (touched / total) renders distinctly from coverage (`docs %`).
- Every verdict is legible from the symbol alone, independent of color.

## Verification strategy

- Unit: multi-transcript discovery + per-file offset advancement (fixture transcripts).
- Unit: idempotency — pumping the same turns twice yields one event per `uuid`.
- Unit: verdict model — each threshold (drift, risk-always, fanout > 5, off-plan), max-severity headline selection, blast-radius vs coverage.
- Unit/snapshot: frame render for clean / drift / risk / off-plan states.
- Integration: fixture project with two+ overlapping-time transcripts → correct aggregated totals.
- Manual: backfill the dogfood repo, confirm the total matches a hand-computed per-session sum.

## Resolved decisions

- Frame layout, verdict grammar, and the four thresholds — defaults chosen (2026-06-19), revisable.
- Backfill trigger → an explicit `codument feed --backfill` (additive, idempotent by uuid); `--reset` rebuilds from all matching sessions and supersedes `--backfill` when both are passed.
- Live discovery → `resolveSessionLogs` re-scans every pump, with a per-file `cwd` cache so idle ticks stay cheap.

## Known limitations

- **Slug collision (low).** Discovery trusts the `~/.claude/projects` slug dir, and the slug maps `/`, `.`, and `-` all to `-`, so paths differing only by those characters (`/repo/a` vs `/repo.a`) would share a dir and conflate. Low real-world frequency; pre-existing, now extended from "newest of the wrong sessions" to "all of them".
- **Single-writer.** `pumpFeed`/`backfillFeed` append without a lock (as the existing log always has), so two concurrent backfills on one repo could double-emit. Fine for the interactive one-shot; a hosted collector would add locking.
- **Drift age deferred.** The drift finding reads "doc not updated" rather than "doc Nd behind"; the day count needs doc-mtime threading into the renderer — a later legibility polish (`DriftFinding.staleDays` is the wired-but-unpopulated seam).
- **Completeness flag latent.** The cost label can degrade to "captured · N of M sessions", but currently always reads complete (the live feed + backfill capture every session); detecting partial capture at render time is a future refinement.
