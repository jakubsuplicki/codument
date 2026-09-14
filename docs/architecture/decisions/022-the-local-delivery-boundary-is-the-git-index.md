---
status: accepted
date: 2026-08-24
---

# 022 — The local delivery boundary is the Git index

## Context

The local gate currently evaluates every dirty path in the working tree. That makes its answer
depend on unrelated edits left by a user or another agent, while the approved plan scope only labels
scope creep and never identifies which dirty files belong to the active step. A step baseline cannot
separate two edits made after it, and a Codument-owned change manifest would duplicate a boundary Git
already maintains.

The result is a gate over the workspace rather than the change being delivered. It also leaves tests,
review artifacts, and printed remedies reasoning about different path sets, so narrowing only the
headline command would make the surfaces disagree rather than make the workflow focused.

## Decision

**The authoritative local delivery boundary is the staged index: the exact snapshot the next commit
will contain.** CI keeps its merge-base-to-head range, and an explicit staged path selection is
available for focused inspection, but it earns a commit pass only when it covers the complete staged
set.

1. A first-class change-set projection carries the mode, base, selected paths, additions, deletions,
   renames, and content fingerprint. Change-control analysis, test impact, acknowledgments, review
   bundles, review artifacts, and verification receipts all consume that same projection.
2. A staged path whose working-tree bytes differ from its index bytes fails closed before analysis.
   The current analyzers and test runner read the filesystem; allowing partial staging would claim to
   verify bytes they did not inspect. Dirty paths outside the staged set are counted and reported but
   never block the staged change.
3. Tests participate as evidence, not documentation owners. A staged test is attributed through an
   explicit invariant pin first and a supported direct import second; it affects impact and review
   fingerprints but never creates a registry or prose obligation. Unattributed tests stay visible.
4. The normal local surface is one compact verification command. It enforces documentation sync and
   adversarial-review coverage over the staged set, prints only actionable failures by default, and
   exposes the complete diagnostic report on demand. A successful result may be cached only against
   the exact staged fingerprint; any index change invalidates it.
5. Existing working-tree review remains an explicit diagnostic and compatibility surface. The new
   boundary does not reinterpret historical review commands or whole-repository health checks.

## Consequences

**Good:** unrelated unstaged work no longer blocks a focused commit; the gate, its evidence, and its
artifacts agree on what “this change” means; tests become visible without being turned into prose;
and the ordinary green path has one command instead of a sequence of overlapping checks.

**Bad / accepted:** the workflow stages before review, and a partially staged in-scope file must be
restaged or reverted before it can be verified. Two actors sharing one index still share one delivery
boundary—already-staged work is part of the next commit, not background noise. Tracked test inputs
follow the index even when working copies differ. Execution is not hermetic: installed dependencies
remain shared environment, and a missing generated input that prevents test loading is reported as
unavailable rather than a reproduced assertion failure.

**Compatibility:** CI remains range-based and authoritative. Existing `review`, `doctor`, and report
surfaces keep their established defaults during the migration; the focused verification command is
the new workflow entry point rather than a silent semantic change to every caller.

**Rejected alternatives:** approved-plan scope as the boundary—it describes allowed work for the
whole plan, not the bytes in one step; a step-start baseline—it cannot distinguish concurrent edits
made after the same baseline; a Codument change manifest—it adds authoring and synchronization
ceremony beside Git's existing commit manifest; silently accepting partial staging—it would verify
working-tree bytes while committing different index bytes.
