---
status: accepted
date: 2026-08-09
---

# 018 — A registry entry can govern a tree, and one acknowledgment answers for it

## Context

[017](017-registration-is-governance.md) made a registration a claim of governance: an owned file the gate cannot judge is still gated at file grain. It settled what a registration *means* and left untouched what one *costs*.

A second field run answered that. Six language packs — 120 files, about 5,400 user-visible strings — landed in an Expo app under the gate and reported as `60 other`, exit 0. Not a false green in 017's sense: nothing claimed those files, so nothing governed them. They were unclaimed because claiming them meant typing 380 paths into `docs/.registry.json` by hand. The one locale file that *was* governed got there because somebody typed it.

The same arithmetic ran on the other side of the loop. An acknowledgment binds one path and expires when that path moves again ([012](012-file-grain-acknowledgment-conservative-additive-residue.md)) — the safety property, not a defect. But a correction pass across 27 locale files owes 27 acknowledgments, and the field repo finished the run carrying 345 of them, two of which were the same judgment about the same file made twice.

So the two findings are one problem seen from both ends. The 380 registry lines and the 345 signatures are the same missing unit: there was no way to say "this tree is one governed thing", and therefore no way to answer for it in one line. Registration is governance, and a grain that only registers one file at a time makes governance unaffordable exactly where the file count is highest and the per-file judgement is lowest — nobody reads a locale pack file by file, and nobody should have to sign for it that way.

## Decision

**A `primary_sources` entry may name a tree, and one acknowledgment can answer for it.**

1. **A pattern is a source entry, not a new field.** A glob, or a directory written with a trailing slash (sugar for its whole tree, because people write `i18n/locales/` and mean the tree). It resolves through the same globber the exclusion spec and a plan's Feature Map already use, so "what does this pattern match" has one answer everywhere. A second field would make every consumer ask twice and let the two answers disagree.

2. **Ownership and the health surface both read it as a registration.** A tree owns the files it matches — for the gate, and for the coverage and lint questions that were only ever asked of paths. A pattern does not change what the ownership ratio counts, because it resolves against the same discovered source set: a locale tree was never in that denominator, so governing it moves the gate and never the score. Growing a published number by an otherwise-invisible route is how a number stops meaning anything.

3. **A governed tree wakes its doc once**, named as the tree with a count of what moved inside it. A wake per file trades a silent surface for an unreadable one, which is how a gate gets switched off.

4. **An acknowledgment can bind to the tree, and it is judged whole.** The record names every path it vouched for with that path's transition — not a combined digest, because an acknowledgment nobody can read afterwards is a signature on a blank page. It stands only while that entire set is unchanged: one member moving spends it, a file *appearing* under the pattern spends it, and a file leaving the change spends it too. Auto-invalidation is unchanged from 012; what changed is the size of the thing one signature can be bound to, never whether it decays.

5. **Only a declared tree is ackable.** The width is earned by a registration someone committed, never by the glob typed at the prompt — otherwise one argument would clear every coarse wake in the repository. This is 017's rule pointed at the resolution side: the registry is the claim, and the claim is what a wide vouch answers to.

6. **The exclusion spec still wins, and an explicit path beside a covering pattern is a refinement.** A pattern cannot re-admit what the spec drops. A path named in another entry alongside a covering tree is how one file is promoted to its own owner without dismantling the tree; the same path inside the covering entry only restates the pattern, and is linted as such. `map materialize` refuses a file a tree already governs and names the entry, because materializing it would grow back the lines the pattern exists to replace.

## Consequences

**Good:** the largest ungoverned surface in the field repository becomes governable for one line; answering for a translation drop costs one signature instead of one per file, and it still decays the moment anything in the tree moves; the wake and its answer share a grain, so the tree that fires once is answered once. Registration stops charging most where judgement is lowest — the reason the per-file grain went unpaid rather than paid carefully.

**Bad / accepted:** one acknowledgment over 120 files does carry the risk that a contract change is hiding among them, and no reading of the diff by the tool can find it. That is the trade the declaration makes, so it is disclosed rather than refused — the count is stated as the ack is written, in `ack --list`, in the audit card, and in the event log. A tree is governed at file grain by construction (no adapter reads these files, per 017), so the gate can say a tree moved and never what moved inside it. And a registry that lists paths keeps working unchanged: collapsing it into a pattern is the user's call, never a rewrite codument performs.

**Rejected alternatives:** *a combined fingerprint over the matched set* — cheapest, and it leaves the record unable to say what it vouched for; *per-file coverage inside one record* — most precise, and it buys nothing here, because the wake is all-or-nothing at the tree, so files would read "covered" under a doc that is stale anyway, and coverage disagreeing with the wake is worse than either extreme; *letting a new file ride under an earlier acknowledgment as additive residue* (012's rule for symbols inside a file) — a new file under a pattern is a new governed unit, and adding a language is the change in a locale tree most worth seeing; *patterns in `related_sources`* — impact-only registration already costs nothing to skip, so the expense this removes is on the ownership path; *a per-entry opt-in flag for tree mode* — the pattern is already the opt-in, and a second switch would let one registration mean two things.
