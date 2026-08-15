---
status: shipped
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

## How it landed

Eleven steps, eleven commits, shipped as 0.19.0. Every step was implemented, adversarially
reviewed against the bundle it produced, confirmed by re-running each finding's named test, and
committed on its own. Each behavioural fix was proven to bite by seeding the old behaviour back.

Three things the plan did not anticipate, kept because they are the durable part:

- **The suite was green under `npm test` and red under the confirm gate**, on the same tree. A
  third of the review suite's CLI spawns pinned `NO_COLOR` and the rest inherited the terminal's,
  so under a colouring one four tests went red and the gate read four confirmed findings —
  codument reporting bugs in codument that did not exist. Found by the gate being wrong about
  this plan's own step 2.
- **No test file in this repository is typechecked.** The suite runs under `tsx`, which strips
  types without checking them, and `tsconfig` covers `src` alone. A test may not rely on the
  compiler to catch what it asserts — which invalidated one defence written in this plan and
  changed how every later test was written.
- **Two Windows portability defects in the suite itself**, both of which had made a branch
  unreachable rather than merely red: the only test covering "git ran and failed" shadowed git
  with a shell script on a colon-joined PATH, and two subdirectory-refusal tests compared git's
  own forward-slash toplevel against a native-separator path. The Windows baseline went from 26
  failures across 13 suites to 23 across 10.

Both open questions were answered against the recommendation, deliberately: all eleven steps
shipped as one release rather than cutting at the delivery cluster, and the runner probe resolves
the binary rather than executing it — which costs no spawn at all and so needed no cache.
