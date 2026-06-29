# seeded-bugs fixture

The planted-bug repo behind the **review catch-rate** benchmark. One artifact,
two jobs: the input `codument benchmark init --seeded` lays down, and the answer
key `codument benchmark score` grades against.

## What it proves

Given a diff that carries known bugs, how many does the review step catch before
commit — and how does that compare to shipping the diff straight to commit
(loop vs no-loop)? Because the bugs are planted, the ground truth is free: no
self-reporting and no judge. See [proof-benchmarks](../../../docs/features/proof-benchmarks.md)
and [review-effectiveness-metric](../../../docs/concepts/review-effectiveness-metric.md).

## Layout

- `project/` — the committed baseline: a clean session + wallet service.
- `changes/` — the uncommitted feature branch ("add a transactions report") with
  the planted bugs. `init` lays `project/` down as a git commit, then overlays
  `changes/` as the working-tree diff under review.
- `bugs.json` — the authoritative answer key: each bug's id, file, tier, and the
  detector that proves it fixed. **Package-only — never copied into an
  initialized scenario, so an agent cannot read it.**
- `detectors/` — one `node:test` file per bug. Each imports the scored target's
  module via the `CODUMENT_TARGET` env var and passes iff the bug is fixed.
  **Package-only / hidden** for the same reason.
- `fixed/` — correct versions of the two new files, used only by the benchmark's
  own tests to simulate a fully-fixed solution. (Modified files are "fixed" by
  restoring them from `project/`.)

## Determinism

The detectors are deterministic given the final file state — no clock, no
network, no model. The scorer runs them in an isolated environment (ambient
`NODE_OPTIONS` cannot flip a verdict) and treats a non-completing detector as an
error rather than a miss, so the same target directory scores identically.
