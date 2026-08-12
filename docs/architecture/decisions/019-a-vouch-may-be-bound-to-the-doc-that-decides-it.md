---
status: superseded
date: 2026-08-10
---

# 019 — An acknowledgment may be bound to the doc that decides it, not to the file's bytes

> **Superseded by [020](020-a-block-must-be-provable.md).** The reasoning below is unchanged and still correct for the question it was asked: a judgment should be bound to the premise that can falsify it, not to bytes that cannot. What changed is that the question stopped being put. A standing vouch existed so that a recurring judgment about a body-only change was not re-signed on every unrelated edit; under 020 a body-only move is reported and never gated, so the judgment is never requested and there is nothing to stand over. The flag is refused and existing standing records are labeled obsolete rather than silently ignored. Kept intact so the chain reads.

## Context

[012](012-file-grain-acknowledgment-conservative-additive-residue.md) bound a file-grain vouch to the file's content transition, and [018](018-a-registry-entry-can-govern-a-tree.md) widened the *size* of the thing one signature answers for without touching what it is bound to. Both rest on the same safety property from [006](006-agent-judge-resolution-self-resolve-with-audit-trail.md): a vouch expires the next time its subject moves, so nothing rides forever.

A field session showed the cost of paying that property in the wrong currency. One locale namespace was acknowledged four times across four delivery steps with four near-identical reasons — three already dead by the end, in an ack list where 29 of 55 were dead. The judgment being re-made each time was *"string additions to this namespace owe no line to this doc"*. That is true until the doc's claims move. It is not true only until the file's bytes move, and bytes were what the record watched.

The warning naming the cost printed under every finding, was read at least five times, and changed nothing, because acting on it meant restructuring the work rather than the acknowledgment. A signature charged for a question that cannot have changed its answer is a signature that stops being read — which is the same failure as a gate people learn to bypass, arriving through the resolution side instead of the verdict side.

## Decision

**A file-grain acknowledgment may be bound to the docs whose claims decide it. It then stands across later content changes and dies when any of those docs moves.**

1. **The binding is the owning docs, resolved from the registry.** Not a doc named at the prompt: the vouch must watch what actually gates the file, and a doc the signer typed could be one nothing wakes. A file no feature owns has no doc whose claims decide anything, so a standing vouch over it is refused rather than bound to nothing. It answers to that set as the registry reads it **now**, not as it read at signing: ownership widens — a second feature claims the file — and a vouch that kept clearing then would be settling a doc its signer never read, indefinitely and silently. Because the record's hash covers each doc's path as well as its content, one comparison catches both a doc whose claims moved and a doc that was never in the room.

2. **It dies on any content change to those docs**, not only on a move in the layers it could be about. Nothing can tell a claim from a typo, and a doc edit is rare beside the source edits this grain exists to absorb — so the coarser rule costs a re-signing that is small beside the four it replaces. Auto-invalidation is unchanged from 006; what changed is *what* it is bound to, never *whether* it decays.

3. **File grain only.** A symbol's contract is decided by its own signature, so binding one to a doc would watch the wrong thing while the contract moved underneath. A tree's decay when a member appears is the guard 018 rests on — adding a language is the change in a locale tree most worth seeing — and standing over a tree is precisely what removes it. Both refusals are by name, routing to the grain that does apply.

4. **The limits of a file-grain vouch are untouched.** It still never clears a moved owned symbol, still never reaches an added file or a deletion, and still counts as an acknowledgment rather than a doc update in every tally.

5. **Width buys no silence.** The vouch states what it spans at signing time — the file, the doc that ends it, and any risk tag on the owning feature — is marked *standing* wherever a recorded ack is read, and every review it covers something names what it swept. A vouch that answers for changes nobody has made yet is the widest artifact the format has, and the only thing keeping it honest is that it is never quiet.

## Consequences

**Good:** the recurring judgment is made once and re-made when its premise moves. Four signatures over one locale namespace become one; the ack list stops filling with dead near-duplicates of the same sentence; and the surface that warns about the cost no longer warns about a cost the tool itself imposes.

**Bad / accepted:** a standing vouch covers changes that do not exist yet, so a contract change can hide in one exactly as it can hide in a tree vouch, and no reading of the diff by the tool can find it. That is the same trade 018 made, and it is paid the same way — disclosed rather than refused. Concretely, the sequence 012's grain permitted at its worst (a rules edit riding a truthful comment ack to a signed green gate) now needs no re-signing at all, which is why per-review naming of the sweep is part of this decision rather than a follow-on.

**Rejected alternatives:** *binding to the doc's individual claims* — the precise reading, and undecidable without a model on the resolution path, which is the boundary the whole design holds; *a time or step budget on a content-bound vouch* — the clock is excluded from the verdict path by 003 and would be no more honest here; *raising the ack to the tree so one signature covers the namespace* — the field's case was one file, and it would inherit the tree grain's decay on any member move, reproducing the problem; *making standing the default for coarse files* — the width has to be an act someone chose, for the same reason a wide vouch is earned by a committed declaration rather than by a glob at the prompt.
