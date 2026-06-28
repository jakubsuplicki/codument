---
title: Review Effectiveness Metric
status: draft
type: concept
owner: ""
sources: []
depends_on:
  - change-control-gate
  - proof-benchmarks
last_reviewed: 2026-06-16
---

## In plain terms

Codument's delivery loop puts a **review step between writing code and committing it** — something most agent setups skip (they go straight from work to commit). This concept counts what that review step catches and fixes before commit, tiered lightly, so the value of the extra step is visible ("the loop caught 6 real issues and 11 minor ones this week"). The believable proof comes not from the agent grading itself, but from a benchmark that plants known bugs and checks whether review catches them.

## How it works

### A third measurement axis (flow), kept separate from the two state axes

Codument now measures three different things. Keep them separate; never blend them into one number.

| Axis | Measures | Nature |
| --- | --- | --- |
| Coverage | is the code documented / fresh? | static state, deterministic |
| Lint | is the registry / docs messy? | static state, deterministic |
| **Review effectiveness** | what the review step caught and fixed | **flow / event, non-deterministic** |

Coverage and lint live in the registry-health work ([[registry-health]]). Review effectiveness is different in kind: review findings are model output, not a function of repo state, so this metric is a **record of what happened**, not a recomputable score. It lives in the events / history log and is **never folded into the deterministic coverage score**.

### The light per-repo scorecard

1. The agent already runs a review step (`review-work`) before committing. When it raises something, it writes a one-line structured note: *what it was, a light tier, and whether it was fixed before commit.*
2. Those notes append to the events / history log — one line per issue, no new machinery.
3. `codument` tallies the log into a simple stat ("caught and fixed N correctness, M minor"). Studio renders it accessibly later.

Integrity guardrails (this metric is gameable in the opposite direction from coverage — it tempts inflating findings):

- **Count fixes, not findings.** A fix is a verifiable change before commit; a finding raised and dismissed counts for nothing. The fix is the evidence.
- **Tier conservatively and keep nits out of the headline** (e.g. correctness / safety vs minor). Otherwise nits dominate and inflate the number.
- **Frame it honestly:** "the review step changed the code before commit N times, tiered" — not "prevented N production bugs," which we cannot prove on a real repo.

### The benchmark is where the strong claim lives

Per-repo numbers are the agent scoring its own work, so they stay modest. The trustworthy proof is a benchmark with **ground truth for free**: seed fixtures with known injected bugs, run the loop, and measure **catch rate** (did review find the planted bug?) and **false-positive rate** (how much noise). Because we planted the bugs, no self-reporting is involved. Comparing **loop vs no-loop catch rate** is the evidence the review gate adds value. This extends the existing benchmark command ([[proof-benchmarks]]).

## Decisions

- Three separate axes: coverage (state) / lint (state) / review effectiveness (flow). The flow metric never enters the deterministic coverage score.
- Count fixes (resolved findings with a real change), not raw findings; tier lightly; the headline excludes nits.
- Ship the **light, self-reported** version first (review notes appended to the events log). The **snapshot-delta** rigor (capturing pre-review state to make the fix delta git-observable) is deferred — its disadvantages outweigh the benefit: it adds machinery to the hottest path (an extra commit or stash every step, which fights clean-history conventions), it still leans on agent discipline to take the snapshot, its delta mixes review fixes with unrelated tidying so it does not actually escape self-reporting, and it is premature before the review-note shape is known.
- Credibility comes from the **planted-bug benchmark**, not per-repo self-reporting.

## Hooks into the roadmap

- **Events log:** review notes are an event type for the `.codument/events.jsonl` work referenced in the autopilot/watch sections of [[change-control-gate]]. This metric and the live watcher share that log.
- **Benchmark extension:** add a catch-rate / false-positive measurement over seeded-bug fixtures to [[proof-benchmarks]], and a loop-vs-no-loop comparison.
- **Sequencing:** rides alongside the `review` work, not before it — there is nothing to measure until the review loop produces structured output.

## Open questions

- The tier taxonomy (how many tiers, and which tiers count toward the headline).
- The events-log line format for a review note, and how `review-work` emits it deterministically enough to tally.
- When (if ever) the snapshot-delta rigor is worth adding.
