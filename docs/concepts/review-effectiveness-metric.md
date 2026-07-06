---
title: Review Effectiveness Metric
status: current
type: concept
last_reviewed: 2026-06-29
---

# Review Effectiveness Metric

## In plain terms

Codument's delivery loop puts a **review step between writing code and committing it** — something most agent setups skip (they go straight from work to commit). This concept is about making the value of that extra step visible, and it has two halves with very different credibility. The trustworthy half is **shipped**: a planted-bug benchmark that measures whether review catches known bugs before commit, loop versus no-loop, with the catch rate as ground truth (because we planted the bugs, no self-reporting is involved). The lighter half is **still planned**: a per-repo scorecard where the agent's own review step records what it caught and fixed. The believable proof comes from the benchmark, not the agent grading itself.

## Design approach

### Three measurement axes, kept separate

Codument measures three different things, and they must never blend into one number:

| Axis | Measures | Nature |
| --- | --- | --- |
| Coverage | is the code documented / fresh? | static state, deterministic |
| Lint | is the registry / docs messy? | static state, deterministic |
| Review effectiveness | what the review step caught and fixed | flow / event, non-deterministic |

Coverage and lint live in the registry-health work ([[registry-health]]). Review effectiveness is different in kind: review findings are model output, not a function of repo state, so it is a **record of what happened**, not a recomputable score, and it is **never folded into the deterministic coverage score**.

### The benchmark is where the strong claim lives (shipped)

The trustworthy proof has ground truth for free: seed a fixture with known bugs, run the loop, and measure the **catch rate** — did review find the planted bug? Comparing **loop vs no-loop** catch rate is the evidence the review gate adds value, with no self-reporting involved. This is realized as the catch-rate benchmark in [[proof-benchmarks]]: a fixed buggy diff, one hidden detector per bug, an answer key the agent can't read, and a loop-vs-no-loop delta. Its honest boundary is that the no-loop baseline is ~0% by construction, so the claim is "review catches X% that would otherwise ship," not a natural-catch-rate comparison.

### The light per-repo scorecard (planned, not built)

The lighter half counts what review changed before commit on a real repo, tiered lightly, so the value is visible week to week ("the review step changed the code before commit N times, tiered"). It rides the events log rather than new machinery: the review step writes a one-line structured note per issue (what it was, a light tier, whether it was fixed before commit), those notes append to the history log, and `codument` tallies them. This half is deliberately modest because it is the agent scoring its own work; it is sequenced *after* the review loop produces structured output, since there is nothing to measure until then.

## Invariants & boundaries

- The review-effectiveness (flow) axis never enters the deterministic coverage score; it is a record of events, not a recomputable state metric.
- Credibility for the strong claim comes from the planted-bug benchmark, not per-repo self-reporting: because the bugs are planted, the catch rate involves no self-grading. *(realized + tested in [[proof-benchmarks]]: `benchmark-seeded.test.ts`)*
- The per-repo scorecard counts **fixes** (a verifiable change before commit), not raw findings; a finding raised and dismissed counts for nothing, and the headline excludes nits. *(boundary — the scorecard half is not yet built)*
- The metric is framed honestly as "the review step changed the code before commit N times, tiered," never "prevented N production bugs," which cannot be proven on a real repo.

## Decisions

- The benchmark proof is deterministic and never a judge — the stance the catch-rate half is built on: [008-benchmark-proof-deterministic-not-judge](../architecture/decisions/008-benchmark-proof-deterministic-not-judge.md).
- Ship the strong, ground-truth benchmark half first; the light self-reported scorecard rides the events log later. The snapshot-delta rigor (capturing pre-review state to make the fix delta git-observable) is rejected for now: it adds machinery to the hottest path, still leans on agent discipline, and mixes review fixes with unrelated tidying, so it does not actually escape self-reporting.

## Key files

- The catch-rate benchmark that realizes the strong half lives in [[proof-benchmarks]] (`src/lib/benchmark-seeded.ts` and the `fixtures/benchmarks/seeded-bugs` scenario); this concept has no sources of its own.
