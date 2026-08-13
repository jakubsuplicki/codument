---
status: approved
---

# Plan 47: the gate earns its blocks

Three field reports in a row have one subsystem in their worst finding. The gate wakes on
every change class it can see, but it can only *verify* the fix for some of them — and
where it demands what it cannot check, it collects theater. A signed reason nobody reads
back degrades into a slug on the first signature, not the fourth: the field ledger is 72
acknowledgments, 38 already dead, twelve of them the same cosmetic sentence pasted across
one visual tweak, and the reporter's own accounting says the treadmill produced two doc
edits written *to make the gate green* rather than for a reader. Meanwhile the wakes that
resolve into real doc updates are concentrated where the gate can see contracts move.

The design error, stated once: **the gate charges the same toll whether or not it can
see.** An agent cannot be made to exercise judgment by blocking its path — it can only be
made to produce whatever artifact clears the block. When the artifact is checkable (a doc
changed, a file mapped), compliance is real work. When it is unverifiable (a signature
over "no contract changed"), compliance is the cheapest string that parses. Any design
that depends on extracting unverifiable judgment under blocking pressure gets theater at
exactly the rate the judgment is not owed.

So: **a block must be provable.** The gate blocks only where the triggering event is
structurally contract-grade and the demanded fix is checkable. Everything else is
reported — on the verdict line, where a reader who pipes still sees it — and never gates.

What keeps gating (all structurally verifiable):

- **Signature moves.** The contract changed by construction; a doc update is owed;
  no ack has ever cleared one. Unchanged.
- **Added and removed exported symbols.** New or vanished public surface is a contract
  event the parser proves. The existing file-grain ack stays as its escape, because
  "this new helper export owes no doc line" is a judgment the gate cannot make — but the
  event itself is real, so the ask is rare and defensible.
- **Deletions of owned files.** Doc attention, never ackable. Unchanged.
- **Unmapped new sources, registry pointers, doc pointers.** Checkable fixes
  (materialize; repair the entry; update the doc). Unchanged.
