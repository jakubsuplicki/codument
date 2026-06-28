---
status: accepted
date: 2026-06-28
---

# 005 — Co-movement is info-only telemetry; the agent is the judge

## Context

Once the gate flags that an owned symbol moved while its doc did not, a tempting next step is to check whether the doc's prose about that symbol also moved, and gate on it. But "the prose moved in the same window" is a coincidence signal: it misfires on default exports (the symbol's name never appears in prose), on symbols named like common words, and on renames. The literature's strongest warning is that this over-fires on behaviour-preserving refactors and erodes trust until the check is disabled.

## Decision

The deterministic verdict that drift **exists** (an owned symbol's anchor moved and its owning doc did not) is the gate — zero heuristic. The further question, "does the doc still describe the symbol correctly?", is a judgment, and the right judge is the **agent already in the loop**, which can read the symbol and the doc. Symbol-scoped prose co-movement is computed and **logged as soak telemetry only**; it is never a verdict input. Its one load-bearing role is the pure-CI / no-agent context where no judge is present. A move to gate on it is permitted only after the soak shows an acceptable false-fire rate against a threshold written down first.

## Consequences

**Good:** the gate fires on a near-zero-false-positive structural fact and pushes the fuzzy semantic call to a capable judge; the soak self-collects the data a future flip would need.

**Bad / accepted:** in a pure-CI context with no agent, co-movement is the only resolution signal and carries its known fuzziness.

**Rejected alternatives:** gating on name-match co-movement before a soak and a judge (the coincidence signal that erodes trust).
