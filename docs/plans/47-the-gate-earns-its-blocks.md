---
status: shipped
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

## How it landed

Eleven steps in ten commits — step 6 merged into step 4 — plus one off-plan fix at the
user's request and this compaction, in the order written.
Five things are worth keeping.

**Merging step 6 into step 4 was right, and the reason generalizes.** Once a body-only move
stops gating, the per-symbol acknowledgment has nothing left to clear on any adapter that
reports a signature — so the two were one contract change, not two. Split across commits it
would have shipped a command writing records that clear nothing, and forced the same tests
to be rewritten twice: once to describe that intermediate state, once to delete it. A step
boundary exists to keep each commit reviewable; here it would have done the opposite.

**Writing the condition catalog corrected the model it was meant to record.** "Does an
acknowledgment apply" is not a boolean: an added export refuses the per-symbol grain and
accepts the file grain, and a symbol under a concept umbrella is woken whole so only the
file grain settles it. A single flag is exactly how "no ack applies" and "no per-symbol ack
applies" came to be one sentence meaning two things in different files. Enumerating the
conditions also surfaced one nobody had named — a move on an adapter that reports no
signature cannot be *proven* body-only, so it still gates and the per-symbol ack still
clears it. It had existed only as an unlabelled `else`.

**The inverted battery found five conditions with no routed surface and six sites still
authoring routes the catalog owned** — two of them printing the same pair of labels at two
different column widths. A battery that judges only what a surface prints cannot see the
route nobody printed, which was every one of this round's field failures. The boundary is
now enforced rather than described: no source outside the catalog may build a `codument`
command out of a variable.

**The field fixture earned itself on its first run.** `ack` refused a body-only move on a
contested component with the *ownership* demand — a registry edit to settle a wake ADR 020
no longer raises, and one `review` does not report, so the command was the last surface
still charging for it. Step 4 had fixed that shape in the verdict and left it standing in
the refusal. Only a repository shaped like the field met both at once. The mutation pass
then caught the fixture's own CRLF assertion being vacuous: its docs were too short for the
section split to change any answer.

**The guidance sweep was a correctness fix, not tidying.** Nine places told an agent to run
a command this release refuses, and the test guarding that text asserted the stale
instruction — it would have gone red on the correct wording and green on the wrong one. An
instruction that routes into a refusal is worse than a missing one: the agent follows it,
is refused mid-step, and improvises the resolution nobody specified, which in the field
means prose written to clear a gate.

Left standing, deliberately: all three open questions were answered as recommended — risk
gating on blind files only, added/removed exports keeping the file-ack escape, and
`--standing` fully retired. The `--require-review` confirm runner still times out on slow
suites, so findings there read "unrunnable" rather than judged; that is a separate defect
with its own fix, not this plan's.
