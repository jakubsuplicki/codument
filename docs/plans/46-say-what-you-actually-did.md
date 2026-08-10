---
status: approved
---

# Plan 46: say what you actually did

Two field reports from building a collections feature in a real Expo app under 0.16.0 — a
session report and eight live probes on a throwaway clone. One theme runs through every
finding: **the tool knows more than it says, or claims more than it did.** A signature is
taken over content the signer never saw; a verdict says it covers a diff it adjudicated
nothing in; a precision downgrade happens in silence; and the findings the tool does
report never reach the reader at all.

That last one is not a footnote. The reporter piped nearly every invocation through
`tail`, `head` or `grep` because the output exceeded their tool-result budget, and said so
first because they knew it cost them. It cost more than they knew: **two of the round-2
findings are false, and the piping is why.** Both were checked against source before this
plan was written.

Verified mechanisms:

1. **A file acknowledgment on a governed file no adapter can judge names nothing it
   vouched for.** ADR 018 already settled the principle at tree grain — the record names
   every path and transition it covered, "because an acknowledgment nobody can read
   afterwards is a signature on a blank page" — and a file ack on a TypeScript file names
   the exports it swept. A governed file with no adapter has no symbols to enumerate, so
   it prints a hash transition and nothing else: the signer is blindest at exactly the
   grain where the tool is least able to judge. Reproduced live at its worst: a one-token
   change to a rules file making every user's private collections world-readable, applied
   alongside a comment edit and acked with a reason naming only the comment. The reason
   was true. The gate went **clean, exit 0, signed** — an attestation over a security
   regression, and every word of it accurate.
2. **A judgment is re-signed on every content change even when it cannot have gone
   stale.** An ack binds file content on purpose, so nothing rides forever. But the
   judgment being re-made — "string additions to this locale namespace owe no line to this
   ADR" — is true until the ADR's claims move, not until the file's bytes move. One file
   was acked four times in one session with four near-identical reasons; three are already
   dead, in a list where 29 of 55 are dead. The warning naming the cost prints on every
   finding, was read at least five times, and changed nothing, because acting on it meant
   restructuring the work rather than the acknowledgment.
3. **`--require-review` claims coverage it did not adjudicate.** The default runner
   resolves local-only and was unavailable in the field repo, so every adversarial finding
   across five delivery steps was recorded advisory and **not one had its test re-run**.
   The gate still printed `✓ Adversarial review covers this diff`. The condition line
   above it is correct and centrally worded; the verdict beneath it is not, and the verdict
   is what gets read. Twelve real bugs were fixed that session because the author fixed
   them, not because the gate held.
4. **What the tool reports above the verdict line does not reach the reader.** Plan 39 put
   the verdict last because readers pipe; this report shows the other half of that habit —
   `| tail -1` delivers the verdict and destroys everything else, including the exit code.
   The bill, in this report alone: the dangling-registry-pointer finding plan 44 shipped
   was reported as missing from `review` across roughly fourteen runs (it fires; it prints
   above the verdict); `ack`'s ownership refusal was measured as exit 0 when it sets 1
   through the same `fail()` every other refusal uses; the scaffold-version banner printed
   on every invocation for five hours unseen; and `steps --emit` logged an entire feature's
   work against the wrong plan because the header naming its choice was cut. Two findings
   in an adversarial report by a careful reporter, false for one reason.
5. **A file's precision is downgraded in silence.** An explicit registry entry overrides
   the source-extension spec, so a registered `.js` file is still gated — correctly — but
   only at file-hash grain, with no symbol analysis and nothing announcing the loss. The
   reader is offered the blunt file ack as if it were the only grain that ever applied.
6. **A doc may name a source path that no longer exists.** A rename that re-points the
   registry goes green, which is right — but the owning doc's Key files layer still named
   the dead path, and nothing looks there. The registry pointer is checked; the prose
   pointer beside it is not.
7. **The workflow sends agents to the 72KB registry for a four-line answer.** Roughly a
   dozen places across `AGENTS.md` and the skills instruct a flat read of
   `docs/.registry.json`; `context --file --owner` answers the loop's most frequent
   question in one line and appears almost nowhere. The expensive door is the documented
   one.
8. **The guidance-to-outcome contract is asserted case by case, never as a battery — and
   it keeps breaking in the gaps.** This is not from the field report; it is from this
   repository's own plan history, and it is why the field report exists. Plan 36 shipped a
   resolution block and was reopened because it was right in one direction and wrong in
   the other. Plan 41's adversarial pass confirmed ten findings and every one had been
   introduced by a fix. Plan 42 found that *every per-symbol ack command codument had ever
   printed was a shell syntax error*. Plan 44 was three separate cases of two surfaces
   answering one question differently. Plan 45 was two ownership routes disagreeing.
   Mechanism 1 is the same shape once more: the one acknowledgment path where nothing
   asserts the signer can see what they are signing. Six consecutive releases with one
   root is a missing invariant class, not a run of bad luck. The tool already knows the
   remedy — `adapter-conformance.test.ts` pins the eight properties that define "precise"
   for every language and is proven to bite against a seeded mutant adapter. Surfaces have
   no equivalent, so each route's promise lives in whichever test its author happened to
   think of.
