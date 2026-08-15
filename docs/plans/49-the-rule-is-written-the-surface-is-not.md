---
status: approved
---

# Plan 49: the rule is written, the surface is not

The 0.18.0 field report is ten findings, every one verified against source and each survived an
independent attempt to refute it. None is a regression from 47 or 48; most predate both. What makes
them worth one plan rather than ten fixes is that **codument has already written down every rule it
is breaking here**, usually in a comment a few hundred lines from the violation:

- `src/commands/review.ts:1239` — *"`| tail -1` delivers this line and destroys the rest, so anything
  reachable ONLY above it is, in practice, unreachable"*. The confirm-step warning is printed only
  above it (`review.ts:1332`).
- `src/commands/doctor.ts:652` — *"Rendering them identically is what made the whole surface
  unreadable at the one moment it had something new to say"*. Written for warnings; notes never got
  the treatment and now run to 268 lines.
- [ADR 018](../architecture/decisions/018-a-registry-entry-can-govern-a-tree.md) — *"A wake per file
  trades a silent surface for an unreadable one, which is how a gate gets disabled."* `unread-owned`
  is emitted once per file with the whole remedy re-inlined.
- `src/commands/ack.ts:820` — already records the dead-ack field pattern by name, and nothing sweeps.

So this is not a design argument. It is the gap between a rule this repository has decided and the
surface that does not obey it.

## The field session, stated plainly

One session, one commit, eleven CLI invocations. What the tool reported:

> ⚠ confirm step could not run: no local tsx …
> ✓ Adversarial review covers this diff (1 advisory)

What actually happened: two adversary runs costing sixteen minutes produced **one** artifact, because
the second `--record` wrote to the same filename as the first and overwrote it — no existence check,
no warning. The ten invariants the first adversary checked are gone. `--require-review` then passed
against the seven-invariant remnant, which is bound to the **post-fix** tree and therefore certifies
code no adversary ever attacked, re-printing two phantom findings as live advisories against
conditions that no longer exist. The confirm runner never ran either time.

Three success messages, and no enforcement anywhere in the sequence.

## Verified mechanisms

Each reproduced against source at both `v0.18.0` and HEAD; each survived an independent refutation
attempt. Ordered as the plan attacks them.

**Delivery — the reader never receives it.**

1. **doctor's notes are an unbounded flat list.** `analyze.ts:1088-1105` emits `unread-owned` once
   per (entry × source) with the full ~250-character remedy re-inlined at `:1102`;
   `doctor.ts:671-681` renders `lint.notes` in a loop with no grouping, cap or dedup. Reproduced on
   a **100%-coverage, zero-finding** fixture: 268 notes, **68,420 characters**, 96.7% of it 262
   repetitions of six distinct strings. Warnings received the readability split at `doctor.ts:646`;
   notes were never given it.
2. **The could-not-run condition cannot reach the line a pipe keeps.** `confirmUnavailable` has one
   print site (`review.ts:1332`) and is never pushed onto `alsoTrue` (`:1248-1275`), the array that
   composes the trailing `·` segments. Worse, the two are **mutually exclusive by construction**: the
   "no local tsx" wording fires only when `causes.length === 0` (`review-confirm.ts:305`), i.e. when
   nothing was unadjudicated, while the verdict-line disclosure fires only when `unjudged > 0`. In
   the field's exact shape no disclosure could ever have survived the pipe.
3. **`emit review` prints nothing on success.** `emit.ts:59-73`'s only console call is in the catch;
   siblings `ack` (`ack.ts:397`) and `review --record` (`review.ts:842`) both confirm with a `✓`. The
   reporter told their user the findings were logged without any evidence that they were.

**Attestation — the artifact does not mean what it says.**

4. **A recorded review is silently destroyed by the next one.** The filename is
   `sha256(diffFingerprint)[:16]` (`review-artifact.ts:294`) and `writeReview` (`:331`) has no
   existence check, no warn, no refuse. Two records over an unchanged change set collide — and
   `tests/review-artifact.test.ts:156` currently *asserts* that a different signer produces the same
   filename. The reporter's stated trigger was wrong in a way that makes it worse: differing sources
   move the fingerprint and produce two files, so the collision needs the change set to be
   byte-identical, which is the ordinary shape of record-fix-rerecord.
