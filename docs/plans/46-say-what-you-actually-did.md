---
status: shipped
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


## How it landed

Thirteen steps, thirteen commits, in the order written. Four things are worth keeping.

**The battery paid for itself before the release it was written for had started.** Step 1
pinned the guidance-to-outcome contract as a fixture table, and on its first run it found
a live defect nobody had reported: `review` printed `codument ack <path>` over a stale doc
whose source this change had deleted, while `ack` refuses a deletion by name — so the gate
was left exactly as red by the command printed to clear it. Plans 36 and 42 had closed
that shape for unclaimed symbols and for signature moves; deletions were never covered,
because until something asked every route the same question at once, each route's promise
lived in whichever test its author happened to write. Fixing it found two more, and
attacking the battery found three against itself.

**Two of the round-2 findings were false, and one mechanism explains both.** `review`
does report inherited registry rot, and `ack`'s ownership refusal does exit nonzero. Both
were written up as defects by a careful reporter because they print above a verdict line
that `| tail -1` destroys. That is why the fix for mechanism 4 went in second rather than
last: an output surface a reader cannot reach manufactures false bug reports, and one of
them nearly cost a working feature a rewrite.

**Dogfooding caught the fix for mechanism 3 over-firing.** Counting every unreproduced
finding as unadjudicated made codument's own gate warn on this very release, because a
judgment call names no test and never could — which would put the line on nearly every
honest review and teach the reader to skip it. Narrowed to a reproduction the gate could
not perform, which is the field's actual shape and the only one the reader can act on.
The cries-wolf failure arrived through the fix for a different one, which is worth
remembering: this release fixed two surfaces for crying wolf and briefly built a third.

**The standing acknowledgment turned out to be self-limiting, which is the design
working.** It binds to *every* doc that owns the file, so on a file co-owned by a feature
whose contract really does move with it — most of this repository's `src/lib` — a standing
vouch would die immediately and buy nothing. It is attractive exactly where the field
needed it (a locale namespace whose changes are homogeneous with respect to its doc) and
unattractive everywhere else, without a rule saying so. The hole worth naming is the one
the adversarial pass found: a vouch signed under one owner outliving a second feature's
claim on the same file. It answers to the owning set as the registry reads it *now*.

Left standing, deliberately: the open question about a standing vouch over a risk-tagged
feature was answered as recommended — allowed, and rendered loudly at signing rather than
forbidden.