9. **The registry claims ownership of files that own no contract.** Six of the session's
   eight acknowledgments were on files with no symbols in them, and two of those —
   `bun.lock` and `package.json` — woke an ADR about deferring native voice modules and a
   getting-started page. Neither of those documents *owns* a lockfile; they are affected by
   it, which is `related_sources`, impact and never a wake. The concept already exists and
   the entry is simply wrong, and nothing anywhere says so. The contrast is the argument
   for the acknowledgment rather than against it: not one of the eight was on a TypeScript
   file, because where the tool can see contracts the two-way call worked — seventeen owned
   symbols moved in step one and all seventeen were resolved by a doc update.
10. **`doctor` accumulates and nothing pays it down.** Seventy findings on a maintained
    repo reads as a surface that cries wolf, but the cause is upgrade debt, not
    calibration: ten of them are spike directories, a scripts folder and a website eslint
    config that belong in the project's declared `exclude` block and were never put there,
    and every lint added since a project adopted retroactively finds old violations, so
    the count climbs on upgrade even when the repo has not moved. The consequence is what
    matters — sixty-nine inherited findings and the one this change just created render
    identically, so the loop's only whole-repo health surface is unreadable at exactly the
    moment it has something new to say. `review` settled this same question already:
    inherited registry rot is reported and never gated, "because a gate that fails on
    inherited state is a gate people learn to bypass." `doctor` never got the rule.

Two reported findings dissolved on verification, both into mechanism 4: `review --strict`
does report inherited registry rot (`registryRot` is in the 0.16.0 tag, eight references,
shipped by plan 44), and `ack`'s unassigned-symbol refusal does exit nonzero (`fail()` sets
`process.exitCode = 1`; nothing in `cli.ts` resets it). Neither is a defect. That they were
both reported as defects is the strongest evidence for mechanism 4 in either report.

## Outcome

Once every step lands:

- **A promise the tool prints is a row in a battery, not a hope.** Every route any surface
  offers runs verbatim and clears the finding it sits under, every signature is legible at
  the grain it is taken, and nothing that changes the reader's next action is reachable
  only above the verdict line — asserted once, for all surfaces, and proven to bite.
- **A signature is legible.** Whatever grain it is taken at, an acknowledgment names what
  it covered — the symbols it swept where symbols exist, the changed hunks where they do
  not — at signing time, in the review card, and in `ack --list`. The probe-1 sequence
  becomes impossible to perform without seeing the rule change in the same breath as
  signing for it.
- **A recurring judgment is made once.** An acknowledgment may stand across content
  changes when it is bound to the doc whose claims decide it, and every review it covers
  something says out loud what it swept. Four signatures become one; none of them becomes
  silent.
- **A verdict never overstates.** `--require-review` says what it could not adjudicate
  instead of claiming coverage, and one line of output carries every condition that
  changes what the reader does next — so `| tail -1`, the habit the field actually has,
  is sufficient rather than merely truthful.
- **Silence stops meaning "fine".** A coarse-gated file says its grain is coarse, and a
  doc naming a path that is gone is a finding rather than prose nobody re-reads.
- **The registry stops charging for what it does not own, and the health surface stops
  charging for what it inherited.** A manifest or lockfile claimed as a primary source is
  named as the ownership error it is, and `doctor` separates the findings this repo state
  just produced from the debt it arrived with — with the mechanical part of that debt
  fixable in one command.
- **The cheap door is the documented one.** The workflow routes ownership questions
  through `context --owner`.

What it deliberately does not do:

- **It does not check that source imports still resolve.** Thirteen dead imports survived
  probe 3's rename; that is the compiler's job, and a documentation gate that grows an
  import graph to duplicate `tsc` has lost its boundary. Only the *doc's* pointer is
  brought up to the registry pointer's standard.
- **It does not auto-fix a judgment.** `doctor --fix` touches only what is decidable
  without reading prose. An agent pointed at seventy findings writes compaction theater —
  plan 42's finding almost word for word — so doc-level findings stay in the loop, fixed
  when the doc is next touched.
- **It does not make a standing acknowledgment provable.** It stands on a stated rule a
  human wrote and a doc hash the tool can watch; codument stays LLM-free on the verdict
  path, so it can name what a standing ack swept but never judge whether the sweep was
  right. Visibility is the whole guarantee.
- **It does not re-open `doctor`'s thresholds.** Separating inherited from new is the
  readability fix; whether `bloated-doc` fires at the right size is a calibration question
  left where it is.
- **It changes no wake, no fingerprint, and no exit code that is already correct.** Every
  existing gate-wiring and drift assertion should pass unmodified.

## Decisions (pre-settled — adjust at approval, not mid-run)

- **The battery goes first and is expected to go red.** It pins the properties this release
  then satisfies, exactly as plan 18's conformance battery preceded the language adapters.
  A row that fails on landing is the plan working; a row nobody wrote is how mechanism 8
  keeps recurring.
