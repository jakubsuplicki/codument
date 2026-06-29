---
status: accepted
date: 2026-06-29
---

# 008 — benchmark proof is deterministic and package-native, never a judge

## Context

Codument needs to demonstrate that docs-backed delivery actually helps, in a way a skeptic can rerun. The tempting proofs are the untrustworthy ones: a private repo nobody else can run, a human or AI judge scoring quality, a hosted telemetry pipeline, or a raw token-savings claim that collapses on a tiny task. Each either cannot be reproduced or grades something Codument cannot measure objectively.

## Decision

Proof ships as a `benchmark` command family, separate from `scan`/`adopt`/the delivery loop, so measurement never tangles with normal work. It proves only what can be scored **deterministically**:

- **Context routing** — for a fixture task, compare a naive whole-project context against the registry-guided working set, reporting token reduction (a stable local heuristic) plus relevance coverage (required docs/sources found, irrelevant files included).
- **Final repo state** — ship a fixture task, let any agent attempt it, and score the resulting directory with rule-based checks (tests, typecheck, black-box behavior, registry coverage, docs updated, boundaries respected, locked files untouched).

The score is a transparent **evidence bundle** plus a numeric summary; the bundle is the proof, the number is for a README screenshot. It runs with no network, no model, and no hosted telemetry, and works from packed package contents, not only the source repo.

## Consequences

**Good:** anyone can rerun the proof from the published package and get the same numbers; the claim is bounded to what is objectively measurable.

**Bad / accepted:** the benchmark scores context selection and final state, not the agent's path between them, which stays nondeterministic — so it can never claim universal token savings or deterministic agent behavior, only fixture-local routing and final-state quality.

**Rejected alternatives:** an AI or human judge as the primary score (not reproducible); a hosted telemetry pipeline or persistent usage tracking on normal commands (network + privacy cost); a raw token-savings headline (false on small tasks); a wall-clock timing score (varies too much across agents, machines, and review habits).
