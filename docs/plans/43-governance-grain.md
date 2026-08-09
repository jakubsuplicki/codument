---
status: approved
---

# Plan 43: a tree can be governed, and acknowledging one costs one line

Findings 4 and 5 of the 2026-08-09 Expo field report. Six new language packs — 120
files, about 5,400 user-visible strings — landed with the gate reporting them as `60
other` and exiting 0. Not a false green in the ADR-017 sense: the files were never
registered, so nothing claimed them. They were never registered because registering
them means writing 380 paths into `docs/.registry.json` by hand, and the one locale
file that *was* governed got there because someone typed it.

Verified mechanisms, each checked against source:

1. **`primary_sources` is exact-match only.** The file→feature map is built by pushing
   each listed string into a `Map` keyed by path; a changed file is looked up by exact
   key. There is no pattern resolution anywhere on the ownership path, so "govern this
   directory" has no expression, and the cost of governing N files is N lines.
2. **The codebase already treats a glob as a routing token — just not here.** The
   exclusion spec resolves declared globs through `globToRegExp`, and a plan's Feature
   Map routes source paths through the same function. Ownership is the one surface
   that never learned it.
3. **Acknowledgment cost scales with files touched, not with the change.** An ack is
   fingerprint-bound to one path and auto-invalidates when that path moves again
   (ADR 012, and that is the safety property, not a defect). A change that edits 27
   locale files owes 27 acks; a file touched in two consecutive steps owes two. The
   field repo carries 345 acknowledgments, and two of that session's three were the
   same acknowledgment about the same file, made twice.
4. **The wake is per file, so a tree would shout.** Even registered, a 380-file tree
   would wake its doc once per changed file and print a route per file — trading
   silence for noise, which is how a gate gets switched off.

## Why

- This is the largest ungoverned surface the field run produced, and it is
  user-visible product text. A translation drop can change what the app *says* to
  every user in a language nobody on the team reads, and the control plane has no
  opinion because nobody was willing to type 380 lines.
- It is the one finding where the tool's answer to "why didn't you govern it?" is
  "because we made it too expensive". Registration is governance (ADR 017); a grain
  that only registers one file at a time makes governance unaffordable exactly where
  the file count is highest and the per-file judgement is lowest.
- Findings 4 and 5 are one problem seen from two ends. The 380 registry lines and the
  345 acknowledgments are the same missing unit: there is no way to say "this tree is
  one governed thing" and therefore no way to answer for it in one line.

## Scope

- `src/lib/registry.ts` — a glob or directory is a legal `primary_sources` entry, with
  the authoring guard extended (a pattern matching nothing, or overlapping the
  exclusion spec, is refused by name)
- `src/lib/change-state.ts` — ownership resolves patterns; a governed tree wakes its
  doc once and is named as a tree
- `src/lib/fingerprint.ts`, `src/lib/acknowledgment.ts`, `src/commands/ack.ts` —
  tree-grain acknowledgment over the matched set's fingerprint
- `src/commands/review.ts` — the tree wake, its route, and the strict epilogue
- `src/commands/map.ts` — `materialize` refuses a file a tree already governs, and
  says which entry governs it
- `src/lib/analyze.ts` — lints for a pattern matching nothing and a pattern shadowing
  an explicitly-listed file
- `docs/architecture/decisions/018-*.md` (new ADR), `docs/features/change-control-gate.md`,
  `docs/features/registry-health.md`, `docs/features/feature-decomposition.md`,
  `CHANGELOG.md`

No new source files — no feature map.

## Non-goals

- **No pattern support in `related_sources`.** Impact-only registration already costs
  nothing to skip; the expense this plan removes is on the ownership path.
- **No per-symbol grain inside a tree.** A tree is governed at file grain by
  construction — these are files no adapter can judge — and ADR 017 already settles
  what that means.
- **No change to why acknowledgments expire.** Fingerprint-binding and
  auto-invalidation stay exactly as ADR 012 has them. What changes is the size of the
  thing one acknowledgment can be bound to, never whether it decays.
- **No retroactive migration.** An existing registry of explicit paths keeps working
  unchanged; collapsing it into a pattern is the user's call, never a rewrite codument
  performs.
- **Not the changed-file arithmetic, the review-bundle delta, or `doctor` in more
  places.** Those are plan 44.

## Decisions (settled)

- **A pattern is a `primary_sources` entry, not a new field.** A second field would
  make every consumer ask twice and would let the two disagree — the failure the
  derived id union in plan 42 was fixed to prevent. The pattern resolves through the
  same `globToRegExp` the exclusion spec and the Feature Map already use, so "what does
  this pattern match" has one answer everywhere.
- **A trailing-slash directory is sugar for `dir/**`.** People will write
  `i18n/locales/` and mean the tree; refusing it to insist on a glob is ceremony.
- **A governed tree wakes its doc ONCE per change**, named as the tree with a count of
  what moved inside it, never one wake per file. A wake per file trades a silent
  surface for an unreadable one.
- **An acknowledgment can bind to the tree**, over a fingerprint of the matched set —
  same construction as a file fingerprint, same auto-invalidation, so it decays the
  moment anything in the tree moves again.
- **An explicit path beside a covering pattern is a refinement, not an error.** The
  explicit entry owns that file; the pattern owns the rest. This is how a tree gets one
  file promoted to its own owner without dismantling the tree.
