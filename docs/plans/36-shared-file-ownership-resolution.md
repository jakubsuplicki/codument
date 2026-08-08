---
status: approved
---

# Plan 36: shared-file ownership churn — make the gate's designed fix reachable

The 2026-08-07 Expo-app field report calls multi-owner ack churn "the worst part by far": a
one-line change to a file claimed by three features left three docs stale, no ack could clear the
gate, and the agent paid with prose written into five feature docs — words for their own sake,
exactly what the doc standard forbids. The report concludes "the gate and the standard are in
tension and the gate wins."

Verification confirms the experience and narrows the defect. The tension is real only while
ownership is left unresolved: the designed resolutions exist — per-symbol claims via
`owned_symbols` (ADR 004), or one primary owner plus `related_sources` for wiring files (the
`[secondary: ...]` pattern plan-with-docs' own feature-map syntax documents) — but nothing routes
the agent to them at the moment of the wake, and the ack surface actively misleads. This is a
routing defect, not a design defect; no wake or ack semantics change here.

Verified facts, each checked against source:

1. **A changed symbol on a file in several features' `primary_sources` that no `owned_symbols`
   entry claims resolves `unassigned`, wakes every candidate feature, and files an
   `OwnershipLint`** (`computeChangeState`, `src/lib/change-state.ts`) — fail-loud by design.
   Under ADR 014's single `default.` anchor, every edit to a shared component/config file is such
   a wake: N stale docs per one-line change.
2. **No acknowledgment of any kind clears that wake.** `computeDrift` (`src/lib/drift.ts`)
   consults acks only for anchors that resolve `owned`; an unassigned change passes through
   unfiltered. A file-grain ack skips only added/removed anchors, never a `changed` one
   (`src/lib/change-state.ts`). The only paths to green are touching every candidate doc or
   authoring ownership — and the second path is never named where the agent is looking.
3. **`codument ack <path>::<symbol>` records an ack for an unassigned shared symbol without
   complaint** — the symbol path in `src/commands/ack.ts` never resolves ownership — and prints
   "Re-run `codument review` to confirm the finding cleared." The finding cannot clear: drift
   never consults acks for unassigned anchors. A green checkmark, a red gate, and nothing
   connecting them.
4. **The one signpost is a single dim line** — "Unassigned shared symbols (set owned_symbols in
   the registry)" (`src/commands/review.ts`) — with no paste-ready edit, no statement that acks
   are inert here, and no mention of the `related_sources` demotion.
5. **`map materialize` checks only the target entry** when adding a file to `primary_sources`
   (`src/commands/map.ts`), so the moment a second feature claims a file — the moment the churn
   is created — passes silently.
6. **Field follow-up (2026-08-07, same session interrogated): the signpost failed by placement,
   and the gate's own hint recommended a resolution that cannot work.** The registry paste
   confirmed every contested file was a genuine unassigned shared symbol (multi-primary,
   `owned_symbols` absent — 3 of 32 features declare any). The "Unassigned shared symbols" line
   fired **25 times** and was ignored every time: it prints as a ⚠ advisory *below* the blocking
   `✗ --strict` line, beside genuinely-advisory blocks (high-fanout, dependents), so it read as
   decoration by position. Worse, the stale-docs block's "no doc impact →" hint suggested
   `codument ack <path> --reason "..."` (file-grain) for wakes driven by unassigned *changed*
   anchors — which a file ack can never clear. The agent followed the hint: the contested file
   accumulated two file-grain acks across the run, one already auto-invalidated, and the gate
   stayed red. The hint is generic where it must be computed from what would actually clear the
   wake. Note the field descriptors: the unassigned anchors were `<module>` residuals as often as
   `default.` — the resolution block must handle both.

## Why

- The report's author, asked what to keep, kept the doc standard and condemned this behavior.
  The standard found the bugs; this is the tax that makes people turn the gate off.
- ADR 004 (derived-first, fail-loud shared ownership) and ADR 012 (conservative acks) are working
  as decided. What failed is that every signal fires *after* the wake, none names the fix, and one
  of them (`ack`) claims success it cannot deliver. Fixing the routing keeps the teeth: a real
  contract change on a shared file still wakes its real owner and still refuses laundering.

## Scope

- `src/commands/review.ts` — ownership-lint resolution block
- `src/commands/ack.ts` — ownership-aware refusal with routes
- `src/commands/map.ts` — materialize shared-primary warning
- `skills/work-step/SKILL.md`, `skills/review-work/SKILL.md` + installed `.agents/skills/` copies
- `docs/features/change-control-gate.md`, `docs/.registry.json`, `CHANGELOG.md`
- Tests: `tests/review.test.ts`, the ack and map test files (nearest existing), change-state tests
  only if the no-ack-clears-unassigned invariant lacks a pin

No new source files.

## Non-goals

- **No semantic change to wake or ack resolution.** Unassigned still wakes every candidate
  (under-waking is the failure ADR 004 rejects); file acks still never clear moved symbols
  (ADR 012); signature moves stay non-ackable (ADR 006). Existing wake/ack tests must pass
  unmodified — if one needs editing, the plan's central promise is broken.
- **No auto-assignment of owners.** Picking the owner is exactly the judgment the registry exists
  to record; the tool routes, never decides.
