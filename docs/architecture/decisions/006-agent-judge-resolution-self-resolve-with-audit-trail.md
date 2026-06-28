---
status: accepted
date: 2026-06-28
---

# 006 — The agent self-resolves drift, kept honest by a durable audit trail

## Context

A drift flag needs resolving. A human triage queue is friction and does not scale; the agent that made the change already has the context to resolve it. The risk is the opposite of friction: acking is cheaper than reading the symbol and writing intent prose, so a cost-minimizing agent's dominant strategy is to ack everything and silently reproduce the staleness the gate exists to prevent.

## Decision

Resolution is the **agent's job, inline**, as part of the same change (autopilot-aligned), pulling in a human only on a genuine judgment call or a change touching a public interface, security, data loss, or anything ambiguous. On each flagged move the agent makes a two-way call: **update** the owning doc at intent altitude, or **acknowledge** a contract-neutral move with a reason that names the invariant that stayed constant. An acknowledgment is a loose, reviewable, fingerprint-bound record; it **auto-invalidates** when the anchor moves again (no ride-forever exemption), and a signature change is **ineligible** (a doc update is mandatory).

The default is self-resolve, kept honest **not by a human wall but by a durable, fingerprint-bound, auto-invalidating audit trail** — independence (a signer distinct from the change author) is an opt-in strict mode, deferred. Over-acking is countered at the moment of decision: an update-the-doc default bias, a review that renders **both** arms of the fork (never just the ack command), and a first-class per-run ack-rate that makes an all-ack change loud rather than a quiet green.

## Consequences

**Good:** correct docs fall out as a byproduct of the work with no separate chore; self-acks are auditable and self-expiring; over-acking is visible.

**Bad / accepted (honest ceiling):** the gate verifies an ack's **form** (it exists, names the exact moved fingerprint, is attributed) — never its semantic truth; a born-wrong or already-drifted doc is out of scope. Default mode trusts the agent with a record, not a second-party gate.

**Rejected alternatives:** a human triage queue for every flag (friction, does not scale); mandatory second-party independence in the default flow (deferred to opt-in strict mode); four claimed "teeth" the mechanism does not actually have (stated honestly as one record-keeping wall instead).
