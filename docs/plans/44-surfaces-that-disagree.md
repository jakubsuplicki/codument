---
status: shipped
---

# Plan 44: the surfaces disagree with each other, and the loop pays for it

The remainder of the 2026-08-09 Expo field report, after plans 42 and 43. What is
left is one shape seen three times: **two surfaces of the same tool answer the same
question differently, and the user is the one who finds out.**

Approved by the user's standing instruction to keep going until every field-report
finding is fixed; the steps below were verified live against this repository before
being written, not taken from the report on trust.

Verified mechanisms, each reproduced against the code:

1. **The changed-file headline does not sum.** The total counts every changed path;
   the buckets beside it (`source`, `docs`, `governed`, `other`, `deleted`) each drop
   what the exclusion spec excludes. So editing a test file — the single most common
   thing a step does — produces `8 changed file(s): 7 source, 0 docs`, and the reader
   is left to wonder which file the gate is not telling them about. Reproduced on this
   repository during plan 43: every step's own review printed it.
2. **`steps` and `map` cannot see a plan `review` reads.** Plan discovery is over
   `docs/features` and `docs/concepts`; approved-plan scope detection is over
   `docs/plans`. A repository that keeps plans in `docs/plans` — as this one does, and
   as the plans README documents — has `codument steps` and `codument map materialize`
   refusing with "no approved plan", while `review` reports that same plan's scope in
   its headline on the very next line. Both refusals are reachable from the skills'
   own instructions, so the documented loop instructs a command that refuses.
3. **A registry pointing at a vanished file is invisible to the gate.** `doctor` calls
   it `missing-source`. `review --strict` never mentions it. The registry is the
   control plane every other answer derives from — ownership, context packs, the
   adversary's grounding all read it as truth — so a pointer at a file that does not
   exist quietly corrupts all three, and the surface the loop runs on every step says
   nothing. Plan 41 closed this for a pointer THIS CHANGE created (a rename); one that
   rotted earlier stays silent forever, and until plan 42 the loop never ran `doctor`
   at all.

## Why

- All three are the same failure as the field's headline complaints: not a wrong
  answer, but a surface that knows something and does not say it. A count that does
  not add up teaches the reader to stop reading the line; a refusal reachable from
  the tool's own instructions teaches them the instructions are wrong; a control
  plane nothing checks is the assumption every other answer rests on.
- Two of the three cost nothing but a line of output. The third is the one with a
  judgment in it, and the judgment is where the plan is careful: naming a
  pre-existing registry rot is right, and failing a gate over it is not — that would
  block a repository on a defect the change did not cause.

## Scope

- `src/commands/review.ts` — the headline arithmetic, and the registry-integrity
  advisory
- `src/lib/change-state.ts` — the excluded-change bucket the headline is missing
- `src/lib/plan-steps.ts` — plan discovery reads the same directories the gate does
- `docs/features/change-control-gate.md`, `docs/features/agent-delivery-workflow.md`,
  `CHANGELOG.md`

## Non-goals

- **No new blocking condition.** A rotted registry pointer is reported, never gated:
  the change did not cause it, and a gate that fails on inherited state is a gate
  people turn off. `--strict` inputs are unchanged.
- **No move of where plans live.** Both directory conventions keep working; what
  changes is that every surface reads all of them.
- **Not the review-bundle delta.** The report's claim that a delta named a file that
  did not move could not be reproduced from the code, and a fix written against an
  unreproduced claim is a guess. It stays open, named as unreproduced.
- **Not the doc-lifecycle findings** (delivery scaffolding never compacted, the
  Decisions layer without evidence, orphan prose pages). Each needs a decision about
  which trees are expected to be owned, which is a plan of its own.

## How it landed

One commit rather than four. The three fixes are a bucket, a directory list and a
report — one-line changes in unrelated files with no interaction between them — so
they were implemented, reviewed and mutation-checked together rather than gated
apart. Recorded here because the step gates say otherwise and the deviation is the
kind that should be visible rather than inferred.

One thing grew. `watch`'s verdict gloss carries the same false-clean the headline
did: a step that edited only its tests read as "working tree clean", because the
change set had no name for those files. The bucket that fixed the headline is what
made the sibling fixable, and the codebase's own rule is to guard the shared path
once and check the callers it implies.
