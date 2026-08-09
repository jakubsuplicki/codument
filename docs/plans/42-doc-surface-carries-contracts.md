---
status: approved
---

# Plan 42: the doc surface carries contracts — stop compelling the mirror, then flag it

Findings 1–3 and 10 of the 2026-08-09 Expo field report. The session's own confession is the
spine of this plan: asked which prose it wrote mainly to clear the gate, the agent named two
edits, and the clearest of them was maintaining a `type` union **verbatim inside a fenced code
block** in `docs/concepts/types.md` — a symbol mirror the documentation standard forbids writing,
kept fresh by hand because the gate went red and no ack was available.

That is the product inverted. The gate exists to stop docs rotting into a symbol mirror; here it
compelled one, and the lint that names that smell could not see it.

Verified mechanisms, each checked against source:

1. **A type alias or interface has no ack route at all, by construction.** Plan 10 settled that
   "type aliases/interfaces: the whole declaration is signature (no body)" and that a moved
   signature refuses both the per-symbol and the file-grain ack. The two are individually sound
   and jointly total: a symbol with no body can never have a body-only move, so *every* edit to
   a types file is unackable and every owning doc owes prose every time. The field's
   `types/setting.ts` is owned by two entries; one union gaining three members billed both.
2. **The stale-doc route prints a file ack without consulting drift.** In `review.ts` the
   `no doc impact →` line is emitted for every changed source that is not already in the drift or
   unevaluable sets and is not ownership-blocked; it never asks whether a *resolved* owned symbol
   in that file moved in a way a file-grain ack cannot clear. The field agent pasted that exact
   printed command twice and both times got `⚠ 1 moved symbol(s) here are NOT cleared by a file
   ack`. Plan 36 fixed this reasoning for the ownership block and left the neighbouring block on
   the old footing.
3. **The instruction that would have worked is a dim footnote.** `Body-only moves: update the
   owning doc, or codument ack <path>::<symbol> each.` renders last, dimmed, below the warning and
   below the "Re-run" advice, and it names a pattern rather than the command. The agent read past
   it in step 2, rewrote a doc instead, and only obeyed it in step 3 — the same placement defect
   plan 36 was written for, one surface over.
4. **`symbol-mirror` deliberately exempts code fences.** `registry-health`'s invariant pins the
   near-miss behaviour — a fenced block never fires the smell — which is right for the illustrative
   examples codument's own docs are full of, and leaves the purest mirror there is unjudged. No
   lint anywhere reads fenced content against the source it reproduces.
5. **Nothing in the delivery loop ever runs `doctor`.** The field session ran the review family 37
   times across 5 commits and `doctor` zero times; it stood at 140 findings and exit 1 the whole
   engagement, including a `path-enumeration` on a doc that session had just edited. Plan 41 named
   this same seam for `missing-source` and fixed it only for that finding.
6. **A scaffold never ages.** `registry-health` exempts a `needs-review` entry from the dependency
   ratio and from `empty-depends-on` so a fresh scan opens green — reasoning that says "seconds-old"
   and is implemented as "forever". The field's `i18n` entry has been `needs-review` since its scan
   on 2026-03-30, invisible to every ratio, and `lastScan` still records the 292 source files of
   that day against today's 404.

## Why

- The confessed mirror is the worst outcome this product can produce. A gate that makes an honest
  agent write junk to go green does not merely fail to help — it manufactures exactly the rot it
  was bought to prevent, and it does so under the authority of a green check.
- The docs are the adversarial reviewer's oracle: the bundle carries each touched feature's
  `In plain terms`, its `Invariants & boundaries`, and the tests those invariants cite. Docs padded
  with mirrors and empty of invariants make the review generic, which is the whole reason a field
  user reads the reviewer as the only part that works. Doc quality is not a nicety beside the gate;
  it is the gate's product.
- Findings 1–3 are one defect wearing three faces: the resolution surface tells the reader to write
  prose in cases where prose is not the fix. Fixing them apart would leave the reader taking three
  different wrong turns to the same junk edit.

