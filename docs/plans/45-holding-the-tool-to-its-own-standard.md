---
status: approved
---

# Plan 45: hold the tool to the standard it enforces

The last of the 2026-08-09 field-report tail, folded into 0.16.0 rather than deferred.
Every item here is codument failing a rule codument enforces on everyone else: it
writes litter it would call generated leakage, it does not check the compaction its
own standard mandates, it accepts a Decisions layer it tells authors not to write, and
it makes the one lookup its loop needs most cost a full context pack.

Approved by the user's instruction to fold the remaining fixes into this release; each
mechanism below was reproduced against the code before being written.

Verified mechanisms:

1. **`codument update` writes a backup when nothing would be lost.** The merge
   decision reads three inputs — upstream, current, and the hash recorded at install —
   and calls it "both changed" whenever neither matches the stored hash. But an
   upgrade where upstream and current have *converged* trips that too, so the file is
   backed up and overwritten with content identical to what was already there.
   Reproduced during this release: one `codument update` left **21 untracked
   `.backup` files** and not one tracked modification. Nothing gitignores them and
   nothing sweeps them, so every upgrade adds a layer of litter to the user's `git
   status` — from the tool whose whole subject is not leaving mess in a repository.
2. **Nothing checks the compaction the standard mandates.** The documentation standard
   requires a shipped feature or concept doc to carry only its durable layers: when
   the last step lands, the Delivery Plan block is compacted out and surviving
   decisions move to Decisions or an ADR. `doctor` reads every registered doc for
   bloat, thinness, link rot and altitude — and never asks the one question the
   standard is most explicit about. This repository obeys the rule only because it is
   done by hand, every time, which is precisely the kind of enforcement the tool
   exists to replace.
3. **The Decisions layer is allowed to state conclusions with no evidence.** The
   standard is explicit that Decisions are pointers — "the durable why; reference,
   never restate". A bullet that asserts a conclusion and cites nothing is a decision
   nobody can re-derive or contest, which is how a wrong recorded decision survived
   two attempts to fix the thing it was wrong about.
4. **The loop's most common lookup costs a full context pack.** Before editing a file
   an agent needs one fact: which doc owns it. `context --file` answers it inside a
   pack that runs to thousands of tokens of orientation and invariants — the right
   answer to a different question, and expensive enough that the cheap habit is to
   skip the lookup and guess.

## Why

- Three of the four are the tool applying a standard outwards and not inwards. That is
  not an aesthetic complaint: the enforcement gap is exactly where the field agent's
  trust was spent, because a rule that is mandated and unchecked reads as optional.
- The fourth is the cost argument this whole release is about, one level down. A
  lookup priced at thousands of tokens is a lookup that gets skipped, and a skipped
  ownership lookup is how a file lands in the wrong feature.

## Scope

- `src/commands/update.ts` — a backup is written only when something would be lost
- `src/lib/analyze.ts` — the shipped-scaffolding finding
- `src/lib/prose-altitude.ts` — the evidence-free Decisions note
- `src/commands/context.ts` — the lean ownership answer
- `docs/features/registry-health.md`, `docs/features/agent-delivery-workflow.md`,
  `docs/concepts/doc-audience-layers.md`, `CHANGELOG.md`

## Non-goals

- **No change to what a backup means when one is warranted.** A genuine local
  divergence is still preserved; what stops is writing one when the two sides already
  agree.
- **No new blocking condition from the altitude side.** The Decisions note rides the
  info-only Notes channel with its three siblings, so `--strict` exit codes do not
  move. The scaffolding finding is a real lint, because it is a fact about the
  document rather than a heuristic about its prose.
- **Not orphan prose pages.** Naming a page nobody owns needs a decision about which
  trees are expected to be owned — `docs/plans`, `docs/guides` and the ADR tree are
  legitimately unowned, so widening the existing rule would produce dozens of findings
  that are all correct behaviour. That one still needs its own plan.
- **Not the unreproduced bundle-delta claim.** It needs a session to reproduce from,
  not code.

## Delivery Plan

Status: approved.

- [x] Step 1: `codument update` writes a backup only when the local file and the
      upstream one actually differ; converged content is a skip, not a merge. Test: an
      upgrade whose upstream matches the local file writes no backup and reports a
      skip; a genuine divergence still backs up and still overwrites.
- [x] Step 2: `doctor` names a registered doc that still carries delivery scaffolding
      after its plan shipped. Test: a doc whose checklist is fully checked fires; one
      with unchecked steps does not; a doc with no scaffolding is silent.
- [x] Step 3: A `## Decisions` entry that cites nothing is an info-only altitude note.
      Test: a bare conclusion fires; an entry pointing at an ADR, a test, or another
      doc does not; `--strict` exit codes are unchanged.
- [ ] Step 4: `context --file` answers ownership in one line under `--owner`. Test: the
      lean answer names the owning doc for a single-owner file, every candidate for a
      shared one, and says plainly when nothing owns it.
- [ ] Step 5: Docs at intent altitude across registry-health, the delivery workflow and
      the audience-layers concept, and CHANGELOG folded into the 0.16.0 section.

## Outcome

Once every step lands:

- **An upgrade leaves the repository as clean as it found it.** No `.backup` file
  unless a local edit genuinely would have been lost.
- **The compaction rule is checked, not merely written down.** A shipped doc still
  carrying its delivery checklist is named by the surface that reads every doc.
- **A recorded decision has to point at something.** The layer meant to be a set of
  pointers stops accepting bare assertions, info-only until its false-fire rate is
  known.
- **The ownership lookup costs a line.** The thing an agent needs before every edit is
  cheap enough to actually run.

What this deliberately does not do:

- It does not judge whether a Decisions entry's evidence is *good* — only that there
  is some. Citation is checkable; sufficiency is not.
- It does not compact anything automatically. The finding names the doc; a human or an
  agent decides what survives, because that judgment is the whole point of compaction.

## Acceptance criteria

- A no-op `codument update` on this repository leaves `git status` clean.
- `doctor` fires on a shipped doc carrying a completed checklist and stays silent on an
  in-flight one.
- The Decisions note rides Notes and `doctor --strict` still exits on the same four
  findings as before.
- `context --file --owner` answers in one line, and the full pack is unchanged without
  the flag.

## Verification strategy

- Red-green per step with a mutation check on each new test.
- The `--strict`-unchanged and pack-unchanged claims are pinned by test, not asserted.
- Full suite on Windows against the known 31 pre-existing failures; `codument review
  --strict` green before each commit.