- **"New" in `doctor` is derived, never a baseline file.** A finding is this change's when
  its subject is in the working-tree change set; everything else is inherited. No recorded
  baseline, so there is no second source of truth to rot — the same derived-first stance as
  ADR 001 and ADR 004, and the same scope rule `review` already uses.
- **A standing acknowledgment dies on any content change to its doc**, not only on a move
  in the layers it could be about. Coarser, and a doc edit is rare enough that the extra
  re-signing is small beside four signatures per feature.
- **`doctor --fix` applies only judgment-free, reversible edits** — unmapping a registered
  test or generated file, dropping a registry pointer to a path that does not exist — and
  *prints* rather than writes anything that needs a decision, the `exclude` block included.
- **The lockfile lint names, never rewrites.** Moving a source between `primary_sources`
  and `related_sources` changes what wakes; that is the user's call, and the lint's job is
  to make an accidental claim visible.

## Delivery Plan

Status: draft, awaiting approval before source edits.

- [x] Step 1: A surfaces conformance battery — the guidance-to-outcome contract as a
      fixture table over every route the tool prints, mutation-proven against a seeded
      surface that lies. Rows this release will turn green are expected to land red.
- [x] Step 2: Nothing that changes the reader's next action lives only above the verdict
      line, so a piped `tail -1` is sufficient rather than merely honest.
- [x] Step 3: A file acknowledgment names what it vouched for at every grain. Where no
      adapter can enumerate symbols, it names the changed hunks — at signing time, in the
      record, in the acks card and in `ack --list`.
- [x] Step 4: A standing acknowledgment, bound to the owning doc rather than to file
      content — it survives a content change and dies when the doc's claims move.
- [x] Step 5: Every review a standing acknowledgment covers something names what it swept,
      so width is never silent.
- [x] Step 6: `--require-review` never claims to cover a diff it adjudicated nothing in.
- [ ] Step 7: A governed file gated coarse says so once, so a lost precision is a stated
      fact rather than an inference from which routes were offered.
- [ ] Step 8: A doc naming a source path this change removed is a finding, held to the
      registry pointer's standard.
- [ ] Step 9: A manifest or lockfile claimed as a `primary_sources` entry is a lint —
      named as an ownership error, never rewritten.
- [ ] Step 10: `doctor` separates the findings this change produced from the debt the repo
      arrived with, and says which is which.
- [ ] Step 11: `doctor --fix` clears the judgment-free subset in one command and prints
      what it deliberately left alone.
- [ ] Step 12: The workflow routes ownership questions through `codument context --owner`
      instead of a flat read of `docs/.registry.json`.
- [x] Step 13: A stale doc woken by a deletion is not offered the file-grain ack, in the
      finding or in the `--strict` epilogue. **Found by step 1's battery on its first run
      and reproduced by hand** — `review` prints `codument ack <path>` and `ack` refuses it
      with "no acknowledgment clears a deletion", so the gate is left exactly as red by the
      command printed to clear it. Plans 36 and 42 closed this shape for unclaimed symbols
      and for signature moves; deletions were never covered, because until the battery
      existed nothing asked every route the same question at once. Run immediately after
      step 1; the battery carries the scenario marked pending until it lands.

## Acceptance criteria

- The battery fails against a seeded surface that prints a route which does not clear its
  finding, and every route the shipped CLI prints is a green row.
- The probe-1 sequence cannot be completed blind: acking a rules file carrying both a
  comment edit and a rule change prints the rule change before the signature is taken, and
  the recorded acknowledgment names it.
- A locale file appended to across four steps is acknowledged once, and each of the four
  reviews names what that acknowledgment swept.
- `--require-review` with no resolvable runner does not print a covering verdict.
- `codument review --strict | tail -1` on a tree with inherited registry rot and a stale
  scaffold names both.
- A registered `.js` source and a registered rules file each state their grain.
- A rename that re-points the registry but leaves the old path in the owning doc's Key
  files is red until the doc is corrected.
- A lockfile in `primary_sources` is linted; the same lockfile in `related_sources` is not.
- `doctor` on the field repo's shape reports its inherited count separately from findings
  the current change produced, and `--fix` clears the mechanical ones without touching a
  doc.

## Verification strategy

Red-green per step, with each new test mutation-tested to prove it bites. The field
sequences are the fixtures: probe 1's comment-plus-rule edit, the four-step locale append,
the runner-less `--require-review`, probe 3's rename, and the field repo's registry shape
for steps 9 through 11. Step 2 additionally asserts the piped shape (`tail -1`) rather than
the full render, since that is the surface the field actually reads. Step 1's battery is
itself verified the way plan 18's was — against a seeded mutant surface, so a vacuous green
is impossible.

## Open questions

1. **May a standing acknowledgment cover a file whose owning feature carries a risk tag?**
   Recommendation: yes, but rendered as its own line in the acks card, on the same argument
   as the self-versus-independent badge — width over a risk surface should be loud rather
   than forbidden.
2. **No independent plan pass ran.** This plan introduces no new source files, so it
   carries no Feature Map and routes to no documented invariant an adversary could attack
   — the grounded pass is skipped by the skill's own rule, not by omission.
