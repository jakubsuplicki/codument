---
status: accepted
date: 2026-08-16
---

# 021 — An attestation binds and discloses what it was grounded in

## Context

The adversarial-review gate was built on a clean separation: `--bundle` assembles the oracle a reviewer attacks, `--record` writes an artifact bound to the diff, and the two never touch. The bundle is a projection with no authority, so tying the artifact to it looked like coupling for its own sake — the artifact's job was to say what was reviewed and what was found, and the fingerprint over sources and named tests already made "reviewed once, then edited" impossible.

A field session took that separation apart from three directions at once, and none of them is exotic.

A second `review --record` over one change set silently replaced the first. The filename was a digest of the diff fingerprint alone, which is a claim the artifact never made: the fingerprint says which change set was reviewed and nothing about who reviewed it, what they enumerated as checked, or what they found. What went missing was ten checked invariants, not ten findings — and keying on findings would not have saved it either, because a finding's named test is already folded into the fingerprint. What collided was precisely the part that was not.

Meanwhile the artifact recorded a verdict and nothing about the oracle behind it. Which invariants the reviewer was shown, which tests it was pointed at, which files it was told to attack — none of it was recorded, so a review of a stale or empty contract was indistinguishable from a review of a full one. And the fingerprint bound what was reviewed and what pinned it, but not what the reviewer was told to attack, so the documented contract and the must-not-break list could be rewritten after a review was recorded while the artifact went on covering the diff. That last case is not exotic at all: updating the owning doc in the same step is exactly what the delivery loop asks for.

The three share a shape. The artifact was trusted to describe a change, and treated as saying nothing about the conditions under which it was produced — so every fact about those conditions was free to move underneath it, and nothing anywhere would notice.

## Decision

**A review artifact is identified by what it attests, binds the oracle it attacked, and discloses whether it answered a bundle at all.**

1. **Identity is the whole attestation.** The stored filename is a digest of base, diff fingerprint, signer, checked invariants, findings, and bundle stamp. Re-recording an identical review is still idempotent and still overwrites in place; two genuinely different reviews of one change set are two files that both stand. The per-file hashes are excluded, because they scope the next bundle and attest nothing.

2. **Every covering artifact is enforced, not one of them.** Once two attestations of one change set can coexist, picking one is picking a verdict — and the arbitrary pick is the lenient direction, since the finding raised by the review that lost the toss would go unenforced. Claims two reviewers raised identically fold into one, so a shared claim's test runs once and the tallies count what was found rather than how many people looked.

3. **The oracle is bound.** The review fingerprint folds in a digest of exactly the doc sections the bundle handed over — the orientation layer and the invariants layer, per touched feature — taken from the bundle's own projection rather than re-read beside it. A rewritten contract or invariant list reopens the gate exactly as a rewritten source does. It is a **separate component and never joins the real-change set**, because that set also counts the change's size and so decides whether a diff is trivial enough to need no review: folding docs in would make every loop-compliant edit two real changes and retire the trivial fast-path.

4. **The grounding is disclosed, never demanded.** `--bundle` stamps its own content; `--record` records the stamp it answers, or records explicitly that there was none, and a present-but-malformed stamp is refused. An **unstamped review still clears the gate** and says so on the verdict line and above it. Refusing would dead-end the first review of any diff — whose own printed route never mentions `--bundle` — and would be walked past by anyone willing to omit one field. A guard that binds only the honest actor is not a guard.

## Consequences

**Good:** an attestation now answers the questions a reader actually has of it. Two independent reviews of one change set both survive and are both enforced. A review whose invariants were rewritten under it stops covering, which is the same auto-invalidation the acknowledgment protocol has always had, applied to the half that was missing it. And the disclosure makes an ungrounded review visible without making it impossible, which keeps the loop workable on the first review of any change.

**Bad / accepted:** every artifact recorded before this binds no oracle, so in-flight reviews reopen once on upgrade. That is fail-closed and correct — those reviews genuinely did not bind what they were handed — but it is a real cost for anyone mid-change. Re-recording a corrected review over an unchanged change set also no longer replaces the earlier one: both stand and both are enforced until the earlier file is removed, which is the price of never destroying an attestation silently. The window is narrow, because any fix to a reviewed source or a named test moves the fingerprint and retires the old artifact on its own.

**Supersedes in part:** the separation this feature was built on. The artifact remains independent of the bundle for **scope** — `--record` still fingerprints the whole change set regardless of what a delta handed the reviewer, and coverage stays whole-set equality, so a narrow read can never buy a broad pass. What it is no longer independent of is the **oracle's content**: the invariants the review was measured against are now part of what the artifact is bound to.

**Rejected alternatives:** *refusing an unstamped review* — it dead-ends the first review of any diff and binds only the honest actor, and the route the gate itself prints never mentions the bundle; *keying the filename on findings* — the named tests are already in the fingerprint, so it would not have prevented the field's own loss, which was of checked invariants; *folding the docs into the real-change set* — one variable feeds both the fingerprint and the change count, so it would have turned off the proportionality rule as a side effect of fixing an unrelated hole; *binding whole doc files rather than the two sections* — a typo in a Decisions section would reopen the gate, which is the cries-wolf failure this release is otherwise removing.
