# change-control fixture

A small, self-contained repo used three ways from one artifact:

1. **Test fixture** — the golden input `codument doctor` and `codument review` are verified against (Steps 2–8).
2. **Benchmark fixture** — the planted-bug repo for the review catch-rate.
3. **Demo asset** — the controlled repo we run live on stage for a builder/OSS audience.

It is deterministic by construction: a fixed repo state produces a fixed set of findings (see `demo.json` for the semantic golden).

## Layout

- `project/` — the baseline committed state (v2 registry + docs + src).
- `changes/` — the "messy AI change", an overlay mirroring `project/` paths. Apply it over `project/` to create an uncommitted diff for `review`.
- `demo.json` — every planted scenario mapped to its expected finding, plus seeded bugs and the before/after + determinism comparisons.

## What it demonstrates

- **`doctor`** on `project/`: ownership/dependency/risk coverage + lint (missing source, generated leakage, unmapped file, empty `depends_on`, high-fanout, a bloated doc).
- **`review`** on the diff: stale docs, a high-risk touch, out-of-plan changes, unmapped changes, dependents to re-review, and a clean positive-control change.
- **Catch-rate**: a planted session-expiry security bug in `changes/src/auth/login.ts` that `review-work` should catch.
- **Determinism**: run twice → identical output.

## Demo on stage

The synthetic fixture is the controlled, repeatable part of the demo. Pair it with a **live Peelmeal cameo** as the "real-world rot" moment (real registry: hundreds of multi-mapped files, empty `depends_on`, thousand-line docs). Synthetic proves the mechanics deterministically; Peelmeal proves it on a real codebase.

## Status

Inputs and the expected-finding manifest are complete now. Exact output strings and precise ratios are filled in / asserted once `doctor` and `review` are implemented; the registry uses the draft v2 shape.