- **The exclusion spec still wins.** A pattern cannot re-admit what the spec drops, in
  keeping with the additive-only rule: expanding a pattern and filtering it is the same
  scope every other surface computes.

## Decisions (settled at approval)

- **A tree acknowledgment records the matched set explicitly — every path with its
  hash — and is valid only while that whole set is unchanged.** Three ways to build it
  were live. A single combined fingerprint is the cheapest and leaves no audit trail:
  the record cannot say what it vouched for, and an acknowledgment nobody can read
  afterwards is a signature on a blank page. Per-file coverage inside one record is the
  most precise and buys nothing here, because the *wake* is all-or-nothing at the tree
  level — files would sit "covered" while the doc they answer to is stale anyway, and
  coverage that disagrees with the wake is worse than either extreme. Recording the set
  and judging it whole gives the audit trail of the precise option with the semantics
  of the simple one, and keeps one grain for the wake and its answer.
- **A file APPEARING in the tree invalidates it too.** ADR 012 lets a file-grain ack
  skip symbols added inside a file it vouched for wholesale; a new file under a pattern
  is not residue, it is a new governed unit. Adding a language is the change most worth
  seeing, and letting it ride free under an earlier acknowledgment is the false green
  this grain exists to close.
- **The widening is disclosed, never hidden.** One acknowledgment over 380 files does
  carry a contract change hiding among them — that is the trade the declaration makes,
  and the honest answer is to print what it covered, not to refuse it. `ack` names the
  count as it writes, and `ack --list` shows it.
- **A pattern does not change what `doctor`'s ownership ratio counts.** The denominator
  comes from the project's source globs and a locale tree was never in it. A tree
  registration governs the gate, not the score; growing a scored ratio by an
  otherwise-invisible route is how a number stops meaning anything.
- **`map materialize` refuses a file a tree already governs, naming the entry.**
  Materializing would write the explicit path the pattern exists to avoid, and the
  refusal is the only moment the user learns the tree is doing its job.

## Delivery Plan

Status: approved.

- [x] Step 1: A glob or trailing-slash directory is a legal `primary_sources` entry and
      resolves through the shared matcher; the authoring guard refuses one that matches
      nothing or that the exclusion spec covers, naming which rule fired. Tests: a
      pattern owning a tree, a directory as sugar, an explicit path refining a pattern,
      a pattern matching nothing refused, the exclusion spec still winning.
- [x] Step 2: Ownership resolves patterns, and a governed tree wakes its doc once —
      named as the tree with the count of what moved inside it, never one wake per file.
      Test: the field's shape — a six-pack translation drop wakes one doc with one line.
- [ ] Step 3: Tree-grain acknowledgment over the matched set's fingerprint, auto-
      invalidating like a file ack; `ack <pattern>` records it, `review` prints it as the
      route, and the output says how many files it covered. Test: 120 changed files, one
      acknowledgment, and it decays the moment one of them moves again.
- [ ] Step 4: `map materialize` refuses a file a tree already governs and names the
      governing entry; `doctor` lints a pattern that matches nothing and one that shadows
      an explicitly-listed file. Test: the refusal names the entry, both lints fire.
- [ ] Step 5: ADR 018 for tree-grain governance, docs at intent altitude across the gate,
      registry-health and feature-decomposition, and CHANGELOG.

## Outcome

Once every step lands:

- **A tree can be governed for the price of one line.** Registering
  `i18n/locales/**/*.json` puts 380 files under the gate; a translation drop that
  rewrites what the app says to its users stops reporting as `60 other` and exit 0.
- **Answering for one costs one acknowledgment, not one per file.** The 27-file
  correction pass that produced 27 acknowledgments produces one, and it still decays
  the moment anything in the tree moves again.
- **The tool stops charging most where judgement is lowest.** The per-file grain is
  right where per-file judgement exists and wrong where it does not, and registration
  being unaffordable is the reason the largest surface in the field repo went
  ungoverned.

What this deliberately does not do:

- It does not judge a locale file's contents. A tree is governed at file grain because
  no adapter can read these files, exactly as ADR 017 already settles.
- It does not migrate anything. An existing registry of explicit paths keeps working;
  collapsing it is the user's call.
- It does not make an acknowledgment safer, only cheaper. One tree acknowledgment
  vouches for everything the pattern matched at that moment, and that widening is the
  trade the declaration makes — disclosed in the output, never hidden.

## Acceptance criteria

- A single `primary_sources` entry can govern a directory tree, and a change anywhere
  in that tree fails `codument review --strict` until it is resolved.
- That resolution costs one command, and the command printed is the one that works.
- A governed tree produces one wake and one route however many files moved inside it.
- A tree acknowledgment auto-invalidates on the next change to any file it covered, and
  its output states how many files it covered.
- An existing registry naming explicit paths behaves exactly as it does today —
  byte-identical output on this repo.

## Verification strategy

- Red-green per step, with a mutation check on each new test.
- Replay the field's shape end to end: a six-pack, 120-file translation drop against a
  registry with one pattern entry — red, one route, one acknowledgment, green.
- Full suite on Windows against the known 31 pre-existing failures; `codument review
  --strict` green before each commit, and `doctor --strict` unchanged at plan close.