## Scope

- `src/lib/prose-altitude.ts`, `src/lib/analyze.ts` — a `fenced-mirror` smell: a fenced block in a
  registered doc reproducing a registered source's declaration
- `src/commands/review.ts` — the stale-doc `no doc impact` route consults drift; the
  signature-denial line names the real fix
- `src/commands/ack.ts` — paste-ready per-symbol commands, above the warning, not below it
- `src/commands/scan.ts` — `lastScan` refresh; scaffold-age disclosure
- `src/lib/scaffold.ts` + installed skill copies — `doctor` enters the loop at plan completion
- `docs/features/change-control-gate.md`, `docs/features/registry-health.md`,
  `docs/concepts/doc-audience-layers.md`, `docs/features/agent-delivery-workflow.md`, `CHANGELOG.md`

No new source files — no feature map.

## Non-goals

- **No semantic API-compatibility analysis.** Plan 10 ruled this out and it stays ruled out: no
  co/contravariance, no overload resolution, no "is this change breaking". Anything this plan reads
  about a signature is a token span, judged lexically.
- **No reversal of plan 10's principle.** A contract change still wakes its doc with no ack relief.
  This plan changes what the gate *says* when it denies, and — if the open question resolves that
  way — recognises one lexically-decidable class that was never a contract change.
- **No `doctor` in the per-step gate.** It is repo-wide hygiene; making every step pay for an
  adopting repo's old debt is the failure plan 41 avoided deliberately.
- **No auto-repair of a registry holding excluded paths.** That is finding 6 and belongs to plan 44.
- **No change to `symbol-mirror`'s prose reading or its tested near-misses.** The new smell is a
  separate id with its own soak, exactly as `registry-health` requires of every altitude heuristic.

## Decisions (settled)

- The new smell is `fenced-mirror`, its own id, **info-only in the Notes channel**, never moving
  `--strict`'s exit code — the same contract every prose-altitude heuristic ships under, so its
  false-fire rate can be soaked independently before anyone argues for promotion.
- It fires only where the claim is checkable: a fenced block inside a **registered** doc whose
  content matches a declaration in one of that entry's own sources, compared through the same
  language adapters the gate uses. A fence with no counterpart in the entry's sources is an
  illustration and stays silent.
- The stale-doc route and the ack surface share **one** predicate for "can a file-grain ack clear
  this file", derived from drift. Two copies of that judgement is how these two surfaces came to
  disagree in the first place.
- Every command the gate prints is paste-ready with its arguments filled in. A printed pattern the
  reader must assemble is not a resolution, and `<path>::<symbol>` was read past twice.
- `doctor --strict` runs once at **plan completion**, in `commit-work` when the last step is checked
  off — not per step. It reports; it does not gate.

## Open questions

1. **What does the gate offer when a type alias or interface changes?** Today: nothing — no body,
   so no ackable move, so prose forever. *Recommended:* keep the denial and fix the message to name
   the two real fixes (delete the mirror the doc is carrying; or move the symbol to the entry that
   owns it), and add nothing to the fingerprint. The alternative — recognising an append-only token
   span (a union gaining a member, an enum gaining a variant) as a widening that stays ackable — is
   lexical rather than semantic so it does not breach plan 10's non-goal, but it is a fingerprint
   change with an algoStamp bump and it invalidates every recorded ack. I would not spend that yet:
   the field's harm came from the *message*, not from the denial.
2. **Does `fenced-mirror` fire on a fence in a plan doc?** *Recommended:* no — plans are transient
   and quote real signatures for good reason. Registered feature/concept docs only.
3. **How does a stale `needs-review` become visible without punishing a fresh scan?** *Recommended:*
   disclose rather than score — `doctor` names how many entries have been `needs-review` since a
   scan older than the current one, beside the coverage headline, as info. No exit-code change, so
   the "first run ends green" invariant holds byte-for-byte.