5. **An artifact can certify a tree the reviewer never saw.** `--record` fingerprints the tree at
   record time (`review.ts:826`) and `parseFinding` never resolves a `citation` against content
   (`review-artifact.ts:86-100`), so recording pre-fix findings after applying the fixes mints a
   valid, gate-passing artifact over unattacked code. (The reporter's `scope: full` inference is a
   red herring — that is the correct documented fallback at `review.ts:776`.)
6. **The verdict says "covers" over zero adjudications.** `unjudged` counts only findings whose named
   test was attempted (`review-gate.ts:159`); a `failingTest: null` finding carries
   `testOutcome: null` (`review-confirm.ts:117`) and lands in neither bucket. The verdict branches on
   `unjudged > 0` (`review.ts:1341`) and never on `adjudicated === 0`, which is computed and never
   read. The gate never asks whether the runner **could** have run. Test-locked at
   `tests/review.test.ts:781`. Declaring any `testCommand` suppresses even the ⚠ line, so a fully
   green "covers this diff" over zero adjudications is reachable.
7. **The fingerprint does not bind the oracle.** `computeRealChange` (`review.ts:1312`) filters out
   `docs/**.md` and every conventionally-named test, and only tests a finding *names* are folded in
   (`review-artifact.ts:256`). The documented invariants the adversary attacked can be rewritten
   wholesale after recording and the gate still says covered.

**Scope and placement — the check exists and cannot reach.**

8. **A new file beside eleven governed siblings is structurally invisible.** Scope is decided by the
   hardcoded `DEFAULT_EXCLUSION_SPEC.extensions` (`exclusion-spec.ts:104`), which
   `analyze.ts:106-109` explicitly forbids config from widening — **not** the project's
   `sourceGlobs`, which only writes agent-rule frontmatter (`detect.ts:21`). Every unowned-file
   signal derives from that set, so `.html` can never produce `unmapped-source`; the new mockup
   landed in `otherChanged` (`change-state.ts:394`) and nowhere else. There is no sibling or
   neighbour inference anywhere in the tool.
9. **The pin check is real and out of the loop.** `invariant-check.ts:267` classifies a cited-but-
   missing test as `invariant-unpinned` and `--strict` fails on it — but `runInvariantCheck` is
   imported only by `doctor.ts`, and `review.ts` (`:906`) gates on unmapped/stale/pointers alone. On
   top of that the parser only scans inside `*( … )*` spans (`:159`), so the reporter's bare-prose
   "both are pinned by X.test.tsx" degrades to `untested` and slips even the opt-in flag.
10. **Dead acks are inert but unswept.** `pruneAcks` has exactly one caller — the `--prune` flag
    (`ack.ts:205`) — advertised only in `ack --list` (`:828`), a screen the loop never routes anyone
    to; doctor's lint catalog has no ack finding at all. Proven inert: coverage requires an exact
    from+to match (`acknowledgment.ts:187`), so a dead ack can never mask a live one.

## Scope

- `src/lib/analyze.ts`, `src/commands/doctor.ts` — bounded rendering, the sibling signal, the ack lint
- `src/commands/review.ts` — the verdict line, the verdict wording, the record guards
- `src/lib/review-artifact.ts`, `src/lib/review-gate.ts` — artifact identity, oracle binding, adjudication
- `src/lib/review-bundle.ts` — the stamp a record must answer
- `src/lib/invariant-check.ts`, `src/lib/change-state.ts` — pin resolution in the gate's own path
- `src/commands/emit.ts`, `src/commands/ack.ts` — the confirmation, the sweep

No Feature Map: every change lands in an already-registered file. Step 1's grouping belongs in the
finding *emitter* rather than a renderer — `unread-owned` should be produced once per entry instead
of once per file, which fixes the `--json` contract as well as the screen — so no shared helper is
owed. If a step nonetheless introduces a file, it is mapped then rather than guessed at now.

## Delivery Plan

Status: approved (2026-08-15) — all eleven steps, shipping as one release (0.19.0); open question 1
answered against the recommendation, deliberately. Every step below was contested by an
independent adversarial pass against the committed invariants it changes; 24 objections came back,
11 of them serious, and the steps are what survived. Where a step is narrower than the finding it
answers, the objection that narrowed it is named.

- [x] **Step 1 — doctor groups, and never drops.** Group `unread-owned` and every repeated note kind
  by the entry whose remedy they share, say the remedy once, and name every file inside the group.
  Grouping alone collapses the field's 268 notes, because 262 of them are repetitions of six strings
  — so there is **no cap**, and nothing goes unnamed. `--json` stays per-file and byte-identical: the
  versioned machine contract does not move. *(Contested: a cap would stop naming blind owned files,
  which is the one thing that finding exists to do; regrouping the emitter would break a versioned
  contract whose every prior change was additive.)*