- **No new ownership grain** (a "wiring" entry type, fractional owners). One primary owner plus
  `related_sources` already expresses the field case; new grains are complexity without a
  demonstrated need.

## Decisions (settled)

- **The resolution moves into the failure, not beside it.** Placement is the verified failure
  mode (fact 6), so the fix is structural to the rendering: when a stale doc's wake traces to an
  unassigned shared symbol, the stale-doc entry itself — and the `✗ --strict` failure line —
  names the condition and states that it recurs on every edit until `owned_symbols` is set. The
  detached ⚠ section becomes the detail under the failure, never a sibling advisory. For each
  lint: the candidates, then the two real fixes with paste-ready edits — (a) claim the symbol:
  the exact `owned_symbols` JSON fragment (file + descriptor, `<module>` and `default.` included)
  under the feature the agent picks; (b) the wiring-file fix: keep one feature's
  `primary_sources`, move the file to the others' `related_sources` (impact, never a wake). Plus
  one honest sentence: *no ack — symbol or file — clears an unassigned symbol; do not write doc
  prose into candidates to buy green.* When the file's only moved anchors are `default.` /
  `<module>` (ADR 014's shape), lead with fix (b): claiming the only anchor is file ownership by
  another name.
- **Hints are computed from clearability, never generic.** The stale-docs "no doc impact →" line
  suggests a file-grain ack only when a file ack would actually clear that file's contribution
  (additive/concept/coarse). A wake driven by unassigned changed anchors gets the ownership fix;
  an owned body-move gets the per-symbol ack; a signature move gets the doc-contract route. The
  gate must never again print a command that cannot clear the finding it is printed under
  (fact 6: two dead file acks accumulated following today's hint).
- **`ack <path>::<symbol>` becomes ownership-aware** — the same refuse-and-route stance as the
  signature-move refusal. Resolve the anchor's owner first: `unassigned`/`ambiguous` → refuse,
  print the resolution block, write nothing; `unowned` but under a concept umbrella → refuse,
  route to `codument ack <path>` (file grain is what clears a concept wake); fully unowned →
  say nothing gates this symbol. The `owned` path is byte-unchanged. No registry → today's
  behavior (nothing gated, nothing refused).
- **`map materialize` warns — never refuses** — when the routed claim creates a second-or-later
  primary owner and no candidate's `owned_symbols` covers the path: name the existing owners, the
  two fixes, and the `[secondary: ...]` row syntax. A deliberate split with claims authored stays
  un-warned.
- **Skills teach the rule once**: in `work-step` and `review-work`, an unassigned-shared-symbol
  report is a registry fix, not a docs fix; prose written into non-owning candidate docs to clear
  a wake is the mirror-edit failure the ack protocol exists to prevent.
- **The invariant is documented and pinned**: `docs/features/change-control-gate.md` gains "an
  acknowledgment is consulted only for a symbol with a resolved single owner; recording one
  against an unassigned shared symbol is refused with the resolution routes," linked to the new
  tests.

## Delivery Plan

- [x] **Step 1 — Resolution inside the failure.** Wire `ownershipLints` into the stale-doc
      entries and the strict failure line (recurs-until-set wording); build the resolution detail
      (paste-ready `owned_symbols` fragment covering `<module>`/`default.`, the `related_sources`
      alternative, the no-ack sentence, demotion-first lead for single-anchor files); compute the
      "no doc impact →" hint from clearability. Tests: golden output for unassigned and ambiguous;
      single-anchor vs multi-anchor lead; the file-ack hint absent when a file ack cannot clear
      the wake, present when it can.
- [x] **Step 2 — Ownership-aware ack refusal.** Resolve the owner on the symbol path;
      refuse-with-route for unassigned / ambiguous / concept-owned / unowned; `owned` unchanged.
      Tests per branch, including "refused ⇒ no ack file written" and "no registry ⇒ unchanged".
- [x] **Step 3 — Materialize shared-primary warning.** Warn on creating a second primary owner
      absent `owned_symbols` coverage. Tests: fires on the second claim; silent on the first
      claim, on secondary rows, and when claims already cover the path.
- [ ] **Step 4 — Skills + docs.** The shared-file rule into `work-step` and `review-work`
      (mirror installed copies), the invariant + test links into `change-control-gate.md`,
      CHANGELOG, registry entries checked for every touched source.

## Acceptance criteria

- The field scenario replayed — a one-line edit to a component file in three features'
  `primary_sources`, `owned_symbols` absent — fails with the ownership condition named on the
  strict failure line itself and both paste-ready fixes inside the stale-doc entry; no output
  anywhere suggests an ack that cannot clear the wake; `codument ack` on that symbol refuses
  with the same routes instead of "✓ acknowledged".
- After applying either fix, the same edit wakes exactly one feature and one per-symbol ack (or
  one doc line) clears it — churn gone with wake semantics untouched, proven by existing
  change-state/drift tests passing unmodified.
- `npm run typecheck`, `npm run build`, `npm test` green; `codument review --strict` green at
  every commit.

## Verification strategy

- Unit: rendering-block branches; ack-refusal branches (no file written on refusal); materialize
  warning matrix.
- Regression: every existing wake/ack semantics assertion passes unmodified — this plan changes
  no verdict.
- End-to-end: scripted replay of the field scenario before and after the ownership fix.
