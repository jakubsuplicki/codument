---
status: accepted
date: 2026-07-01
---

# 011 — Plan adversary: human-adjudicated, grounded, no artifact — the plan-time twin of the review gate

## Context

The [adversarial review gate](../../features/adversarial-review-gate.md) proved the two-gate thesis at commit time: an independent adversary contests the diff, and its findings block only when a re-run test goes red ("verify, don't trust"). The symmetric need is to contest the **plan** before a line of code exists — the cheapest bug to kill is the one caught before it is written.

The tempting move is to port the gate wholesale: reuse the fingerprint artifact, a `--require-plan-review` flag, a `--record` writer, degrade to a same-agent pass on Codex. That is both unsound and over-built for a plan. Unsound, because a plan has no executable oracle — there is no test to re-run, so the impl gate's entire "the reproduction decides, never the agent" mechanism has nothing to stand on. Over-built, because the gate's artifact/confirm/flag apparatus exists for one reason: to bind a verdict across the **review-to-commit temporal gap**. A plan adversary surfaces synchronously into the approval moment the author is already sitting in, so there is no gap to bridge. A design stress-pass (three independent adversaries) confirmed both: the artifact/flag/confirm machinery is dead weight here, and a same-agent Codex self-critique labeled as a review manufactures false confidence.

## Decision

The plan adversary is the review gate's twin in stance but not in machinery. It is layered by what is decidable for a plan:

1. **Human-adjudicated, not test-confirmed.** The impl gate's soundness came from re-running a test. A plan has no such oracle, so the honest deterministic analog is **groundedness**, not correctness: an objection counts only if it cites a real committed constraint (a documented invariant, an ADR, a dependency edge, a Feature-Map row) the written plan contradicts, or names a concrete load-bearing assumption the grill left unresolved. The adversary surfaces grounded objections; the human decides at the existing approve/change gate. No LLM on any verdict path, no auto-block.
2. **No artifact, no flag, no confirm step.** The fingerprint artifact, `--require-plan-review`, `--record`, and the test-confirm are all omitted. Each existed solely to carry a verdict across the review-to-commit gap; the plan adversary has no gap to carry anything across, so there is nothing to re-derive or bind.
3. **Grounding piggybacks on the plan shape-check; it adds no new source of truth.** The oracle is a deterministic projection over `docs/.registry.json` and the committed feature docs — emitted by `codument map check --plan <doc> --json`, reusing the review bundle's own invariants/test-pointer extraction. Both hosts consume identical grounding, so an objection cites a real, written fact instead of a hallucinated one.
4. **Independence by fresh context, degraded honestly — never a self-critique posing as a review.** On a subagent-capable host the adversary is a fresh subagent with no author transcript. On a host without subagents it does **not** run a self-critique: unlike the impl gate — where a deterministic test still bites regardless of who reviews, which is exactly why its Codex same-agent pass is "not theater" — a plan has no backstop, so a self-graded "no objections" from the author is false confidence. The no-subagent host instead gets the grounding, a paste-ready prompt for a fresh session, and a plain statement that no independent pass ran automatically.
5. **Bounded by materiality, not a headcount; "no material objections" is the expected output.** An objection with no cited constraint is dropped, never softened into advisory padding. There is no cap — every grounded objection is surfaced, ordered most-serious-first, because truncating a grounded objection is a false negative, and a plan that contradicts many facts should say so plainly. A well-grilled, consistent plan correctly returns zero objections, and reaching zero is a success, not a skipped branch.

## Consequences

**Good:** the plan — the cheapest place a mistake lives — gets an independent check before any code is written; it rides the existing approval moment, adding no new ceremony, flag, or artifact; it reuses the shipped review primitive (grounding, fresh-subagent spawn) rather than a parallel one; and it is honest on every host about how much independence it actually has.

**Bad / accepted:** the adversary's quality is **prompt-enforced, not test-backed** — no deterministic gate forces its objections to be grounded or catches a fabricated one, the same honesty-is-load-bearing limit the impl adversary's *advisory* findings carry. It is bounded by the agent mandate and by the human doing the adjudication, not eliminated. And on a no-subagent host no automatic independent pass runs at all — a manual handoff — so the guarantee is genuinely weaker there. Both are accepted as honest floors rather than faked strength.

**Rejected alternatives:** porting the artifact / `--require-plan-review` / `--record` / confirm machinery (no temporal gap to bridge — dead weight); a same-agent self-critique on Codex labeled as an adversary (false confidence, the exact author-bias the thesis exists to defeat); a test or "plan simulation" oracle (undecidable — a plan has nothing to run); a hard objection cap (hides grounded findings, a false negative); a plan score, rubric, or severity taxonomy beyond the single material / not-material line (heavier than the decision needs).
