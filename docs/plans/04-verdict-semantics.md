---
status: approved
---

# Plan 04: Verdict semantics — deletions, umbrella acks, approval, plan scope

Four confirmed correctness holes in what the deterministic verdict actually says, as opposed to how
it fails (Plan 03).

## Why

Verified findings this plan fixes:

1. **Deleting an owned source file never marks its doc stale.** Pure deletions are dropped by both
   change listers (`src/lib/git.ts:113-115,134`; `src/lib/two-ref.ts:222-224,236`), and
   `gatherAnchorChanges` skips unreadable files (`src/lib/fingerprint.ts:181`), so a deleted
   registered primary source produces `staleDocs: []` and `review --strict` exits 0 with "Working
   tree clean" (reproduced live). The deletions-first-class machinery is already written with zero
   production callers: `changedPathsBetween` (`two-ref.ts:170`) and the all-anchors-removed branch of
   `changedAnchorsAgainstWorktree` (`fingerprint.ts:129-144`). A comment at `two-ref.ts:223-224`
   claims the gate "handles deletions first-class separately" — currently false. Notably `codument
   ack` on a deleted file already refuses ("a removed file needs doc attention, not a file ack",
   `src/commands/ack.ts:176`) — the design intent exists, unenforced. Doctor's missing-source lint
   is the only backstop and goes quiet if the registry entry is removed in the same commit.
2. **A per-symbol ack silently clears the concept umbrella's verdict.** `computeDrift` drops an
   acked change but keeps the now-empty file key (`src/lib/drift.ts:45-49,121-123`); change-state
   gates concept wake on `precise.length > 0 && !acked` (`src/lib/change-state.ts:272`), so the
   empty array wakes nothing. Reproduced live: file owned by feature `widget` AND concept `lib`;
   one symbol moved → both stale; `ack src/util.ts::widget().` (reason vouching only for the feature
   contract) → `staleDocs: []`. Contradicts the comment at `change-state.ts:270-271` and ADR-012's
   rule that clearing concept residue requires a FILE-grain ack.
3. **`isApproved` matches "not approved".** `src/lib/plan-steps.ts:96-98` tests `/\bapproved\b/`, so
   a plan with `Status: not approved` is returned by `findActivePlans` and rendered by
   `codument steps` as THE active plan (reproduced live) — the exact signal the workflow's approval
   gate and autopilot precondition key off. Separately there are two divergent predicates: the
   scope gate's `isApprovedPlan` (`src/lib/change-state.ts:460-464`) requires literal
   `status: approved` in frontmatter, so `Status: **approved**` passes steps but never enables
   out-of-plan detection — steps and review can disagree about the same plan.
4. **Root-level files can never be in plan scope.** `parseScopeSection` keeps only backticked paths
   containing `/` (`change-state.ts:480-482`), so a plan legitimately scoping `cli.ts` or
   `package.json` permanently flags those edits out-of-plan (an autopilot hard-pause trigger). Also
   when multiple approved plans exist, the first by filename silently wins
   (`change-state.ts:444-457`).

## Scope

- `src/lib/change-state.ts`
- `src/lib/drift.ts`
- `src/lib/plan-steps.ts`
- `src/lib/fingerprint.ts`
- `src/lib/two-ref.ts`
- `src/lib/git.ts`
- `src/commands/review.ts`
- `src/commands/steps.ts`
- `tests/gate-wiring.test.ts`
- `tests/plan-steps.test.ts`
- `tests/two-ref.test.ts`

## Non-goals

- No new ack kinds and no ADR-012 change — this *enforces* ADR-012, not amends it.
- No rename detection (`-M`); a rename stays delete+add at this layer.
- No multi-plan orchestration; multiple approved plans just stop being silent.

## Decisions (settled)

- Deletions enter `computeChangeState` as a first-class change: a deleted owned path wakes every
  primary owner at file grain (synthesized all-anchors-removed entries via the existing
  `changedAnchorsAgainstWorktree` branch where content is needed, or an explicit `removed` status on
  the change input). Resolution is a doc update (or registry removal *plus* doc update) — per-symbol
  acks stay refused; whether a file-grain ack may clear a deletion follows ADR-012's conservative
  stance: it may not.
- Concept umbrellas wake off the ORIGINAL (pre-ack-filter) anchor set: if the file's content moved,
  only a file-grain ack (or a doc update) clears the concept's flag.
- One shared approval predicate in `plan-steps.ts`, used by both consumers: markdown-stripped status
  must equal `approved` exactly. `extractStatus` already strips emphasis — reuse it in
  `change-state.ts` instead of the local regex.
- Scope accepts root-level backticked filenames when they carry a source-like extension. Multiple
  approved plans: `review`/`steps` print a one-line warning naming all of them and which one won.

## Delivery Plan

- [x] Step 1: Wire deletions into the change flow (worktree and `--base` paths), wake primary owners
      file-grain, and make `--strict` fail on a deleted-owned-source with an unchanged doc. Fix the
      false comment at `two-ref.ts:223-224`. E2E tests: delete a mapped primary source →
      staleDocs fires + `--strict` exits 1; registry-entry-removed-in-same-change still flags the doc.
      (Shipped additions: deletion ownership resolves against the BASE registry read with honest
      absence semantics — a broken git read fails loud, never a silent fallback that would re-open
      the dodge; the gate doc's deletion invariant also landed here rather than waiting for Step 5.)
- [x] Step 2: Fix the concept-umbrella wake (`change-state.ts:272` keys off the pre-filter set +
      file-grain-ack check). Golden tests per ADR-012: symbol ack clears the feature but NOT the
      concept; file-grain ack clears the concept residue.
- [x] Step 3: Unify the approval predicate (exact-match after stripping), share it between
      `plan-steps.ts` and `change-state.ts`. Tests: "not approved" / "never approved" are not
      approved; `Status: **approved**` is approved for BOTH steps and scope detection.
- [x] Step 4: Scope parser accepts root-level files; warn on multiple approved plans in `steps` and
      `review` output. Tests for both. (Shipped shape: `review` warns naming all contenders + the
      winner; `steps` already refused multi-plan ambiguity by name, which is stronger than a warning,
      so it kept its refusal.)
- [ ] Step 5: Update `docs/features/change-control-gate.md` invariants (the deletion invariant
      itself landed with Step 1; sweep what Steps 2-4 add) and `docs/plans/README.md` (drop the
      root-level-scope caveat).

## Outcome

The verdict now answers the whole question: deleting code wakes its doc exactly like changing it; an
ack clears only what its signer actually adjudicated; an explicitly rejected plan can never drive
the workflow; and plans can honestly scope root-level files. What it does NOT do: detect renames as
renames (a rename is a deletion-wake plus an unmapped-add, both loud), or arbitrate between multiple
approved plans beyond naming the winner.

## Acceptance criteria

All four "Why" reproductions produce the corrected behavior; the ADR-012 golden table covers the
umbrella cases; `steps` and the scope gate agree on approval for every status spelling in the tests.

## Verification

`npm test`; `npm run typecheck`; live: the deletion, umbrella-ack, and not-approved reproductions in
a scratch repo; dogfood `codument review --strict` on this repo stays green.