- [x] **Step 2 — the line a pipe keeps carries every actionable condition, and is itself bounded.**
  Push `confirmUnavailable` onto `alsoTrue` — the print site only. The shared `confirmCondition`
  precedence stays exactly as it is, and so does its `doctor` parity. Then bound that line the way
  step 1 bounds doctor: fixed priority order, counted remainder. Pin the rule with a test, not with
  care. *(Contested: loosening the builder's per-cause precedence would start telling projects with
  their own runner about codument's tsx probe, and an unbounded verdict line recreates the wall step
  1 removes.)*
- [x] **Step 3 — a command that changed state says what it recorded.** `emit review` echoes the tier,
  resolution and label it wrote, marked as self-reported — not a codument verdict over an agent's
  claim about its own work. *(Contested: a bare green tick over a self-reported fix is a fourth
  success message of the kind this plan exists to remove.)*
- [x] **Step 4 — no attestation is ever silently destroyed.** Key the artifact on what it attests —
  `invariantsChecked` and signer included, not the diff alone. Named tests are already folded into
  the fingerprint, so keying on findings alone would still have destroyed the field's own record:
  what it lost was ten checked invariants, not ten findings. Two genuine reviews of one change set
  become two files, and the gate enforces every matching artifact's findings rather than an
  arbitrary one.
- [ ] **Step 5 — an attestation discloses what it was grounded in.** `--bundle` stamps what it handed
  over; `--record` records the stamp it answers, or records that there was none. An unstamped review
  is **disclosed, never refused** — on the line a pipe keeps. *(Contested, and this is the objection
  that changed the step most: refusing would dead-end the first review of any diff, whose own printed
  route never mentions `--bundle`, and would be bypassable by deleting one untracked file under a
  directory the change-state cannot see. A guard that only binds the honest actor is not a guard.)*
- [ ] **Step 6 — the verdict says whether the runner could have adjudicated anything.** Not "zero
  adjudications": an empty review and a judgment-calls-only review legitimately *do* cover, that was
  decided deliberately with a cries-wolf rationale, and two tests lock it. The missing fact is
  **runner availability**, which never enters the verdict at all — and is not even probed when a
  project declares its own `testCommand`, so the surface that most needs it is the one with no signal
  to give. Probe the resolved runner; let the verdict carry it. *(Contested: the step as first
  written reversed a decided invariant and retired nothing.)*
- [ ] **Step 7 — the fingerprint binds the oracle, without touching proportionality.** A separate
  fingerprint component over the exact doc sections the bundle carried — the orientation layer and
  the invariants layer, not whole files. It must not enter `computeRealChange`'s set, which also
  drives `realChangeCount`: the loop requires the owning doc to move in the same step, so folding
  docs there would make every loop-compliant edit two real changes and kill the trivial fast-path the
  proportionality invariant exists to preserve. *(Contested: one shared variable, two consumers.)*
- [ ] **Step 8 — a new file the source spec cannot see, beside files an entry governs, is named.**
  Restricted to extensions the spec excludes — the only case `unmapped-source` cannot already reach,
  so the signal never duplicates a finding one function away. Emitted once per entry with a count,
  suppressed where the entry already declares a covering pattern, and living in `change-state.ts` so
  `review` and `watch` share one analyzer. Reported, never gated: inference is not proof, and
  [ADR 020](../architecture/decisions/020-a-block-must-be-provable.md) governs. *(Contested: as first
  written it would have fired on every new file under `src/lib`, and lived somewhere `review` cannot
  read.)*
- [ ] **Step 9 — the pin check reaches the loop, and reports.** `review` names a structurally-marked
  test pin that does not resolve, in the docs this change touched. It never gates: the runner searches
  two directories, so an unresolved citation is a fact about the toolchain, and a repo keeping tests
  in `src/__tests__/` would otherwise fail on every invariant in every doc it edits. The parser stays
  structural. **Honest limit, stated rather than fixed:** a bare-prose claim like the field's own
  ("both are pinned by X.test.tsx") stays uncaught, because loosening the grammar to any sentence
  naming a test file turns a citation into a lexical guess. *(Contested three ways, all fatal to the
  first draft.)*
