---
status: accepted
date: 2026-07-01
---

# 012 — File-grain acknowledgment: conservative, binds file content, never masks a moved symbol

## Context

The change-control gate resolves a stale-doc flag two ways: update the owning doc, or record a per-symbol [acknowledgment](006-agent-judge-resolution-self-resolve-with-audit-trail.md) that binds a symbol's `from`→`to` fingerprint transition (a "refactor, no doc owed" decision that auto-invalidates on the next move). But two common changes have no symbol to ack. A purely-**additive** change (a new exported helper) reports "added, not changed" — an added anchor is not a moved anchor, so the per-symbol ack path refuses it. A **concept** doc is a file-grain umbrella (ADR 004): it wakes whenever an owned file's content moves, with no per-symbol anchor to bind. For both, the only way to clear the gate was to touch the doc — and the lightest touch is a `last_reviewed` date bump, which is not fingerprint-bound and does not auto-invalidate. That is a weaker artifact than an ack, and reaching for it was a papercut hit repeatedly while dogfooding.

## Decision

Add a **file-grain acknowledgment**: `codument ack <path>` (a bare repo-relative path, no `::symbol`) vouches that a file's *current content* owes no doc change, bound to the file's coarse content fingerprint so it auto-invalidates the next time the file changes — exactly like a symbol ack.

1. **Reuse the acknowledgment record and its trust model.** A file-grain ack IS an `Acknowledgment` whose `anchorId` is the bare path and whose `from`/`to` are the file's base→worktree *content* fingerprints. `parseAck`, `readAcks`, `ackCovers`, the audit trail, the independence check, and auto-invalidation all apply unchanged; `isFileGrainAck` distinguishes it by the absence of `::`. The gate verifies the ack's **form**, never its truth (ADR 006).

2. **Conservative — it never masks a moved symbol.** In the stale-doc computation a covering file-grain ack clears a file's *additive* (added/removed symbol), *concept* (file-grain umbrella), and *coarse/non-TS* staleness contribution. A `changed` (moved) owned symbol still wakes its feature — the file ack is applied per-anchor, skipping only added/removed anchors and the concept file-grain wake, never a moved one. A real contract change still owes a per-symbol ack or a doc update. The rejected alternative is a **coarse** whole-file ack that clears everything including moved symbols; rejected because it hands a cost-minimizing agent a one-command way to launder a real contract change — the exact over-acking abuse ADR 006 guards against.

3. **Over-acking stays visible — a file ack counts AS an ack.** The review resolution summary and the soak (`--log`) friction tally bucket a file-grain ack on the *no-doc-change-owed* side alongside per-symbol acks (a distinct `file-acked (additive)` line), never laundered into "resolved by doc update." The friction rate — the soak signal for the info-only→blocking flip — counts both ack kinds as friction, so a file ack cannot silently deflate it. This preserves the "over-acking is loud at the moment of the change" property for the new ack kind.

4. **The command guides, it does not blanket.** `ack <path>` records the file-grain ack and, when the file still carries an unacknowledged moved *owned* symbol, names it (symbol-ack it or update the doc) rather than pretending the file ack covered it. A parse-unevaluable file cannot be file-acked into freshness — the fail-loud stance holds.

This does **not** implement ADR 006's still-deferred signature-vs-body ineligibility hardening. The file-grain ack neither relies on nor weakens it: because a signature or body change is a *moved* symbol, the file ack simply never touches it.

## Consequences

**Good:** additive and concept changes get the same clean, fingerprint-bound, auto-invalidating resolution a moved symbol already had; the `last_reviewed`-bump workaround is retired; the conservative rule keeps the precise per-symbol gate's teeth intact; and over-acking remains visible for the new ack kind.

**Bad / accepted:** the agent's judgment that an additive change owes no doc line is prose-enforced, not test-backed — the same honesty-is-load-bearing floor every ack carries, kept honest by the visible file-ack rate and the auto-invalidating audit trail rather than by a truth check. A coarse-classified TS file (a barrel, `export =`, a parse residual) is acked at file grain with no per-symbol protection, because it has no per-symbol anchor to protect — the file ack is precisely the file-grain judgment for it.

**Rejected alternatives:** a coarse whole-file ack that also clears moved symbols (launders a real contract change); a new record type instead of reusing `Acknowledgment` (needless divergence from the shipped trust model); counting a file ack as a doc update in the resolution summary (hides over-acking); acking an added or deleted whole file (no content transition to bind — it genuinely owes doc attention).
