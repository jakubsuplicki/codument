---
status: shipped
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
- `src/commands/context.ts`, `src/lib/context-pack.ts` — the lean ownership answer, and the
  ownership resolution behind it routed through the shared source matcher (a file a registered
  tree pattern governs is owned, not unmapped); `src/cli.ts` and `src/index.ts` carry the flag
  and the export
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


## How it landed

Five steps, five commits, in the order written. Two things are worth keeping.

The third step's finding was not the one the step was for. Building the Decisions
note meant reading how sections are scoped, which is how the heading match turned out
never to have worked on a CRLF checkout: a carriage return terminates a line in
JavaScript, so every heading in every doc read as not-a-heading and the whole file was
scored as one block. Section awareness had therefore been dead on Windows since it
shipped — and because it also carries the Key files exemption, `path-enumeration` was
firing on sections *because* they comply. A heuristic that fires on compliance is worse
than one that misses, and this one was invisible: each finding still read as plausible.

The fourth step widened past its own scope for the same reason the third did. The lean
answer is only worth having if it is right, and ownership was resolved by comparing
literal strings — so a file a registered tree governs came back owned by nobody, which
is the worst available answer about a correctly-registered file. It is the same
literal-only assumption plan 43 had already found in the health surface; one lookup
now runs through the matcher every other surface uses.

Left standing, deliberately: five docs in this repository now carry an
`unsourced-decision` note, including one edited in the final step. The note is
info-only and unsoaked by design, and answering it properly means deciding which of
those decisions deserve an ADR — a pass of its own, not a tail on this one.