- [ ] **Step 10 — dead acks are named where the loop looks, swept only where sweeping is asked for.**
  An **info**-severity finding, never an exit-code input — a dead ack's subject file is by
  construction in the change set, so a warn would gate the loop's most ordinary shape on inherited
  state. The sweep rides `doctor --fix`, already the explicitly-invoked mutating surface, so `review`
  and bare `doctor` stay pure and reproducible across runs. *(Contested: a sweep on either gate breaks
  a determinism contract both are tested for.)*
- [ ] **Step 11 — the decision, and the reader-facing surfaces.** One ADR, not two: **021 — an
  attestation binds and discloses what it was grounded in**, explicitly superseding the clause that
  makes `--record` independent of what the reviewer was handed. The delivery rule gets no ADR: it is
  already decided, already worded, already pinned by a conformance battery, and revised across four
  plans — freezing it would owe a supersession the next time it moves. Then README and CHANGELOG.

## Outcome

**The tool's output fits the reader it has.** `doctor` on a healthy repo is a screen rather than
68,000 characters, with every repetition collapsed and every file still named. Every condition the
reader must act on rides the one line that survives `| tail -1`, that line is itself bounded, and both
are enforced by tests rather than by remembering. A command that changed state says what it changed.

**A review artifact means what it says.** It is never destroyed by the next one, it discloses whether
it answers a bundle at all, it moves when the documented invariants it attacked move, and its verdict
carries whether the runner could have adjudicated anything. The field session that produced one
overwritten record and three success messages would produce two intact records and a verdict that says
plainly no runner was available.

**Two checks that already worked reach the place they were needed.** A new file beside files the
registry governs is named rather than counted as "other"; a doc citing a test that does not resolve is
named by the gate that runs every step.

**What it deliberately does not do.** Nothing new gates. The sibling signal, the pin report, the ack
finding and the grounding disclosure are all reported-only, because each rests on inference or on the
local toolchain and ADR 020 forbids blocking on either. The decided cases stay decided: an empty
review still covers, a judgment-calls-only review still covers, proportionality's trivial fast-path
survives, and `doctor --json` does not change shape. The bare-prose pin claim that started step 9
stays uncaught, named as a limit rather than papered over.

### Acceptance criteria

- The field's own 268-note `doctor` run fits a screen, with every blind file still named and `--json`
  byte-identical to today.
- A run whose confirm step could not run says so on the trailing status line; that line never exceeds
  its bound, and what it drops is counted.
- Two `--record` calls differing only in `invariantsChecked` leave two artifacts.
- A review recorded without a bundle it answers is recorded and disclosed, not refused.
- A judgment-calls-only review on a working runner still says *covers*; the same review where the
  resolved runner cannot run does not.
- Rewriting an owning doc's invariants layer after recording reopens the gate; editing an unrelated
  section of the same doc does not, and neither changes whether a review was required.
- A new `.html` beside registered `.html` siblings is named by `review`; a new `.ts` under `src/lib`
  produces `unmapped-source` and no sibling note.
- `codument emit review` prints what it recorded, marked self-reported.

### Verification strategy

- Every step reproduced against the built CLI on a fixture shaped like the field's — three of the ten
  findings were visible only end to end.
- Each behavioural fix proven to bite by seeding the old behaviour back.
- `npm run typecheck`, `npm run build`, the full suite against the 26-failure / 13-suite Windows
  baseline, `codument review --strict`, `codument doctor --strict` on every step.

### Open questions

1. **Scale.** Ship all eleven steps as one release, or cut 0.19.0 at the delivery cluster (steps 1-3)
   and take attestation as 0.20.0? **I would ship delivery first.** It is the precondition for the
   rest landing anywhere a reader sees it, it is three steps rather than eleven, and it is the part
   costing something today.
2. **Step 6's probe cost.** Probing a declared runner puts one bounded spawn on the verdict path that
   is not there today. **I would probe once per run and cache it**; the alternative is that
   declared-runner projects — the ones that configured the tool properly — keep the exact green
   verdict this step exists to remove.

### Independent plan pass

Run, on three lenses grounded in the owning docs rather than a Feature Map (the plan introduces no
source file). 24 objections, 11 serious; every one is either folded into a step above or answered in
the Open Questions. The two that changed the plan most: step 6 was reversing a decided invariant
without saying so, and step 5's refusal would have dead-ended the first review of any diff while
binding only the honest actor.