## Delivery Plan

Status: approved.

- [x] Step 1: `fenced-mirror` in `prose-altitude.ts` — a fenced block in a registered doc matched
      against declarations in that entry's own sources through the gate's adapters; info-only,
      wired into doctor's Notes channel. Tests: fires on the field's verbatim-union shape, silent
      on an illustrative fence, silent on a CLI-output fence, silent on a fence whose content
      matches nothing the entry owns, and `--strict` exit unchanged.
- [x] Step 2: One shared "a file ack cannot clear this" predicate over drift; the stale-doc
      `no doc impact` route consults it and prints the per-symbol commands instead of the file one
      when it applies. Test: the field's exact shape — a body-only module move under a stale doc —
      no longer prints a file ack, and the printed command clears the finding.
- [x] Step 3: `ack` prints paste-ready per-symbol commands above the warning, not a dim pattern
      below it. Test: every command in the output runs as printed and clears what it names.
- [ ] Step 4: The signature-denial names the two real fixes (per open question 1). Test: a type
      alias change under two owning entries prints a route that resolves without prose.
- [ ] Step 5: `doctor --strict` at plan completion in `commit-work`; `scan` refreshes `lastScan`;
      `doctor` discloses long-stale `needs-review` entries as info beside the headline. Test: the
      first-run-ends-green invariant holds byte-for-byte.
- [ ] Step 6: Docs at intent altitude — `change-control-gate` (the resolution invariant extended to
      the ack surface), `registry-health` (the new smell and the disclosure), `doc-audience-layers`
      (fenced mechanism is mechanism), `agent-delivery-workflow` (doctor's cadence) — and CHANGELOG.

## Outcome

Once every step lands:

- **The gate stops manufacturing junk.** No printed resolution recommends prose where prose is not
  the fix, and no printed command half-fails after you run it. Every command the gate prints is
  paste-ready and clears what it names.
- **A mirror that does get written is visible.** A doc carrying a source declaration verbatim in a
  fence is reported by `doctor`, where today nothing reads it — closing the gap that let the field's
  clearest confessed mirror sit unjudged in a registered concept doc.
- **The loop looks at repo health once per plan.** A project no longer runs 37 gate invocations
  without ever seeing that its own health surface stands at 140 findings, and a registry scaffolded
  months ago stops reading as freshly in-flight.

What this deliberately does not do:

- It does not make signature changes ackable, and it does not judge whether an API change is
  breaking. A contract change still wakes its doc with no relief; only the wording of the denial
  and the routes it names improve.
- It does not clean up an adopting repo's existing docs. `fenced-mirror` is info-only and will
  report a backlog on any mature project without failing anything — deliberately, since a lint that
  blocks on the day it ships trains people to silence it.
- It does not govern locale trees, repair a registry holding excluded paths, or fix the changed-file
  arithmetic. Those are plans 43 and 44.

## Acceptance criteria

- No output anywhere recommends an ack that cannot clear the wake it is printed under, and no output
  denies an ack where one would work — held in **both** directions, across the ownership block, the
  stale-doc route, and the ack command's own output.
- Every command the gate or `ack` prints is paste-ready and, run verbatim, clears the finding it was
  printed under or explains in the same breath why it cannot.
- A registered doc reproducing one of its own sources' declarations in a fence is reported by
  `doctor` as info, and no illustrative fence in codument's own docs fires it.
- `codument doctor --strict` on this repo does not regress: the pre-existing `bloated-doc` count is
  unchanged and no new actionable finding appears.
- The recommended first run (`init → scan → doctor --strict`) still ends green, byte-for-byte.

## Verification strategy

- Red-green per step, with a mutation check on each new test: break the fix, prove the test bites.
- Replay the field's three exact shapes as golden tests — the fenced union in a shared types file,
  the body-only module move under a stale doc, and the twice-pasted file ack.
- Full suite on Windows against the known 31 pre-existing failures; `codument review --strict` green
  before each commit.
