---
status: accepted
date: 2026-06-29
---

# 010 — Freshness resolution: detect deterministically, verify by tests, resolve agent-driven — never by symbol-name matching

## Context

The gate proves one thing soundly: a documented symbol *moved*. But "is the doc's prose still true?" is undecidable by a deterministic checker — it needs understanding, not pattern-matching. The danger is letting a cheap structural proxy masquerade as a truth verdict.

The deterministic *verdict* already does the right thing: a documented symbol's owning doc is stale only when its owned source moved **and** the doc file did not change in the same diff, with acknowledged moves removed first. So a doc edit clears it (file-grain) or an ack clears it, and co-movement is not a verdict input — exactly [005-co-movement-info-only-telemetry](005-co-movement-info-only-telemetry.md). The defect is one layer up: the **agent-facing surface** (the `review` symbol-drift list and its "reconciled / still flagged" counts) categorizes findings by *co-movement* — whether the doc names the moved symbol. The documentation standard forbids naming symbols (intent altitude), so the surface (a) still nags "still flagged → update the doc" after a correct intent-altitude update even though the verdict already passed, and (b) shows a symbol-mirror doc as "reconciled". Proven by controlled test: an intent-altitude doc edit yields `--strict` exit 0 (verdict clear) yet the display reads "1 still flagged"; a symbol-naming edit reads "1 reconciled". The surface misrepresents the verdict and quietly rewards the rot the standard bans.

Compounding it, the value only lands if the agent is actually *driven* to run and resolve the gate. On a real run (the peelmeal runware migration) the tooling existed but was never invoked: 31 symbols moved and the *display* showed 27 "still flagged" — mostly a co-movement artifact, since the flow had updated many of those docs (the verdict credits that), and nothing enforced a resolve step. A tool that is not agent-driven, and whose surface misreads its own verdict, delivers nothing.

## Decision

The freshness gate is layered by what is decidable, and never lets a proxy pose as proof:

1. **Detect deterministically, claim only movement.** A moved documented symbol with no addressing is a *notification* ("look here"), never a claim that the prose is false.
2. **Resolution is intent-altitude-friendly and one cheap move, and the surface must mirror the verdict.** A flag clears iff the owning doc was edited in the same change (you updated it) **or** an acknowledgment records a judgment (internal refactor / reviewed-no-change-needed) — which the verdict already does. The agent-facing surface (the symbol-drift list and its counts) must categorize "resolved vs still flagged" by that same rule, never by co-movement. Symbol-name matching stays pure info-only telemetry that *prioritizes* attention and never decides resolved/flagged on the actionable surface — restoring 005's intent everywhere, not only in the verdict.
3. **Truth that matters is bound to tests.** Load-bearing claims are invariants linked to their enforcing test, which is deterministically verifiable across any refactor; the gate trusts those. Prose truth beyond them is the agent's judgment, verified-not-trusted, with no LLM on the verdict path.
4. **Agent-driven by default.** The loop and skills make the agent run `review` and resolve every flag (update-or-ack) inside work-step / commit, so flags never accumulate. The human is engaged only for genuine ambiguity, planning, and grilling — never to babysit the tool.

## Consequences

**Good:** a doc written to codument's own standard can satisfy the gate; the gate stops rewarding symbol-mirrors; the signal becomes trustworthy enough to rely on (and to later colour a human-facing dependency/health graph from the same registry + import-graph data); the verdict is honest about what it proves.

**Bad / accepted:** clearing is **file-grain** — a doc edit clears that file's flagged symbols; the gate cannot prove each symbol was individually addressed. Accepted, because the gate never verified prose truth anyway and the load-bearing claims are carried by test-backed invariants. Acks stay trust-based (a lazy ack clears without a real change); bounded by the audit trail and soak telemetry, not eliminated.

**Rejected alternatives:** name-matching as a verdict input (contradicts the doc standard and rewards rot — the bug this closes); an LLM judge on the verdict path (non-deterministic, non-reproducible); requiring symbol names in docs (defeats the standard); a per-symbol "prove this exact symbol was addressed" check (undecidable without names or a model).