- **Risk-declared blind files.** A file no adapter reads, owned by a feature carrying a
  risk tag, still gates on any content change — with the 0.17.0 changed-line disclosure
  as what the clearing ack is signed over. This is how a rules file making private data
  world-readable stays impossible to sign blind. Risk gating stays at file grain on
  blind files only: on a precise file the signature/body split already carries the
  contract question, and a feature-level risk tag is too coarse to block a body move
  (the field's provider-mount edit tripped attestation risk while touching neither).

What demotes to report-only, never gating:

- **Body-only moves.** The largest wake volume, the entire per-edit re-signing
  treadmill, and the class whose acks degrade into slugs. Reported as a count on the
  verdict line; the per-symbol detail stays in the report body and the impact ledger.
- **Non-risk blind files.** A locale pack gains strings without a signature. The change
  is still named, still attributed, still in the ledger — it just does not block.

Mapped against the field ledger: the twelve identical component-head acks, the haptics
acks, the locale treadmill, and the provider-mount ack never exist. The dock-route ack
(an added export) rightly survives. Roughly 50 of 72 entries were tolls on wakes this
plan deletes.

The honest cost, named where it can be weighed: a body-only change that silently alters
documented behavior no longer blocks. Two things bound it. The co-movement telemetry
keeps measuring exactly that class — prose-unchanged body moves are the soak line's
existing signal — so if doc rot spikes after the flip, the data says so and a reversal is
informed rather than faith. And the review-work loop still reads the report: demotion
moves the enforcement from exit code to workflow instruction, which the field shows
agents follow when the instruction is visible.

Casualties, retired honestly rather than carried:

- **`--standing` (ADR 019, shipped in 0.17.0).** Body moves no longer gate, so there is
  nothing for a standing vouch to stand over. The record format stays parseable; the
  flag is refused with the reason; existing standing records are labeled obsolete in
  `--list` and swept by `--prune`. Three days old is not a reason to keep a dead limb.
- **Most of the ack economy's volume.** The command survives, narrowed to the events
  that still gate: additive residue on precise files, tree acks (a governed tree's
  added-file decay is an additive contract event), and risk-file disclosure acks.

Alongside the re-scope, this plan carries the systemic fixes the same reports demanded —
because the seventh consecutive release of "capability shipped, surface never routed to
it" is an architecture debt, not bad luck:

- **The CRLF measurement bug.** Every heading in every doc is invisible to the bloat
  lint on a Windows checkout — the heading regex ends in `$` and a carriage return
  breaks it — so whole files report as one section called "(preamble)". That is 55 of
  the field's 105 doctor findings and both entries in this repo's own release-guide
  baseline. Fabricated debt, one-line class of fix, lands first so every later number
  in this plan is measured honestly.
- **`doctor --strict` gates on attributed findings only.** Failing on 105 findings it
  labels "nothing here gates anything" makes the exit code meaningless. It fails only
  when this change produced a finding; inherited stays reported. The release guide's
  "accepted baseline" ritual dies with it — a green becomes achievable and required.
- **One condition→remedy table.** Every gating condition and its remedy in one catalog
  every surface renders from, replacing hand-written route text per command — the root
  of six releases of routing defects.
- **The battery inverted.** The surfaces conformance battery currently asserts every
  route the tool *prints* works; all three new field failures were routes it never
  printed. It now enumerates the condition catalog exhaustively: every condition names
  a remedy, the remedy prints, pastes, clears, and is reachable from the verdict line.
- **A field-shaped fixture.** Every one of this round's failures bit in a repo with
  CRLF checkouts, no `src/` directory, single-default-export screens, locale JSON, and
  a piping reader — properties this repo has none of, which is why the suite passes and
  the field does not. A fixture repo with those properties, with an e2e replay of the
  field session's three gate episodes asserting the new behavior.

## Outcome

- **Every block is defensible.** Nonzero exit means the tool can prove something is
  wrong and can check your fix. An agent can trust the exit code absolutely — no
  judgment quotas, no inherited debt, no signature rituals over unverifiable claims.
- **An existing repo gets fixed by upgrading.** On 0.18.0 the field repo's day one:
  the body-move and locale treadmill stops (no action needed), ~55 fabricated bloat
  findings vanish (CRLF fix), `doctor --strict` goes green because inherited debt stops
  gating, `ack --prune` sweeps the 38 dead and newly-obsolete records, and an extended
  `doctor --fix` removes the excluded-file claims (`generated-leakage`) mechanically.
  What remains is real: shipped-scaffolding and bloat findings on docs a human should
  actually compact, in the loop, when next touched.
- **The remaining asks are rare enough to be real.** An ack is requested only at an
  additive contract event, a tree decay, or a risk-file change — each one an event the
  parser proved, each signature over disclosed content.
- **Release eight cannot repeat release seven.** A condition without a routed remedy is
  a suite failure, not a field report; the field fixture makes the suite fail where the
  field fails.

What it deliberately does not do:

- **It does not verify prose truth.** A body-only change that alters documented
  behavior without moving a signature is reported, tallied, and never blocked. The
  co-movement soak is the watch on that class, and reversal is a data question.
- **It does not add a compatibility mode.** 0.x, one bar, one tested universe.
- **It does not re-litigate what counts as a contract.** The signature/body split
  (ADR 006/014) is the boundary, unchanged; this plan changes only which side of it
  gates.
- **It does not touch the docs standard, the registry model, or plan/step machinery.**

## Delivery Plan

Status: awaiting approval.

- [x] Step 1: Fix CRLF heading blindness in the doc parsers (bloat sections, invariant
      headers, feature-map heading, plan scope) with CRLF fixtures proving each; re-measure
      and correct the release guide's doctor baseline.
- [x] Step 2: `doctor --strict` fails only on findings attributed to this change;
      inherited findings stay reported, exit 0; releasing.md drops the accepted-baseline
      ritual and demands green.
- [x] Step 3: Write ADR 020 — a block must be provable; the gate demands a checkable fix
      or it does not block — with the field evidence and the honest ceiling.
- [x] Step 4: Re-scope the drift verdict: body-only moves become advisory (verdict-line
      count, report detail, ledger tally; never a staleDocs/strict input); signature,
      added, removed unchanged.
      **Delivered wider than written, in two places the adversarial pass forced.**
      (a) The unowned/ambiguous passthrough takes the same predicate: it gated a body
      move while the umbrella above it did not, so one file's one move had two
      answers — and the field's worst episode (a body edit on a contested component)
      would have survived as an ownership demand instead of a doc demand.
      (b) The verdict-line disclosure counts the whole in-scope anchor diff rather
      than the owned findings, because a file no feature claims is exactly where
      silence would read as "the tool saw nothing" — scoped by the exclusion spec,
      since a declared build tree is not something the gate may report having read.
- [x] Step 5: Re-scope blind-file governance: non-risk coarse governed files advisory;
      risk-declared blind files gate with changed-line disclosure and the file-ack escape.
      This partially supersedes ADR 017 (its motivating false-green returns for non-risk
      blind files); ADR 020 records the supersession, and the downgrade is never silent —
      the 0.18 migration names every governed blind file losing its gate, with the
      risk-tag line that restores it.
- [x] Step 6: Narrow `ack`: refuse a body-move per-symbol ack (nothing gates it) and
      retire `--standing` (refused with reason); obsolete records labeled in `--list`,
      swept by `--prune`, old files parse harmlessly.
      **Merged into step 4 during delivery.** Once a body-only move stops gating, the
      per-symbol acknowledgment has nothing left to clear on any adapter that reports a
      signature — so the two are one contract change, not two. Split across commits it
      would have shipped a command writing records that clear nothing, and forced the
      same ack tests to be rewritten twice: once to describe that one-commit state, once
      to delete it. The step boundary existed to keep each commit reviewable, and here it
      did the opposite.
- [x] Step 7: Upgrade cleanup: extend `doctor --fix` to remove excluded-file source
      claims (removal-only, decidable); `codument update` prints the 0.18 migration note
      naming the two cleanup commands.
      **Delivered narrower than written in one place, and wider in another.**
      (a) "Excluded-file claims" splits three ways, and only two are decidable. Git's
      ignore set and the project's own `exclude` block are the project contradicting
      itself, so removing the line transcribes a decision already made. A built-in
      exclusion is codument GUESSING from a filename — the same rule that catches build
      output calls a hand-authored `*.seed.json` generated — so clearing a registration
      on it would be the tool overruling a human claim with a heuristic, which is the
      corruption `--fix` exists to detect. The analyzer therefore marks each finding
      rather than the command matching lint ids, since one lint lands on either side.
      (b) The note was suppressed on `adopt`, the command whose whole job is bringing an
      older project forward: it stamps the new version into the metadata and only then
      delegates the sync, so the delegate re-read the file and concluded there was
      nothing to migrate from. Re-deriving state a caller has already overwritten is the
      shape of the bug; a caller that knows now hands the prior version over — and says
      "there was no earlier install" as a distinct answer from "could not tell", so a
      first-time adopter is not told to clean up after a release it never ran.
- [x] Step 8: Build the condition→remedy table — one catalog of every gating condition
      and its remedy — and render every review/ack/doctor route from it.
      **Two corrections the build forced, and one boundary named rather than implied.**
      (a) "Does an ack apply" is not a boolean. An added export refuses the per-symbol
      grain and accepts the file grain; a symbol under a concept umbrella is woken whole
      so only the file grain settles it. A single flag is exactly how "no ack applies"
      and "no per-symbol ack applies" came to be one sentence meaning two things, so a
      condition names the GRAINS that reach it.
      (b) Writing the catalog surfaced a live condition nobody had named: a symbol move
      on an adapter that reports no signature cannot be PROVEN body-only, so it still
      gates and the per-symbol ack is what clears it. That is the one surviving home of
      the per-symbol grain after ADR 020, and it existed only as an `else` branch.
      (c) The catalog owns the routes with more than one renderer — the drift, stale-doc,
      pointer, ownership and blind-file families that `review`, `ack` and `doctor` all
      speak about. A `doctor` lint that carries its fix inside its own message and is
      rendered in exactly one place has no twin to drift from; folding those in would be
      indirection bought with nothing. Step 9's battery asserts that boundary rather than
      leaving it to be re-argued.
- [ ] Step 9: Invert the surfaces battery: enumerate the condition catalog exhaustively —
      every condition routes, every route prints, pastes, clears, and reaches the verdict
      line; proven to bite against a seeded unrouted condition.
- [ ] Step 10: Build the field-shaped fixture repo (CRLF, no `src/`, single-default-export
      screens, locale JSON, risk-tagged rules file) and replay the field session's three
      gate episodes end-to-end asserting the new behavior.
- [ ] Step 11: Docs and guidance sweep: change-control-gate.md invariants rewritten to the
      new scope, AGENTS.md/CLAUDE.md/skills/scaffold two-way-call wording updated (contract
      changed → doc; internal only → nothing owed), README, CHANGELOG 0.18.0.

```feature-map
src/lib/remedies.ts | change-control-gate | feature | single condition→remedy catalog every gating surface renders routes from
```

Acceptance criteria:

- A body-only move on an owned precise file: reported, counted on the verdict line,
  `--strict` exits 0, `ack` refuses it by name.
- A signature move, deletion, added/removed export, unmapped source: gate exactly as
  today, byte-comparable routes.
- A content change to a risk-declared blind file: gates; the clearing ack names the
  changed lines; the same file non-risk: advisory.
- A CRLF checkout measures sections identically to an LF checkout.
- `doctor --strict` on a repo with only inherited findings: exit 0; introduce one
  attributed finding: exit 1.
- The inverted battery fails when a gating condition is seeded with no routed remedy.
- The field fixture's three episodes pass with zero acknowledgments demanded where the
  field session recorded five.

Verification: the full suite plus the new battery and fixture e2e; mutation-proof each
new test by seeding the defect it pins; `codument review --strict --require-review`
clean per step.

Open questions (recommendation first):

1. Risk gating breadth — recommend blind files only (precise files keep the
   signature/body split as their contract boundary; feature-level risk tags are too
   coarse to block body moves, per the field's provider-mount false positive).
   Alternative: any file of a risk-tagged feature gates on any move.
2. Added/removed exports — recommend keep gating with the file-ack escape (the event is
   proven; the escape prevents forced mirror prose). Alternative: demote additive moves
   to advisory too, leaving only signature/deletion/unmapped/risk gating.
3. `--standing` — recommend full retirement (nothing left to stand over). Alternative:
   keep it solely for risk-file recurring judgments, at the cost of carrying ADR 019's
   machinery for one narrow case.
