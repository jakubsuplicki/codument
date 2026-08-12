---
status: accepted
date: 2026-08-12
---

# 020 — A block must be provable

## Context

Three consecutive field reports put the same subsystem in their worst finding, and the reports were written by the agent that had just used the tool for real delivery work rather than by a reviewer reading it cold.

The evidence in them splits cleanly. Where the gate can see a contract move, the loop works: one session's first gate woke thirteen owned symbols and all thirteen were resolved by real doc updates, and a feature was built end to end out of a doc written to the standard without a single question going back to the human. Where the gate demands a judgment it cannot check, it collects ritual: seventy-two acknowledgments, thirty-eight already dead, twelve of them the same cosmetic sentence pasted across one visual tweak, several reduced to hyphenated slugs, and — by the reporter's own accounting — two doc edits written to turn the gate green rather than for any reader.

The mechanism is not laziness and does not respond to better wording. An agent cannot be made to exercise judgment by blocking its path; it can only be made to produce whatever artifact clears the block. Where the artifact is checkable — a doc changed, a file mapped, a test run — producing it *is* the work. Where it is unverifiable — a signature asserting "no documented contract changed" — the cheapest string that parses is indistinguishable from the considered one, at the moment of maximum pressure to move on. The degradation is not gradual: it appears on the first signature, not the fourth.

[006](006-agent-judge-resolution-self-resolve-with-audit-trail.md) built the acknowledgment as the escape hatch that keeps the gate from compelling mirror prose, and it was right to. [012](012-file-grain-acknowledgment-conservative-additive-residue.md), [017](017-registration-is-governance.md), [018](018-a-registry-entry-can-govern-a-tree.md) and [019](019-a-vouch-may-be-bound-to-the-doc-that-decides-it.md) each widened or re-bound that hatch to make the toll cheaper. Every one of them treated the toll as a given and worked on its price. None asked whether the toll should be charged.

## Decision

**The gate blocks only where the triggering event is structurally proven AND the fix it demands is checkable. Everything else is reported and never gates.**

Both halves are required. A proven event whose only resolution is an unverifiable signature is not a block; a checkable fix for an event the tool inferred is not one either.

1. **What keeps gating.** A signature move (the contract changed by construction — a doc update is owed and no acknowledgment has ever cleared one). An added or removed exported symbol (public surface appearing or vanishing is an event the parser proves; the file-grain acknowledgment remains its escape, because whether a new helper owes a doc line is a judgment the tool cannot make — but the event is real, so the ask is rare). A deletion of an owned file. An unmapped new source, a dangling registry pointer, a doc pointing at a path this change removed. A content change to a **risk-declared** file no adapter can read.

2. **What is reported and never gates.** A body-only move on an owned symbol. A content change to a blind file its owner declared no risk on. Both are still named, attributed, and carried in the impact ledger; only the exit code stops moving.

3. **Risk is the one place an unprovable block is still bought, and it is bought narrowly.** A file no adapter can read is exactly where the tool is least able to judge and the signer most able to sign blind — the field's own worst case rode a truthful comment acknowledgment over a rules change making private data world-readable, to a clean signed gate. Where a project has declared that risk on the owning feature, the block stands and the changed lines are disclosed at signing. This is deliberately narrow: the declaration is an act someone committed, and it applies only at blind file grain, because on a file the adapter *can* read the signature/body split already carries the contract question and a feature-level risk tag is too coarse to decide a body move.

4. **Enforcement of what stops gating moves to the workflow, not to nothing.** The delivery loop reads the report; the report still says a body-only move happened and which doc owns it. What changes is that a step is no longer blocked pending a signature nobody will read back.

## Consequences

**Good:** the exit code becomes trustworthy in the only way that matters to its main consumer — nonzero means the tool can prove something is wrong and can check the fix. Every remaining ask is an event the parser proved, so a signature is rare enough to be worth writing carefully. Against the field ledger this deletes roughly fifty of seventy-two acknowledgments, all of them tolls on wakes that never produced a doc line.

**Bad / accepted:** a body-only change that silently alters documented behavior no longer blocks. This is a real loss and the reason the decision was contested rather than obvious. Two things bound it: co-movement telemetry already measures exactly that class — a body move whose owning prose did not move — so a rise in genuine rot after this change is visible as data rather than as faith; and the class it gives up was, on the evidence, the one already being cleared by reflex rather than by reading.

**Supersedes in part:** [017](017-registration-is-governance.md) — registration remains a claim of governance and a registered blind file is still watched and reported, but governance no longer implies a block. Its motivating false green (a registered contract file rewritten to say something else, passing `--strict`) returns for blind files whose owner declared no risk, and the risk declaration is the sanctioned way to keep it. The downgrade is never silent: every governed blind file that loses its block is named at upgrade, with the one-line declaration that restores it.

**Retires:** [019](019-a-vouch-may-be-bound-to-the-doc-that-decides-it.md). A standing vouch existed to stop a recurring judgment being re-signed on every unrelated content change. Body-only moves no longer gate, so the judgment is not requested again and there is nothing to stand over. The record format stays parseable and existing standing records are labeled obsolete rather than silently ignored — the decision chain is preserved, not deleted, and 019's reasoning about binding a judgment to its premise remains the correct answer to the question it was asked. That question stopped being put.

**Rejected alternatives:** *keeping the block and improving the prompt* — six releases of wording changes, and degradation appears on the first signature, so the lever does not exist; *demoting additive moves too* — public surface appearing is a proven contract event and the file-grain escape already keeps it cheap, so blocking there costs little and catches real omissions; *a compatibility mode preserving the old scope* — two gating universes to test forever is the maintenance disease this plan exists to cure, and 0.x is where a default may move; *attributing body moves by whether the doc mentions the symbol* — the documentation standard deliberately removes symbol names from prose, so that test would gate the mirror docs it forbids and exempt the intent-altitude docs it demands, inverting the standard.
